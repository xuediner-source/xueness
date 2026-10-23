# 第 19 轮补丁应用说明

基线：`Xueness-0.1.8-round18-20261022.zip`，SHA-256：
`561fd450976c6f99b8002ced032abebcb079c909f0a6522db7196ab7a768bbf7`。

1. 停止旧服务/CLI，保留已有源码改动的备份。
2. 移除旧工程的 **`webapp/dist` 构建目录**。本补丁携带该目录的全部 166 个新文件，直接覆盖合并会残留旧哈希资源。
3. 将补丁中的 `Xueness-0.1.8-complete-project` 与旧工程同名目录合并，覆盖同名文件。
4. 后端构建输出 `ts/dist` 不在源码包中。运行 `npm --prefix ts ci` 和 `npm --prefix ts run build`，再启动构建版；源码运行同样需要安装 TS workspace 依赖。Web dist 已附带，不必重新构建前端。

`webapp/dist` 以外没有删除文件。补丁不携带或迁移用户状态、模型配置或工作区。完整包建议解压到新目录，不使用上述旧目录合并方式。

可运行 `node ts/scripts/project-manifest.ts` 检查交付文件；它不核验用户状态，也不要求把既有状态删除。完整 ZIP 与补丁叠加后文件清单均已校验。
