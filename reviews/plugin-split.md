# 功能插件拆分

日期：2026-09-26

## 为什么做

`web.py` 和 `cli.py` **各自手写了一遍**能力接线。MCP 那段两个文件几乎逐行相同：

```
web.py:672-700   连服务器 / 收集工具 / 构造 mcp_call / finally 回收
cli.py:147-171   同上（重复）
```

这不是风格问题。**同一段逻辑存在于两处，修一处就会漏另一处**——我在同一个仓库里已经
因为 `KNOWN_TOOLS` 有两份副本而吃过一次亏（一次改动只落在一处，`disallow_tools=mcp`
在 Web 端报"未知工具"）。MCP 接线是同一类隐患，而且后果更重：漏掉 `finally` 里的
回收 = **每次运行泄漏一个子进程**。

## 做了什么

新增 `xueness/plugins.py`：一个能力一个插件类，两个调用方共用一个 seam。

```python
class Plugin:                    # 接口
    kind = ""                    # <state>/resources/<kind>
    def load(state_dir, root, session) -> dict    # → run() 的 kwargs
    def teardown(self) -> None                    # 释放

PLUGINS = {"skills", "hooks", "subagents", "mcp"}
activate(names, state_dir, root, session) -> Activation
```

```python
# 调用方（web / cli 一致）
with activate(names, state_dir, root, session) as ext:
    run(..., **{k: ext.kwargs.get(k) for k in (...)})
```

### 三处刻意的设计

**1. 策略留在调用方。** `activate` 只加载被点名的插件，不做任何"默认开"。名单就是
deny-by-default 策略本身，写在调用点上看得见，而不是藏进加载器里。

**2. 坏插件降级，不抛异常。** 一个坏的资源文件不能把整次运行变成 500，但**也绝不能
因此静默放行**——`load()` 抛异常时该能力就是"未加载"，不是"已授权"。有测试同时锁定
这两面：失败的插件既不中断运行，也不拖垮同批的健康插件。

**3. `teardown` 是承重的。** MCP 插件持有活的子进程，`finally` 漏掉就是进程泄漏。
`Activation` 做上下文管理器，异常路径也回收；`teardown` 幂等。测试直接断言
"start 的客户端数量在 close 后归零"。

## 效果

| | 拆分前 | 拆分后 |
|---|---|---|
| 能力接线位置 | `web.py` + `cli.py` 各一份 | `plugins.py` 一份 |
| `web.py` 运行段行数 | ~70 行（含 2 个嵌套 def） | ~22 行 |
| `cli.py` 运行段行数 | ~45 行 | ~18 行 |
| 新增能力的改动面 | 改 2 处调用点 | 加 1 个类 + 1 条注册表项 |

## 验证

- **单元**：`tests/test_plugins.py` 15 项 —— 注册表完整性、空名单不加载、未知名安全跳过、
  重复名只加载一次、失败降级、失败不拖垮同批、异常路径回收、`teardown` 幂等、
  MCP 客户端真的被回收。
- **回归**：全量 **501 tests OK**（拆分前 486，+15）。
- **生产**（容器内实测，8 项全 PASS）：空名单不加载 / hooks 加载 / 未知名安全跳过 /
  无 MCP 配置不注入 / 空 skills 为 None / 注册表含 4 能力 / teardown 幂等 / 异常路径回收。
- **安全不变量复核**：搭一个真正提供服务的 fake MCP server，工具被发现 → 调用
  **仍被拒** → 进审批队列。重构没有削弱 MCP 门禁。

## 一个过程中的自我纠错

第一次生产验证报 FAIL，我差点记成"重构破坏了门禁"。查下来是**我的测试写错了**：
用 `python3 -c pass` 当 MCP server，它不响应握手，所以工具从未被发现，调用走的是普通
未知工具路径（`ValueError`），跟门禁无关。换成真正应答 JSON-RPC 的 fake server 后
结果正确。

记这条是因为它是个通用陷阱：**验证失败时先怀疑验证方法，再怀疑被测对象。** 如果当时
直接照着 FAIL 去"修"门禁，会把一个本来正确的实现改坏。

## 未做 / 边界

- **`web.py` 和 `cli.py` 仍在调用点各写一遍"哪些能力开"的旗标列表**。这是有意的：
  那是安全策略，应该看得见。插件层只负责"被点名后如何加载和回收"。
- **UI 层的插件概念（`resources.py` 的 `"plugins"` kind）与这里的后端插件无关**，
  名字撞车但含义不同：前者是资源目录分类，后者是 run 的可选能力。没有合并，
  合并会把两个正交的概念绑死。
- **`run()` 的签名没有改**。它仍接受 `hooks=` / `mcp_tools=` 等参数，插件是**构造侧**
  的抽象，不是运行时的。这样 501 个测试里的直接调用不用改，改动面最小。
