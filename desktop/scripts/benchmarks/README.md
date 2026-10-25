# 原生验收与单文件 IFC 对照

## 独立原生 Release 验收

在 `desktop/` 执行 `npm run acceptance:build`，再将生成的清单路径传给 `npm run acceptance:stage -- <acceptance-build.json>`，得到已核验的临时目录副本。`node scripts/benchmarks/acceptance-probe.mjs <暂存后的 acceptance-build.json>` 只检查原生启动、实际独立缓存路径和所属进程清理，不打开工程，也不代表工程性能验收通过。

验收使用独立应用标识，并校验当前源码、EXE 和完整固定运行时；日常应用缓存保持原位。目录相关启动失败的具体原因尚未确认，不修改 ACL 或关闭安全机制来替代验收。冷暖矩阵、真实文件对话框、固定路线及结果判定以[性能测试指南](../../../docs/meassurement.md)为准，当前证据见[性能基线](../../../docs/performance.md)。工具自测入口为 `npm run test:acceptance-tools`。

## DEV 缓存解包对照

准备四站解包样本后，在 `desktop/` 执行 `npx vitest run --config scripts/benchmarks/dev-cache-decode.config.ts`，生成真实 L0 模板，并核对旧/新解包的字节、状态、几何、材质与独立缓冲区。缺少任一样本会失败，不跳过。产物写入忽略目录 `output/parse-reuse/`。

保持 `npm run dev -- --host 127.0.0.1` 运行，再执行 `node scripts/benchmarks/dev-cache-decode-browser.mjs`，在独立 headless Edge/profile 中对固定产物执行 100 对交替解包；可用第一个参数指定 Edge 可执行文件。服务只监听 loopback，结束后关闭所属浏览器，不操作日常缓存。两套入口只测缓存解包 CPU，不代表 IPC、绘制、完整冷暖或内存峰值验收。判定与边界见 [四站对照](../../../docs/impl/test-dev-cache-decode-copy.md)。

## 单文件 IFC 对照

这些入口用于手动、有界范围的研究复核，不加入默认单元测试，不代表全站或 Tauri 验收。只处理显式指定的 IFC；当前产品页固定钢结构样本 SHA 和连接板 ExpressId，其他输入应先修改该页的身份与目标。原始 IFC 不修改，输出写入仓库忽略的 `output/`。

在 `desktop/` 启动两个终端：

```powershell
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 14331
node scripts/benchmarks/ifc-lod-source-server.mjs '../demo/substation02/CBM/0302-钢结构.ifc'
```

打开 `http://127.0.0.1:14331/scripts/benchmarks/ifc-lod-product.html`。页面调用当前产品的 Fragments、Worker、AppState 和区域运行时；不是 Preview。源服务仅监听 loopback，允许此开发端口读取指定文件；结束后关闭服务。

检查首次远景、近景连接板、返回远景、缓存重新打开，并记录 `window.__steelLod` 的 sourceReads、cacheHit、farMs 与 regional.diagnostics。区域统计是当前运行时累计值；HIT 没有重新分类开洞，因此开洞分类计数为零不代表缓存几何没有省略孔。相机/视口变化会改变区域对象数，需记录相同视角后再比较。

近景分类、几何和属性请求复用单一源 Worker，切源、关闭或空闲 30 秒后释放；返回远景应清空局部网格并恢复远景对象。验证期间禁止改源触发 HMR、并发构建或运行其他基准。首次源读取/OpenModel 与缓存恢复分别报告；本组不设置 300 秒超时。

`ifc-opening-visual.mjs` 导出原始和省略关系开洞的真实网格；`ifc-opening-view-server.mjs` / `ifc-opening-viewer.html` 负责同相机效果对照。`ifc-opening-cost.mjs` 是只测 web-ifc 的独立 Node 子进程探针，`ifc-opening-import.mjs` 只测 Node importer。它们的结果不能替代产品场景提交和选择验证。

## 近景缓存容量验收

在隔离 Playwright 浏览器和独立 loopback 端口打开 `scripts/benchmarks/ifc-near-cache-check.html`。页面会重建该隔离 origin 的测试数据库，验证旧远景保留、旧近景迁移、字节及条目上限、访问淘汰顺序、超大条目和删除容量账；不在日常开发浏览器的既有缓存中运行。它调用实际 IndexedDB 桥接实现，不进入默认单元测试。

源服务可用第三个参数指定 Vite loopback origin，例如 `node scripts/benchmarks/ifc-lod-source-server.mjs '../demo/substation02/CBM/0302-钢结构.ifc' http://127.0.0.1:14339`。只接受 `http://127.0.0.1`，默认 origin 仍为端口 14331。区域诊断中的 sourceReads/sourceChecks 与 sourceOpenCount 分开记录；30 秒空闲后的重读和策略变化导致的重开不得混为一类。

开洞关系范围表在源 Worker 的首次小孔修改时建立，后续批次仅修改新关系范围。若比较关系修改成本，必须使用相同源与累计移除集合，逐批核对修改后的全部字节；首次建表、后续修改和 OpenModel 分别计时。

## 区域依赖子集与登记核心

`node scripts/benchmarks/ifc-regional-mutation-check.mjs '../demo/substation02/CBM/0302-钢结构.ifc' '../output/steel-subset-check.json' subset` 只验证指定钢结构的板件、紧固件和保留开洞对象，对照顶点、索引、颜色及矩阵。省略最后的模式参数时默认使用 subset。mutation 和 catalog 是失败候选的诊断复现入口，分别检查 DeleteLine/ResetCache 和全源开洞预分类，不代表生产路径。生产源文件不改写，输出写入忽略目录，脚本不会覆盖研究报告。

在 `desktop/src-tauri/` 设置绝对路径环境变量 `GIM_PROJECT_CHECK_SOURCE` 与独立目录 `GIM_PROJECT_CHECK_DIR` 后，可运行 `cargo test --lib project_registration_native_profile -- --ignored --nocapture`。首次运行只向该目录的专用数据库登记来源，第二次为新的原生进程命中，并让另一个连接保留 WAL 写锁以核对只读登记；输出 JSON 明确标记不包含 WebView、IPC、语义恢复和几何。不能将此命令的成功作为完整桌面暖启动验收。
