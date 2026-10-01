# Stage 2 独立审查（对抗性）— reviews/stage2-review.md

- 审查对象：Stage 2「设置页 13 分区接真实本地 JSON API」
  新增 `xueness/{settings_store,resources,providers_api,usage_api,memory_api}.py`、
  `webapp/src/{xuenessApi,xuenessServices}.ts`；
  修改 `xueness/web.py`（import + `_dispatch_stage2` + ctx `state_dir` + `do_GET/do_POST` 尾接入 + `do_DELETE`）、
  `webapp/src/main.tsx`、`webapp/vite.config.ts`。
- 审查角色：非作者、对抗心态。
- 只读约束遵守：本文件是唯一被写入的产物；未修改任何源码或测试。
- **本文件取代此路径上 21:30 的旧版本**（其内容已过时，见 §0 时间线）。

---

## 0. 时间线（重要：源码在审查期间被改动）

我于 21:20 左右首次读取源码，21:22 开工；随后 `xueness/resources.py`、`xueness/providers_api.py`
在 **21:31–21:34 被作者改动**（我读到的最初版本没有 symlink 守卫）。因此我把**最终冻结版本**
逐一记录哈希，并**对冻结版本重跑全部探测**。下面所有结论都注明是在哪个版本上得到的。

```
FROZEN REVISION (审查结论基线)
settings_store.py  58f5fd8ab3c317e7393bc8bfd4a88bad   20:59:55
resources.py       8e3d99aa6479a4efd77f171443e8c7be   21:34:03   ← 21:20 版无 symlink 守卫
providers_api.py   26afe623664f9d99776b67663ec3a223   21:33:51   ← 21:20 版无 symlink 守卫
usage_api.py       6dedfea72e68791af4986f76218b63b3   21:00:33
memory_api.py      6b0a64b09ed194431b0a5c75bddb37c0   20:59:52
web.py             7de98c2a3765d0449411f7fbff41cb20   21:02:48
xuenessApi.ts      44c1a55e838cd9442d4ad5257f771da2   20:59:51
xuenessServices.ts 2cfe4749ce212fdd6afdbea726faac75   21:21:15
```

> 影响：初版 `resources.py` / `providers_api.py` 存在 **symlink 绕过路径 jail** 的缺陷
> （kind 目录 / providers 目录指向 state_dir 外时 jail 失效）。该缺陷在我审查窗口内被作者加守卫修复，
> 冻结版本已实测拦住。**结论按冻结版本给出**，并把这个过程如实记录，避免读者被版本差误导。

后端测试（冻结版本）：

```
$ cd /Users/xuediner/.openclaw/workspace/xueness
$ python3 -m unittest discover -s tests
Ran 191 tests in 27.975s

OK
EXIT=0
```

探针姿势（后台 `&` 起服务会随 shell 会话结束即死，故起/探/kill 同一条命令）：

```sh
python3 -m xueness.web --port 8340 --state /tmp/rvi/state --web-runs /tmp/rvi/runs >/tmp/rvi/log 2>&1 &
S=$!
for i in $(seq 1 20); do curl -s --max-time 2 http://127.0.0.1:8340/api/health >/dev/null && break; sleep 0.5; done
C=$(curl -s http://127.0.0.1:8340/api/csrf | python3 -c 'import sys,json;print(json.load(sys.stdin)["csrfToken"])')
# ... 探测 ...
kill $S 2>/dev/null; wait $S 2>/dev/null
```

---

## 1. 路径穿越 —— 通过（无越权）

### 1.1 正常布局：哨兵读不到（通过）

在 state_dir 之外放哨兵 `/tmp/rv/outside_sentinel.txt`（内容 `SENTINEL_SECRET_12345`），
对 `/api/resources/<kind>/<id>`（GET/DELETE）与 `/api/providers/<id>`（GET/DELETE）试穿越串：

