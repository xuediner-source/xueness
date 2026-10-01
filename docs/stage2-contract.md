# Xueness 第二段契约（Stage 2 contract）

目标：把设置页 13 个分区从「空壳桩」变成「真实数据 + 可操作」。
本文件是**唯一接口契约**，所有子模块与前端客户端都必须逐字对齐。

## 分层与边界

- 后端：Python **标准库 only**（不得引入任何第三方依赖），新增模块各自独立文件放 `xueness/`。
- 前端：新增客户端放 `webapp/src/`，不改 `vendor/zcode/` 的上游源码。
- 每个子模块**自带测试** `tests/test_<module>.py`，用 `unittest`。
- 冲突规避：子代理**只允许新建自己的文件**，绝不改 `xueness/web.py`、`webapp/src/main.tsx`、
  `xueness/core.py`（这些由主代理统一接线）。

## 后端模块协议

每个新模块必须导出：

```python
def dispatch(method: str, parts: list[str], query: dict, data: dict, ctx: dict):
    """method: "GET" | "POST" | "DELETE"
    parts : 去掉空段后的路径段，如 ["api", "settings", "general"]
    query : dict[str, list[str]]（urllib.parse.parse_qs 的结果）
    data  : 请求体 dict（GET/DELETE 为 {}）
    ctx   : web.py build_context() 的字典

    返回 (status:int, payload:dict) 表示本模块已处理；
    返回 None 表示不归本模块管，交给下一个模块。
    """
```

### ctx 可用键
- `state_dir`（**主代理负责新增**）：设置与资源的持久化根目录，默认 `./.state`
- `store`：`core.Store` 实例（会话仓库，只读使用）
- `web_runs` / `project_dir`：Path
- `lock`：`threading.Lock`
- 可以读取，**不得改写已有键的语义**。

### 硬性要求
1. **原子写盘**：一律 `tempfile.mkstemp` + `os.replace`（参考 `core.Store.save`）。
2. **路径 jail**：任何用户提供的标识符/路径，`resolve()` 后必须落在允许根内，否则 400。
   标识符必须正则白名单（如 `^[A-Za-z0-9._-]{1,64}$`），**拒绝** `..`、`/`、空串。
3. **不用第三方库**；JSON 用 `json`，路径用 `pathlib`。
4. **错误形状**统一 `(status, {"error": "<msg>"})`；成功 `(200, {...})`。
5. 不打印、不返回任何密钥内容。

## HTTP 契约

### 1. 设置（settings_store）
| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/settings` | — | `{"settings": {"<section>": {...}}}` |
| GET | `/api/settings/<section>` | — | `{"section": "<s>", "values": {...}}` |
| POST | `/api/settings/<section>` | `{"values": {...}}` | `{"section": "<s>", "values": {...}}` |

`<section>` 白名单：`general` | `appearance` | `shortcuts` | `browser`。
未知 section → 404。`values` 必须是 object，否则 400。
存储：`<state_dir>/settings.json`（单文件、原子写、未知键原样保留）。

### 2. 资源（resources）
`<kind>` 白名单：`skills` | `commands` | `hooks` | `mcp` | `subagents` | `plugins`。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/resources/<kind>` | — | `{"items": [...], "capability": {"userScopeAvailable": bool, "userScopeReason": str?}}` |
| POST | `/api/resources/<kind>` | `{"id": "<slug>", ...字段}` | `{"item": {...}}` |
| DELETE | `/api/resources/<kind>/<id>` | — | `{"ok": true, "id": "<id>"}` |

- 存储：`<state_dir>/resources/<kind>/<id>.json`（原子写）。
- `item` 至少含 `id`、`createdAt`（ISO8601 字符串）、`updatedAt`。
- `GET` 返回按 `id` 升序稳定排序；不存在的 kind → 404；非法 id → 400。
- 每项附 `capability.userScopeAvailable`（本机实现一律 `true`）。

### 3. 供应商（providers）
| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/providers` | — | `{"providers": [{"id","name","baseUrl","model","hasKey":bool}]}` |
| POST | `/api/providers` | `{"id","name","baseUrl","model","apiKey"?}` | `{"provider": {...}}` |
| DELETE | `/api/providers/<id>` | — | `{"ok": true, "id": "<id>"}` |

- **密钥绝不回显**：响应只给 `hasKey: bool`。
- apiKey 存 `<state_dir>/providers/<id>.json`，文件权限 `0o600`。
- `baseUrl` 必须 `http(s)://`，否则 400。

### 4. 用量（usage）
| 方法 | 路径 | 响应 |
|---|---|---|
| GET | `/api/usage?range=7d\|30d\|all` | `{"range": "<r>", "totals": {"sessions": n, "steps": n, "completed": n}, "series": [{"date": "YYYY-MM-DD", "sessions": n, "steps": n}], "updatedAt": "<ISO>"}` |

数据来源：`ctx["store"]` 的会话（`steps`、`status`、文件 mtime 作为时间）。
无数据时返回零值与空 `series`，**不报错**。

### 5. 记忆（memory_api）
| 方法 | 路径 | 响应 |
|---|---|---|
| GET | `/api/memory/tracks` | `{"tracks": [{"name": "memory\|user\|key", "path": str, "bytes": n, "present": bool}]}` |

只读复用 `xueness/memory.py` 的 `track_paths()`，**绝不写** memory root。
根目录来自 `XUENESS_MEMORY_ROOT` 环境变量；未设置时返回空 `tracks`（不报错）。

## 前端契约（webapp/src/xuenessApi.ts）

导出与上表一一对应的类型化函数，复用现有 `xuenessBridge.ts` 的 `get`/`post` 风格
（`credentials: "same-origin"` + CSRF 头）。函数名：

```ts
getSettings(): Promise<Record<string, Record<string, unknown>>>
getSettingsSection(section: string): Promise<{section: string; values: Record<string, unknown>}>
saveSettingsSection(section: string, values: Record<string, unknown>): Promise<{section: string; values: Record<string, unknown>}>
listResources(kind: string): Promise<{items: ResourceItem[]; capability: {userScopeAvailable: boolean; userScopeReason?: string}}>
createResource(kind: string, body: Record<string, unknown>): Promise<{item: ResourceItem}>
deleteResource(kind: string, id: string): Promise<{ok: boolean; id: string}>
listProviders(): Promise<{providers: ProviderSummary[]}>
saveProvider(body: Record<string, unknown>): Promise<{provider: ProviderSummary}>
deleteProvider(id: string): Promise<{ok: boolean; id: string}>
getUsage(range?: string): Promise<UsageSummary>
getMemoryTracks(): Promise<{tracks: MemoryTrack[]}>
```
且必须导出类型 `ResourceItem`、`ProviderSummary`、`UsageSummary`、`MemoryTrack`。

## 验收（每个子模块自证）

```sh
cd /Users/xuediner/.openclaw/workspace/xueness
python3 -m unittest tests.test_<module> -v
```

必须全绿，且**报告里贴出** `Ran N tests` / `OK` 原样输出。
测试必须覆盖：正常路径、非法输入 400、不存在 404、以及**原子写后能读回**。
