# 网络工具

`network` 插件提供逐调用批准的 WebFetch 与 WebSearch。在「设置 → 网络搜索」选择一种搜索方式：配置 Brave 兼容搜索服务，或配置独立的 OpenAI-compatible SearchModel。两种方式的配置和凭据与主模型供应商分开，切换搜索方式不会修改主模型设置。

搜索服务需要兼容 Brave Web Search JSON 请求：后端使用 HTTPS GET，提交 `q` 和 `count`，并通过 `X-Subscription-Token` 请求头发送密钥；默认地址是 `https://api.search.brave.com/res/v1/web/search`。SearchModel 使用 OpenAI-compatible Chat Completions：填写完整 HTTPS 接口地址、model ID 和独立 API 密钥。模型输出必须是包含 `sources` 数组的 JSON；自由文本不会作为搜索结果展示。模型生成的来源会注明 `urlsVerified:false` 与 `networkAccess:"unverified"`。来源 URL 只检查 HTTPS 结构和非私网 IP 字面量，不执行 DNS 查询或打开页面；Xueness 无法确认模型是否真正访问互联网。

服务地址必须使用 HTTPS 和标准 443 端口，不能在 URL 中放用户名、密码、查询参数或片段。搜索模型目前只支持公开 HTTPS 服务，本机和私网模型地址会被阻止；同样不会通过 providers 插件改动主模型配置。填写密钥后会分别保存在本地状态目录的 network 子目录中；接口不会再次返回密钥。以后保存地址时把密钥留空即可保留现有密钥。删除本地服务密钥不会清除由管理员设置的 `XUENESS_SEARCH_KEY` 环境变量。环境配置也支持 `XUENESS_SEARCH_ENDPOINT`。

默认使用系统 DNS。读取设置不会发起外部请求；「检查搜索服务 DNS」会按需解析当前所选接口并检查地址，不连接服务。「发送一次测试搜索」会向当前搜索方式发出一条请求，服务商可能按自己的计划计费。对于 SearchModel，这只能证明接口返回了结构化响应，不能证明模型有联网能力。WebFetch 与 WebSearch 在 Agent 运行期间仍须逐调用批准。

### FakeIP 代理

如果代理使用 FakeIP，系统 DNS 可能把公网域名映射到 `198.18.0.0/15`。只有系统 DNS 的所有结果都在该 FakeIP 段、且你在设置中明确填写公开 DoH HTTPS DNS JSON 服务地址时，网络工具才会通过该服务解析目标域名。DoH 端点不能带凭据、查询参数或片段，必须返回 `application/dns-json`，并且连接超时最多 5 秒。

系统 DNS 返回的私网地址、私网和公网混合结果、FakeIP 和公网混合结果，以及其它非公网地址都会被阻止；DoH 应答也会执行相同的全记录公网检查。工具会固定连接到经检查的 IP，并仍按网址主机名验证 TLS 证书，不会跟随 HTTP 重定向。

### 常见错误

| 错误 | 处理方法 |
| --- | --- |
| `search_key_missing` | 在设置中保存服务密钥，或配置 `XUENESS_SEARCH_KEY`。 |
| `search_endpoint_invalid` | 填写公开 HTTPS 搜索地址；检查端口、查询参数及 URL 凭据。 |
| `fakeip_dns_blocked` | 检查代理 DNS 模式；只有确认使用 FakeIP 时才填写公开 DoH 地址。 |
| `ssrf_blocked` | 使用公开网站地址，检查域名是否解析到私网或混合地址。 |
| `http_temporary` | 服务返回限流、超时或临时错误，可稍后重试。 |
| `http_permanent` | 检查地址、服务请求格式或服务商权限；重定向不会自动跟随。 |

禁用 `network` 后，工作台不再读取网络设置或运行诊断，网络 HTTP 路由和工具也会被插件开关阻止。已有配置和凭据仍留在本地状态目录，重新启用后可继续使用。
