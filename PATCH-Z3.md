# Z3 阶段补丁应用

基线：`Xueness-0.1.8-Z2-20261022.zip`，SHA-256：
`f6c65f6f97a38bcef40e5c612ff726fa6abc82cda643baed58529d9845409402`。

1. 停止服务/CLI，备份已有源码改动。
2. 将补丁内同名 `Xueness-0.1.8-complete-project` 目录覆盖合并。本阶段零删除，Web dist 沿用基线 166 个文件。
3. 执行 `npm --prefix ts ci`；使用构建版再执行 `npm --prefix ts run build`，不要沿用旧 `ts/dist`。源码包不包含依赖或后端构建目录。
4. 使用原状态目录启动。SQLite 辅助库默认关闭；需要时在启动前设置 `XUENESS_SESSION_SQLITE=1`。旧 JSON journal 无需迁移即可继续运行。

完整包应解压至新目录。用户状态、模型配置、媒体与工作区不在补丁中。旧 PATCH-Z2.md / PATCH-ROUND19.md 只适用于它们记录的历史基线。

当前 `events.runtime` 为新的本地运行事件接口，保留原 `/events`、`events.v1`、`events.resume` 协议。文件回退与对话回退分别提供预览和确认接口；要同时回退，请先应用文件预览，再回退对话，因为后者会移除目标消息。详情见 `docs/engine-z3.md`。可运行 `node ts/scripts/project-manifest.ts` 核验源码清单。
