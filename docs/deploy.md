# Deploying Xueness

运行入口见 [README](../README.md#one-command-local-deploy)。后端需要 Python 3.10+，只使用标准库；仓库已包含 `webapp/dist`，运行预构建界面不需要 Node.js。

## 本机运行

`./install.sh` 默认在 `127.0.0.1:8137` 启动 Web，创建私有 `.xueness-data` 目录，不进行系统级安装。也可使用 `python3 -m xueness.web --port 8138`。端口已占用时打开已有服务或改用其它端口，不覆盖现有进程。

在设置中配置自己的真实模型。会话、模型配置、凭据、工作区和导出 journal 均属于本机私有数据，不上传到源码仓库。

## Docker Compose

`docker compose up --build -d` 从源码构建本地镜像。需要 Docker Engine、Compose v2、可访问基础镜像的网络和已构建的 Web 资产；没有发布可拉取的 Xueness 容器镜像。

主机端口固定映射为 `127.0.0.1:8137:8137`，状态及运行工作区保存在 `xueness-data` 卷。容器内的非 loopback 监听只为端口转发服务，不能据此将主机服务暴露到网络。

如果需要容器访问已有项目，将 `XUENESS_HOST_WORKSPACE` 设为所选目录；只挂载必要的项目范围，并根据容器用户权限处理写入。未设置时使用空的 `.host-workspace` 目录。

更新前备份持久状态，然后重新构建启动。`docker compose down` 保留数据；`docker compose down -v` 会删除持久卷，需明确决定后使用。

## 部署边界

- Web 为单人本地工具，没有多用户认证、TLS 或操作系统沙箱。默认保持 loopback 绑定。
- 非 loopback 绑定要求显式设置 `XUENESS_ALLOW_REMOTE=1`；公开暴露还必须另行设计认证与 TLS，该变量不提供认证。
- 模型请求仅在任务发送后开始；`XUENESS_ALLOW_REAL=0` 可在主机层关闭模型请求。凭据由运行主机提供。
- 所有会改状态的方法（POST、PUT、PATCH、DELETE）都要带 CSRF 令牌。GET 不带 CSRF。Host 必须是本机回环地址；带了 Origin 或 Referer 时，主机和端口必须与 Host 一致。浏览器送来的 `Sec-Fetch-Site` 只接受缺失、`none` 或 `same-origin`。重复的 Host、Origin、CSRF 或桌面令牌按拒绝处理。
- 请求体要带单一的 Content-Length。`Transfer-Encoding`（含分块）返回 411。超过上限返回 413 并关闭连接：普通接口 1000000 字节，仅路径 `/api/composer/prepare` 为 6000000 字节。请求行、请求头和请求体有空闲时间与总时限，超时返回 408；模型运行本身不占这套时限。
- 网关失败统一为 JSON：`{"error": "说明", "code": "稳定代号", "status": HTTP状态}`。`error` 仍是原有说明。失败不会以 200 或 HTML 返回。启用插件不替代执行批准，工作区范围检查仍然生效。

## 发布状态

GitHub 源码仓库为 `xuediner-source/xueness`，按私有仓库上传。没有创建版本标签、签名、发布镜像或云端服务。历史环境验证不代表已验证每台新机器；稳定分发应选择经验证的提交 SHA 或发行标签。

上传内容与后续操作见 [GitHub 仓库上传说明](github-publishing.md)。
