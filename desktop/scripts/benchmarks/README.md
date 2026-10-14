# 单文件 IFC 对照

这些入口用于手动、有界范围的研究复核，不加入默认单元测试，不代表全站或 Tauri 验收。只处理显式指定的 IFC；当前产品页固定钢结构样本 SHA 和连接板 ExpressId，其他输入应先修改该页的身份与目标。原始 IFC 不修改，输出写入仓库忽略的 `output/`。

在 `desktop/` 启动两个终端：

```powershell
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 14331
node scripts/benchmarks/ifc-lod-source-server.mjs '../demo/substation02/CBM/0302-钢结构.ifc'
```

打开 `http://127.0.0.1:14331/scripts/benchmarks/ifc-lod-product.html`。页面调用当前产品的 Fragments、Worker、AppState 和区域运行时；不是 Preview。源服务仅监听 loopback，允许此开发端口读取指定文件；结束后关闭服务。

检查首次远景、近景连接板、返回远景、缓存重新打开，并记录 `window.__steelLod` 的 sourceReads、cacheHit、farMs 与 regional.diagnostics。区域统计是当前运行时累计值；HIT 没有重新分类开洞，因此开洞分类计数为零不代表缓存几何没有省略孔。相机/视口变化会改变区域对象数，需记录相同视角后再比较。

近景分类、几何和属性请求完成后应释放源 Worker；返回远景应清空局部网格并恢复远景对象。验证期间禁止改源触发 HMR、并发构建或运行其他基准。首次源读取/OpenModel 与缓存恢复分别报告；本组不设置 300 秒超时。

`ifc-opening-visual.mjs` 导出原始和省略关系开洞的真实网格；`ifc-opening-view-server.mjs` / `ifc-opening-viewer.html` 负责同相机效果对照。`ifc-opening-cost.mjs` 是只测 web-ifc 的独立 Node 子进程探针，`ifc-opening-import.mjs` 只测 Node importer。它们的结果不能替代产品场景提交和选择验证。