```
GET    /api/resources/skills/..%2f..%2foutside_sentinel.txt            -> 404 | {"error": "not found"}
GET    /api/resources/skills/%2e%2e%2f%2e%2e%2foutside_sentinel.txt    -> 404 | {"error": "not found"}
GET    /api/resources/skills/....//outside_sentinel.txt                -> 404 | {"error": "not found"}
GET    /api/resources/skills/..%5c..%5coutside_sentinel.txt            -> 404 | {"error": "not found"}
GET    /api/providers/%2e%2e%2foutside_sentinel.txt                    -> 404 | {"error": "not found"}
DELETE /api/resources/skills/..%2f..%2foutside_sentinel.txt            -> 400 | {"error": "invalid resource id"}
DELETE /api/providers/..%2f..%2foutside_sentinel.txt                   -> 400 | {"error": "id must match ^[A-Za-z0-9._-]{1,64}$"}
```

`--path-as-is`（不让 curl 折叠 `..`）也无效：

```
GET    /api/resources/skills/../../../secret_outside.txt   -> 404 | {"error": "not found"}
GET    /api/resources/skills/././secret_outside.txt        -> 404 | {"error": "not found"}
GET    /api/providers/../../../secret_outside.txt          -> 404 | {"error": "not found"}
DELETE /api/resources/skills/../../secret_outside.txt      -> 404 | {"error": "not found"}
```

哨兵完好：

```
$ cat /tmp/rv/outside_sentinel.txt
SENTINEL_SECRET_12345
```

边界 id：

```
GET    /api/resources/skills/         (空 id)      -> 200 | {"items": [], "capability": {...}}   # 退化为 list，无越权
GET    /api/resources//skills                     -> 200 | {"items": [], ...}
POST   resources id = "a"*5000                     -> 400 | {"error": "invalid resource id"}
POST   resources id = "技能"                        -> 400 | {"error": "invalid resource id"}
POST   resources id = ".."                         -> 400 | {"error": "invalid resource id"}
POST   providers id = ".."                         -> 400 | {"error": "id must match ..."}
POST   providers id = "."                          -> 400 | {"error": "id must match ..."}
```

### 1.2 强攻击面：symlink 逃逸 —— 冻结版本已拦住（该点曾是 HIGH）

比「穿越串」更强的是**符号链接**（state_dir 内被塞入 symlink 时）。我构造了三种：

```
# A: <state_dir>/providers 本身是指向外部目录的 symlink
$ ln -s /tmp/rvh/extP /tmp/rvh/sE/providers
GET  /api/providers            -> {"error": "providers directory must not be a symlink"}
POST /api/providers            -> 400 | {"error": "providers directory must not be a symlink"}
DELETE /api/providers/esc      -> 400 | {"error": "providers directory must not be a symlink"}
extP files: 0        # 外部目录未被写入

# B: <state_dir>/resources/mcp（kind 目录）是指向外部目录的 symlink
GET  /api/resources/mcp        -> {"error": "resource kind must not be a symlink"}
POST /api/resources/mcp        -> 400 | {"error": "invalid resource id"}
extRs files: 1       # 只有我预先放置的 secret.json，服务未新增任何文件

# C: <kind>/<id>.json 是指向外部文件的 symlink（读穿场景）
$ ln -s /tmp/rvh/extRs/secret.json <state>/resources/skills/leak.json
GET  /api/resources/skills     -> {"items": [], ...}     # leak.json 被跳过
     grep TOP_SECRET in response -> 0 次
```

**结论：冻结版本无越权读写。** 源码侧守卫（`_kind_dir`/`_providers_dir` 先 `is_symlink()` 再判包含性、
读取用 `O_NOFOLLOW`、`_list_items` 跳过 symlink）确实生效。
但请注意 §0：**21:20 的版本没有这些守卫**，我读到的最初源码在 symlink 场景下会失效——如果你在
更早的 commit 上验收，结论会相反。

### 1.3 `//` 路径与空 id 的 DELETE 形状（LOW，见 §7）

---

## 2. 密钥不回显 —— 通过

写一个特殊标记密钥，然后看所有响应与磁盘：

```
$ SEC='sk-LEAKMARKER-9999'
POST /api/providers {"id":"p",...,"apiKey":"$SEC"} -> 200 | {"provider":{"id":"p",...,"hasKey":true}}
POST 响应体含 LEAKMARKER? 0
GET  /api/providers 响应体含 LEAKMARKER? 0
```

遍历所有 GET 端点 grep 标记（全部无命中）：

```
ok /api/settings   ok /api/resources/{skills,commands,hooks,mcp,subagents,plugins}
ok /api/providers  ok /api/usage     ok /api/memory/tracks
ok /api/sessions   ok /api/health    ok /api/csrf
```

