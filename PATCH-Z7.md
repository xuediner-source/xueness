# Z7 补丁应用说明

完整包为 `Xueness-0.1.8-Z7-20261023.zip`；增量包为 `Xueness-0.1.8-Z7-20261023-patch.zip`。完整包包含 Z5、Z6 与 Z7 的阶段适配，增量包只包含相对 Z6 的新增、修改文件和更新后的项目清单，删除文件数为零。归档大小、SHA-256、文件数及逐项验证结果见同目录外部交接说明与 `SHA256SUMS.txt`。

## 基线

- Z6 完整包：`Xueness-0.1.8-Z6-20261023.zip`，SHA-256 `762e5663b65b0560880e1a4fcea0b57c448f08d1e71627c0d291491db58d50df`。
- Z6 项目清单：`complete-project-manifest.json`，SHA-256 `d220db98e25160e2bb416c179193d9ed822f2cb604ab08e0e2db53e544515ced`，记录 2207 个文件。

## 应用

两个归档都带有 `Xueness-0.1.8-complete-project/` 顶层目录。使用完整包时解压到新的父目录即可。应用增量包时，将它解压到已有 Z6 工程的父目录，覆盖同名顶层目录中的文件。例如工程为 `E:/work/Xueness-0.1.8-complete-project`，则解压目标为 `E:/work`。

Z7 没有新增 package 或第三方依赖，已有 Z6 依赖可继续使用。新目录需要先执行 `npm --prefix ts ci --ignore-scripts`。归档不包含 `node_modules/` 或 `ts/dist/`；若使用编译版启动，应用后执行 `npm --prefix ts run build` 更新后端产物。既有 166 个 `webapp/dist` 文件已保留并通过哈希一致性核对。

协议、无头 CLI 与适配边界见 [Z7 使用说明](docs/engine-z7.md)，验证结果见 [Z7 工作摘要](WORK-SUMMARY-20261023-Z7.md)。
