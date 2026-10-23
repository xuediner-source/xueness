# Z6 阶段补丁应用

基线：`Xueness-0.1.8-Z5-20261023.zip`，SHA-256：
`0d221c0c3c404e54cb3af84aaef30bcb480007329c30c4d210af49b2e0a895c9`。

1. 停止服务和 CLI，先备份已有源码改动。
2. 将补丁内同名 `Xueness-0.1.8-complete-project` 目录覆盖合并。本阶段零删除；保留现有状态目录和用户数据。
3. 运行 `npm --prefix ts ci`。使用构建版前先在合并后的目录运行 `npm --prefix ts run build`，不要沿用旧 `ts/dist`。
4. 在原宿主与 session 下查看 workflow script 草稿。compile/create 不执行脚本；运行需确认当前 digest。真实模型还需现有宿主开关及明确 allowReal。

完整工程应解压到新目录。此基线对应 Z5 包；不要将本补丁套用到其它基线。包的最终 ZIP 大小与 SHA-256 由实际归档结果记录，不在本说明中预填。