`GET /api/providers/<id>` 无此路由（契约未定义），返回 404：

```
GET /api/providers/p1 -> 404 body={"error": "not found"}
```

密钥确实落盘（证明上面的断言有意义），且权限正确：

```
apiKey len=24  sha256 match=True   # 与送入值逐字节一致
-rw------- /tmp/rv3/state/providers/p1.json     # 0o600
drwx------ /tmp/rv3/state/providers/            # 0o700
```

upsert 不带 apiKey 时保留旧密钥，不带 `apiKey` 字段名回显：

```
POST 更新（无 apiKey） -> {"provider":{...,"hasKey":true}}
GET -> {"providers":[{...,"hasKey":true}]}      # 无 apiKey 字段
```

**通过：明文 / 字段名两种形式均未泄露。**

---

## 3. CSRF —— 通过

```
POST   /api/resources/skills  无 token      -> 403 | {"error": "csrf token required"}
POST   /api/resources/skills  错误 token    -> 403 | {"error": "csrf token required"}
POST   /api/settings/general  无 token      -> 403 | {"error": "csrf token required"}
DELETE /api/resources/skills/d1  无 token   -> 403 | {"error": "csrf token required"}
DELETE /api/resources/skills/d1  错误 token -> 403 | {"error": "csrf token required"}
DELETE /api/providers/p1        无 token    -> 403 | {"error": "csrf token required"}
DELETE /api/resources/skills/d1  正确 token -> 200 | {"ok": true, "id": "d1"}
```

403 之后资源仍在（未发生副作用）：

```
GET /api/resources/skills -> {"items": [{"id": "d1", ...}], ...}
```

`do_DELETE` 确实过了 `_guard(need_csrf=True)`（源码 + 行为一致）。Host/Origin 守卫也有效：

```
Host: evil.com        -> 403 | {"error": "host not permitted"}
Origin: https://evil.com -> 403 | {"error": "host not permitted"}
```

---

## 4. 状态文件损坏 —— 通过（进程不死）

```
printf 'not json {{{' > <state>/settings.json
GET  /api/settings              -> 200 | {"settings": {}}
GET  /api/settings/general      -> 200 | {"section": "general", "values": {}}
POST /api/settings/general      -> 200 | {"section": "general", "values": {"theme": "dark"}}   # 损坏文件被合法覆盖重建
GET  /api/settings 之后         -> {"settings": {"general": {"theme": "dark"}}}

printf 'BROKEN' > <state>/resources/skills/bad.json
GET  /api/resources/skills      -> 200 | {"items": [<ok.json 被返回>], ...}   # bad.json 跳过
GET  /api/resources/skills/bad  -> 404 | {"error": "not found"}                # 无单条 GET 路由

printf 'oops' > <state>/providers/broken.json
GET  /api/providers             -> 200 | {"providers": []}

settings.json 为目录            -> GET 200 | {"settings": {}}   # 不崩
settings.json 顶层是数组 [1,2,3] -> GET 200 | {"settings": {}}
section 值非对象（"scalar"）     -> GET 200 | {"section": ..., "values": {}}
kind 目录下同名条目是目录        -> GET 200，DELETE diritem -> 404 | {"resource not found"}
进程存活                        -> GET /api/health 200
服务日志无 traceback
```

`_dispatch_stage2` 的 `except Exception` 确实兜住了（见 §7 的 settings 目录→500 一项）。

---

## 5. 并发写 —— 部分通过；发现 1 项 MEDIUM

三种模块的**原子性**都成立：无残留临时文件、无半写文件。

```
40 并发 POST 同一 resource id -> 目录仅 conc.json；.resource-*/.settings-*/.provider-* 残留 = 0
30 并发 POST settings         -> settings 残留 = 0；文件是合法 JSON
30 并发 POST 同一 provider    -> 目录仅 cp.json；残留 = 0；key 未丢
```

**但 `settings_store` 是唯一没有模块锁的写路径**，它的「读-改-写」跨进程线程不安全（见 §6 MEDIUM-1）。

---

## 6. findings

