# Z5 阶段补丁应用

基线：`Xueness-0.1.8-Z4-20261023.zip`，SHA-256：
`da66d5f8bcdf240f1ca165691049d24e6f347eb7d5da68f8d74da883f80aceed`。

1. 停止服务/CLI，备份已有源码改动。
2. 将补丁内同名 `Xueness-0.1.8-complete-project` 目录覆盖合并。本阶段零删除，Web dist 沿用 Z4。
3. 执行 `npm --prefix ts ci`；使用构建版时再运行 `npm --prefix ts run build`，不要沿用旧 `ts/dist`。源码包不含依赖或后端构建目录。
4. 使用原状态目录启动。新项目运行配置默认 pending；审阅 GET 候选值并确认精确摘要后才生效，hooks 仍需独立信任，见 [Z5 使用说明](docs/engine-z5.md)。

完整包应解压至新目录。用户状态、模型配置、媒体与工作区不在补丁中；历史补丁只适用于各自记录的基线。运行 `node ts/scripts/project-manifest.ts` 可核验源码清单。
