# Xueness 插件 SDK 与隔离（第四批冻结契约）

日期：2026-09-28。本文件冻结**第四批**：可控插件 SDK 与隔离。

## 0. 铁律（不得违反）

1. **配置资源不能被当作可执行插件。** `<state>/resources/plugins/*.json` 里出现
   `entrypoint` / `command` 之类的外部代码入口时，loader **必须拒绝**，不得加载、
   不得执行、不得放进 `activate()` 名单。外部插件代码执行需要单独审计，本批不提供。
2. **默认关闭。** 插件未显式 `enabled: true` 一律不加载。缺失 `enabled` 视为关闭
   （与 skills/hooks 的「缺失即启用」相反——插件是更强的授权，必须显式）。
3. **拒绝默认网络/命令权限。** 清单声明的每项 `capabilities` 都必须由调用方显式授予；
   没授予就拒绝，并说明缺哪一项。
4. **离线、stdlib only。** 校验是纯函数；不发起网络请求；不引入依赖。
5. **失败不升级为 500。** 坏清单只损失它自己，不中断运行。

## 1. 模块：`xueness/plugin_sdk.py`

### 常量

```python
API_VERSION = 1
#: 需要显式授予的能力。语义是「这项能力会让插件接触进程/网络/磁盘写」。
CAPABILITIES = ("command", "network", "filesystem-write")
```

### 清单形状

```json
{
  "id": "mcp-ops",
  "version": "1.0.0",
  "apiVersion": 1,
  "enabled": true,
  "builtin": "mcp",
  "capabilities": ["command"]
}
```

| 字段 | 必填 | 规则 |
|---|---|---|
| `id` | 是 | 与 `resources.ID_PATTERN` 同规则；非空、非 `.`/`..`、无路径分隔符 |
| `version` | 是 | `MAJOR.MINOR.PATCH` 数字点分（如 `1.0.0`） |
| `apiVersion` | 是 | 整数，必须等于 `API_VERSION` |
| `enabled` | 否 | 只有字面 `true` 才算启用；缺失/其它类型 = 关闭 |
| `builtin` | 见下 | 若提供，必须是内置能力名（`skills`/`hooks`/`subagents`/`mcp`）之一 |
| `capabilities` | 否 | 字符串数组，元素必须属于 `CAPABILITIES`；重复项去重 |
| `entrypoint` / `command` | — | **只要出现就拒绝**（外部代码，需另行审计） |

`builtin` 与 `entrypoint` 至少有一个能解释这个清单；只有 `entrypoint` 的清单必然被拒。

### 校验

```python
def validate_manifest(item) -> tuple[dict | None, list[str]]
```

返回 `(manifest, errors)`。`manifest` 为 None 表示不可用；`errors` 是给人看的拒绝原因
（稳定、可断言）。校验不得抛异常。

### 发现

```python
def load_manifests(state_dir) -> list[dict]
```

读 `<state>/resources/plugins/*.json`，按 id 升序，跳过符号链接目录/条目、坏 JSON、
非对象文档、非法 id。**只返回通过 `validate_manifest` 的清单。**

### 授权门

```python
def plan(state_dir, requested, grants=()) -> Plan
```

`requested` 是调用方**显式**要启用的名字（deny-by-default 的可见表达）。
`grants` 是调用方显式授予的能力集合。

`Plan` 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `load` | `list[str]` | 实际传给 `activate()` 的名字，顺序与 `requested` 一致 |
| `refused` | `list[dict]` | `{"name": str, "reason": str}`，逐个说明 |
| `manifests` | `dict[str, dict]` | 生效的清单，按名字索引（无清单的内置名不在内） |

规则（顺序敏感，先命中先拒）：

1. `requested` 里重复的名字只处理一次，顺序保持首次出现。
2. 名字不是已知内置能力（`plugins.PLUGINS`）**且**没有任何 manifest 认领它 → 拒绝，
   reason `unknown capability`。
3. 有 manifest（`id == name` 或 `builtin == name`）时：
   - `enabled` 不为 `true` → 拒绝 `disabled`。
   - `apiVersion != API_VERSION` → 拒绝 `incompatible apiVersion`。
   - 有 `entrypoint`/`command`（外部代码）→ 拒绝 `external plugin code requires a separate audit`。
   - `capabilities` 有任一项不在 `grants` → 拒绝 `missing grant: <cap>`（缺多项时按
     `CAPABILITIES` 顺序报第一项）。
   全部通过 → 放进 `load`，并记入 `manifests`。
4. 名字是内置能力且无 manifest → 放行（内置能力是仓库内已有代码，调用方的显式名单
   即是授权；manifest 只用于**追加**约束）。

同名的多个 manifest（例如两个都 `builtin: mcp`）：按 id 升序取第一个，其余记入
`refused`，reason `conflicting manifest: <id>`。

### 安装 / 卸载回滚

```python
def install_all(state_dir, items) -> dict   # {"ok": bool, "written": [id], "errors": [...]}
def uninstall(state_dir, plugin_id) -> dict # {"ok": bool, "removed": bool, "manifest": dict|None}
```

- `install_all` **先全量校验**再落盘：任何一条不合法 → 一个字节都不写。
- 落盘用原子写（复用 `resources._atomic_write_json`）；中途写失败 → **回滚**已写入的
  条目（删除新建的、恢复原有内容的原样），返回 `ok: false`。
- `uninstall` 删除清单文件；不存在返回 `removed: false`；删不了返回 `ok: false` 与原因。
  被删清单原样返回，供调用方回滚。

## 2. 接线（两个调用点共用同一条门）

`web.py`（`POST /api/sessions/<id>/run`）与 `cli.py` 在调用 `activate()` 之前，
用 `plugin_sdk.plan()` 过滤 `names`。授权集合来自请求/参数，默认空。

**注意**：这不改变「`activate` 的 names 就是显式 opt-in」这一既有语义——门只是再加一层
按清单的约束，且拒绝原因要能在响应/日志里看到，不能静默吞掉。

## 3. 验收

- `validate_manifest`：每个字段的合法/非法值；`entrypoint` 必拒；`apiVersion` 不匹配。
- `load_manifests`：符号链接目录/条目、坏 JSON、非对象、非法 id 全部跳过。
- `plan`：五条规则逐条覆盖 + 顺序敏感性 + 重复名去重 + 冲突清单。
- `install_all` / `uninstall`：全量校验不改盘、原子写、中途失败回滚、卸载可回滚。
- 后端：既有 `tests/test_plugins.py` 与 `tests/test_resources.py` **零回归**。
- 前端：不受本批影响，既有 85 项须仍全绿。
- 不改部署；不执行任何外部插件代码。