### MEDIUM-1｜`settings_store` 跨分区并发写会整段丢数据（读-改-写无锁）
- file: `xueness/settings_store.py::dispatch`（POST 分支）
- 与 `resources.py` / `providers_api.py` 对比：后两者有 `threading.Lock` 保护读-改-写，
  settings_store **没有**。POST `<section>` = `load_settings()` → 改本 section → `save_settings()` 整文件覆盖；
  两次并发写会互相用旧快照覆盖。
- evidence（冻结版本，30 轮，每轮 4 个 section 并发 POST）：

```
$ # 每轮: 并发 POST general/appearance/browser/shortcuts，各写 {"<s>":1}
rounds with <4/4 sections persisted: 30 / 30
$ # 顺序对照（对照组）：
sequential -> {"settings": {"general": {"general": 1}, "appearance": {"appearance": 1},
                            "browser": {"browser": 1}, "shortcuts": {"shortcuts": 1}}}
```

  同 section 并发则是「最后写入者胜」（预期行为）：`after 10 parallel -> {"section":"general","values":{"k8":8}}`。
- 影响：并发写不同分区时，某分区被静默抹掉。前端 `persistSettingsPatch` 目前是逐分区 `await`（顺序），
  单标签页不会自触发；但**多标签页 / 多客户端**同时保存即可稳定复现。属数据丢失，非崩溃，故 MEDIUM。
- 建议：给 settings_store 加模块级 `threading.Lock`（与 resources/providers 对齐），把
  `load → mutate → save` 包进临界区。

### LOW-2｜`settings.json` 被目录占用时 POST 返回 500 而非 400
- file: `xueness/web.py::_dispatch_stage2`（宽泛 `except Exception`）+ `xueness/settings_store.py::save_settings`
- evidence：

```
$ rm -rf <state>/settings.json && mkdir <state>/settings.json
GET  /api/settings              -> 200 | {"settings": {}}          # 读路径已优雅降级
POST /api/settings/general      -> 500 | {"error": "internal error"}   # os.replace 覆盖目录失败
GET  /api/health 之后           -> 200                              # 进程未死
```

- 影响：进程不崩（符合「不崩溃」要求），但契约要求非法输入 400；且 GET 已降级而 POST 报 500，形状不一致。
  仅在文件系统被畸形占用时出现。
- 建议：`save_settings` 捕获 `IsADirectoryError/OSError` → `(400, {"error": ...})`。

### LOW-3｜空 id 的 DELETE 与 `//api/...` 归一化
- file: `xueness/web.py::do_DELETE`（`path.split("/")` 语义）
- evidence：

```
DELETE /api/resources/skills/        -> 404 | {"error": "not found"}                  # 期望 400（非法 id）
DELETE //api/resources/skills/nope   -> 404 | {"error": "resource not found: nope"}   # 前导 // 被折成同路径
```

- 影响：仅错误码形状；`//` 在反向代理/CDN 下会被当主机相对路径，语义分歧。无越权证据。

### 前端提示（非独立 find，不计入 severity）
- `xuenessServices.ts::toSkillSummary` 为无实体文件的条目**伪造** `/root/.zcode/skills/<id>/SKILL.md` 路径，
  目的是通过上游 `filterSkillsForProvider`（其 `isZcodeSkill` 只放行 path 含 `/.zcode/skills/`、id 以 `glm:` 开头、
  或 scope 为 plugin 者——已核实于 `vendor/zcode/packages/ui/src/lib/skillSourceFilter.ts`）。
  纯展示层，但会让用户以为该文件真实存在。

---

## 7. 逐项对照任务清单

1. **路径穿越**：试过 `..`、`.`、`a/../b`、`%2e%2e`、`%2f`、反斜杠 `%5c`、`....//`、超长(5000)、空 id、
   `--path-as-is` 真穿越、POST body 内 id、以及更强的 **symlink 逃逸**。冻结版本全部无越权，哨兵完好。
   （§0：早期版本 symlink 可绕过，已被作者在窗口内修复。）
2. **密钥不回显**：POST/GET/全端点遍历 + 直接读磁盘核对哈希与权限。不含密钥。**通过**。
3. **CSRF**：DELETE/POST 无 token 与错 token 均 403；`do_DELETE` 过 `need_csrf=True`；Host/Origin 亦拦。**通过**。
4. **状态文件损坏**：非法 JSON / 顶层非对象 / section 非对象 / 目录占位 —— 均不崩进程，GET 优雅降级；
   唯一例外是「settings.json 为目录时 POST 500」（LOW-2）。**基本通过**。
