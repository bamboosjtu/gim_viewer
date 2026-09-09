# Substation Runtime desktop acceptance runbook

本手册是 Phase 6 的本地 Windows acceptance gate。它不改变加载策略，也不
把真实 demo 样本纳入仓库或 CI。CI 只负责前端与 Tauri Rust 编译边界；真实
样本结果应作为本地 benchmark JSON 保存到仓库外的验收目录。

## Compile gate

在仓库根目录执行：

```powershell
cd desktop
npm ci
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml --locked
```

GitHub Actions 的 Windows job 执行同一组命令。`npm run test:sample` 仍是
本地 corpus gate；样本缺失时的自动 skip 不代表 CI 已验证真实工程。

在 GitHub Actions 中手动运行 `Desktop compile gate` 的 `workflow_dispatch`。
手动运行会在上述 compile gate 通过后复用 `npm run tauri:build` 生成并上传
`gim-viewer-windows-portable-benchmark-<commit>` artifact。artifact 包含 portable
ZIP、SHA-256 文件和 `benchmark-build-manifest.json`；manifest 必须同时声明当前
commit、`buildMode=benchmark` 和 `webview2.mode=fixedRuntime`。普通 push/PR 不上传
该大体积 artifact。真实 GIM 样本仍只从本地磁盘提供，不进入 GitHub。

## Desktop benchmark

优先下载并完整解压 Windows portable benchmark artifact，先核对其中的
`benchmark-build-manifest.json`、ZIP checksum 和 portable ZIP 内的
`portable-manifest.json` commit 相同，再直接运行 `GIM-Reader.exe`。artifact 是
release 构建，打开样本使用正常的 GIM 文件选择器；它不携带仓库中的真实样本。

若本机有 Rust 并需要重复脚本化选取路径，也可以使用 debug Tauri 构建运行
`npm run tauri:dev`。仅 debug 构建接受下面的固定路径注入；portable release
应使用文件选择器，不能把该 debug hook 当成产品能力。在可用的 WebView
DevTools 控制台设置脱敏元数据：

```js
globalThis.__GIM_BENCHMARK_SAMPLE_ID__ = 'substation02';
globalThis.__GIM_BENCHMARK_COLD_WARM__ = 'cold';
globalThis.__GIM_COMMIT__ = '<artifact manifest commit>'; // 也可使用完整 SHA
globalThis.__GIM_DEV_PERF_FILE_PATH__ = 'D:/path/outside/repository/sample.gim';
```

`__GIM_DEV_PERF_FILE_PATH__` 只在 debug 构建接受，并仍经过原生授权、SHA 和
正常 GIM 打开流程。首次运行后，将 `coldWarm` 改为 `warm`，再次打开同一
文件。等待 `fullModelReady`，再等待短稳定窗口，按 `Ctrl+Shift+B` 导出
machine-readable JSON。该快捷键复制 `perfBenchmarkSnapshot()`，同时在
debug 构建写入 `globalThis.__GIM_LAST_BENCHMARK__`。

每次运行至少保存：

- `productMoments`：core/interactive/all-IFC/full readiness；
- `longTasks`、`memorySamples`、`runtimeResourceSnapshots`；
- IFC、Fragments cache、DEV geometry 的聚合 profile；
- `cleanupProfile` 中的 `beforeCleanup`、`afterCleanup`、
  `settledAfterCleanup`。

## Cleanup / retention sequence

优先以两个不同规模的真实变电样本执行：

```text
A → fullModelReady → clear
B → fullModelReady → clear
A → fullModelReady → clear
```

每次清理后等待 `settledAfterCleanup` 再导出。检查逻辑资源计数是否归零，
并将多轮稳定后的 RSS 与 JS heap 分开比较。不要使用强制 GC 作为正式通过
条件；如果运行环境额外支持 GC，只能作为 research 字段单独记录。

## Reading the result

- `processTreeRssBytes = null` 必须结合 `processTreeAvailable` 和 reason 读取，
  不能用 Tauri 后端 RSS 代替 WebView2 进程树。
- renderer.info 不可用时保留 null；不能从 scene 数量推算 GPU bytes。
- `templateCount`、`sharedPlacementCount`、Fragments model count、loaded
  group count 是逻辑所有权证据；RSS 延迟下降本身不是 leak 证据。
- 逻辑资源清零且 RSS 形成稳定 plateau，优先研究 working-set reduction；
  逻辑资源跨工程残留，才进入 ownership/cleanup 修复。

本机没有 cargo 或可运行的 Tauri binary 时，结果应明确标记为
`Desktop runtime acceptance: PENDING REAL WINDOWS RUN`，不得宣称 cold/warm、
RSS 或 Long Task 已改善。
