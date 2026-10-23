# Z4 阶段补丁应用

基线：`Xueness-0.1.8-Z3-20261023.zip`，SHA-256：
`2e3e67ba3fd0c82b76d356cb51c71d3d520e3cfddcc99ca9190730d2362c76c5`。

1. 停止服务/CLI，备份已有源码改动。
2. 将补丁内同名 `Xueness-0.1.8-complete-project` 目录覆盖合并。本阶段零删除，Web dist 沿用 Z3。
3. 执行 `npm --prefix ts ci`；使用构建版时再运行 `npm --prefix ts run build`，不要沿用旧 `ts/dist`。源码包不包含依赖或后端构建目录。
4. 使用原状态目录启动。默认 shell 行为不变；需要 Bash 初始化时再设置 `/api/shell/settings`，说明见 [Z4 使用说明](docs/engine-z4.md)。

完整包应解压至新目录。用户状态、模型配置、媒体与工作区不在补丁中；历史补丁只适用于各自记录的基线。运行 `node ts/scripts/project-manifest.ts` 可核验源码清单。