5. **并发写**：三模块均无 `.tmp/.resource-/.settings-/.provider-` 残留、无半写文件；但 settings 跨分区写丢数据（MEDIUM-1）。
6. **后端测试真实性**：`Ran 191 tests ... OK`；逐行读了 5 个新测试文件，断言均为 `assertEqual/assertIn/assertNotIn/assertRaises`
   等真实断言，无 `assertTrue(True)`、无被注解掉的断言、无 `pass` 空测试。**通过**。
7. **前端契约一致性**：函数名 11 个、类型名 4 个**逐字一致**（`grep` 校验全 OK）；
   路径全部 `encodeURIComponent`；`ProviderSummary` **确无 `apiKey`**（只有 id/name/baseUrl/model/hasKey）。
   `vite build` 成功。**通过**。
8. **前端空壳兜底**：`toSkillSummary/toHook/toUserCommand/toAgentSummary/toMcpServer/toProviderSettingsView`
   都给出完整形状（上游要读的 `.scope/.event/.models/.effectiveConfig/.agents/...` 均在）；
   `toHook` 的 event 白名单**恰好等于**上游 `HookEvent` 的 7 值
   （SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse / PostToolUseFailure / Stop，
   已与 `vendor/zcode/packages/shared/src/hooks.ts` + `workspace-hook-config.ts` 逐字比对），未知值回退 `PreToolUse`。
   失败一律降级空结果、不抛错。**通过**。

### 附加攻击面（我实际试过，未发现新问题）
- 原型污染：`POST settings values={"__proto__":{...},"constructor":{...}}` → 原样 JSON 落盘，无 JS 侧影响（后端 stdlib，仅 JSON）。
- 方法越权：`POST /api/usage`、`PUT /api/settings/general`、`GET /api/providers/<id>` → 均 404（非本模块路由正确回落）。
- 非字符串 apiKey → 400；`javascript:`/`ftp://`/`file://`/`//host`/空 baseUrl → 400。
- `?range=BOGUS` / `?range=<script>` → 回落 `7d`，不报错。

---

## 8. 未能验证 / 明确未覆盖
- **未能锁定单一提交**：审查窗口内 `resources.py`/`providers_api.py` 被改动（§0），我以冻结哈希为基线；
  无法保证作者之后未再改。请在**冻结哈希**或更晚版本上复验。
- **未覆盖**：容器/compose 场景下 state_dir 是否落持久卷、卷是否多租户可写（未实测 `compose.yaml`/`Dockerfile`）。
- **未覆盖**：usage 分区的规模性能（用真实大量会话）；`core.Store` 只读约定在压力下的边界。
- **未覆盖**：浏览器端到端点击路径（只审了前端源码 + 构建 + 静态契约比对，未跑 Playwright E2E）。
- **未覆盖**：`settings_store` 跨分区并发的**真实多标签页**触发（我用并发 curl 等价复现了竞态，但未跑浏览器）。
- symlink 守卫缺少**回归测试**：`tests/test_{resources,providers_api,settings_store,usage_api,memory_api}.py`
  中 grep 不到任何 `symlink` 断言（`grep -rn "symlink" tests/test_{resources,providers_api}.py` → 无命中）。
  建议补 3 个用例（symbolic providers 目录 / kind 目录 / 条目文件）以防回归。

## 9. verdict

**可以接受（无阻塞问题）**：在**冻结版本**（`resources.py 8e3d99aa…`, `providers_api.py 26afe623…`）上，
路径穿越、symlink 逃逸、密钥不回显、CSRF、损坏状态降级、测试真实性、前端契约一致性 **全部通过**；
后端 `Ran 191 tests OK`、前端 `vite build` 成功。
唯一实质遗留是 **MEDIUM-1 `settings_store` 跨分区并发写丢数据**（建议加模块锁）与两项 LOW（settings 目录占位 500、
空 id/`//` 的 DELETE 形状）。
⚠️ **版本提醒**：本文件取代 21:30 版本；21:20 的源码在 symlink 场景下**确实会绕过 jail**，该缺陷在
21:31–21:34 被修复——若在更早提交上验收，结论应判为「有阻塞」。
