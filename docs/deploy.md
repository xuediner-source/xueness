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
- 所有 POST 使用 CSRF 防护，Host/Origin 检查及工作区范围仍生效；启用插件不替代执行批准。

## 发布状态

GitHub 源码仓库为 `xuediner-source/xueness`，按私有仓库上传。没有创建版本标签、签名、发布镜像或云端服务。历史环境验证不代表已验证每台新机器；稳定分发应选择经验证的提交 SHA 或发行标签。

上传内容与后续操作见 [GitHub 仓库上传说明](github-publishing.md)。
