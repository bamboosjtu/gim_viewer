# 开发者本地 GIM 验收

仓库提交测试逻辑与 [mini-samples.example.json](mini-samples.example.json) 注册表，不提交 GIM、解压内容、黄金结果或个人路径。默认引用开发样本别名中的一变、一线；设备路径是待填写示例。

其他开发者直接修改该文件中的本地路径和完整 SHA256。三个来源应不同。L0/L1/L2 属于独立的性能样本登记，不用于基础功能测试。

在 `desktop/` 执行：

```powershell
# 按需编辑 local-tests/mini-samples.example.json。
npm run local-tests:check
npm run bench -- build
npm run test:local -- --build ../tmp/gim-bench/builds/<本次构建>/acceptance-build.json
```

`mini-samples.example.json` 随仓库跟踪；`path` 相对该 JSON，必须解析到工作区内，链接与系统目录被拒绝。`local-tests:check` 在不启动应用的情况下核对路径与 SHA：缺失或尚未配置的来源标为 SKIPPED，已存在但 SHA 不符则失败。`test:local` 使用显式原生构建，在新进程中依次打开可用来源，并校验实际产品分支为 `substation`、`transmission_line`、`equipment`；还执行 Benchmark 的来源、几何、缓存及测量完整性检查。缺样本不会阻断其余来源，报告显示 INCONCLUSIVE 与 SKIPPED，跳过项不计通过；已执行来源失败则退出非零。报告写入 `output/local-tests/`，私有授权与运行日志留在 `tmp/gim-bench/`。

项目的普通 CI 只验证注册表协议、纯逻辑、SQLite 与构建，不运行本地 GIM。旧九工程的固定路径、payload offset 与缺失黄金文件入口已退役。复杂工程的额外回归由开发者在私有注册表追加来源，并显式保存人工审阅后的期望结果，不从当前软件输出自动生成真值。

本地真实工程验收统一使用 `test:local` 或 Benchmark 注册表；普通 CI 不运行工程样本，缺样本的 skip 不计通过。

连接几何的引擎级复核使用 `npm run test:ifc-connections-local`。该命令在 `tmp/local-tests/ifc-connections-*/` 生成匿名 IFC4 连接构件，调用安装的真实 Node web-ifc/WASM，以完整数组扫描对照生产分块读取，检查六分量、三角形顺序、矩阵、颜色、包围盒、重复/非顺序索引、空对象和归一化；在消费等待中用原生向量分配实际扩大 WASM 堆，确认已拥有的块及后续指针读取仍有效。报告记录源、WASM 和读取器 SHA；失败退出非零。它不运行性能矩阵，不进入远程 CI，也不证明固定 WebView2、真实工程冷暖或跨机器兼容。完整实机门禁见[验证](../../docs/validation.md#ifc-连接几何本地门禁)。

固定 WebView2 复核使用 `npm run test:ifc-connections-local -- --build ../tmp/gim-bench/builds/<构建>/acceptance-build.json`，要求当前源码匹配的隔离 Benchmark Release。控制器在自己拥有的原生进程中执行同一验证案例与生产读取器，记录浏览器版本、WASM/读取器/案例 SHA、构建及运行时指纹和失败对象；断言失败或进程清理失败退出非零。报告的 `nativeWebView2Verified` 仅此分支可为 true。默认 Node 分支继续为 false；两者都不代替真实工程连接语义和跨机器验收。
