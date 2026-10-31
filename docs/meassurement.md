# 性能测试指南

面向两类读者：

- **用户/验收人员**：按步骤测出可比较的启动时间，不依赖开发工具；
- **Agent/开发者**：用固定构建、固定样本、固定缓存状态和结构化 JSON 复现与回归。

本文只定义**怎么测**。当前实测结果、已知未达标项和实现事实以 [performance.md](performance.md) 为准；两者不要混写。

---

## 1. 先明确测什么

### 1.1 两种工程

| 类型 | 样本 | 计时重点 |
|---|---|---|
| 变电 | `substation01`–`substation04`、`A3-1`、`B1-1`–`B1-4` | IFC 加载、DEV 目录、DEV L0/L1/L2、Spatial、场景提交 |
| 线路 | `line01`–`line06` | 容器解析、线路图/地图数据、首次可交互 |

线路工程没有分阶段 DEV 几何，First/Current/Full 通常相同；不要把变电的“当前视图已完成”状态套到线路工程。

### 1.2 三个 SLO

统一使用以下定义，报告时写全称，不只写“启动时间”。

| 名称 | 判定 |
|---|---|
| **First usable** | 工程已打开，主界面可交互，项目名称/状态栏已出现；不要求全部几何完成。 |
| **Current view** | 当前相机范围内需要的 DEV 基础表示完成；以状态栏“当前视图已完成”或 `deviceLod.currentViewSettled === true` 为准。`currentViewReady === true` 只表示视觉上已显示，catalog 可能仍未 settled，不能替代 Current view SLO。 |
| **基础表示完成（旧表列名 Full fidelity）** | `deviceLod.baseRepresentationsSettled === true`；全站 L0 基础任务及目录已结束。分别报告显示、合法空源、不支持、部分和失败数。用户主动 L2、IFC 与连接线分别计量。 |

`productMoments.navigationUiReady` 单独记录变电树、搜索和文件设备面板完成 DOM 提交的首次时刻，冷解析和暖恢复使用相同入口。它不等待首个 IFC，也不因后续名称或空间语义补全而改写。该字段的 `scope: navigation-dom`、`inputLatencyVerified: false` 明确表示尚未证明绘制或输入响应；工程可操作仍须在原生窗口实际展开、搜索及查看基本信息确认。兼容字段 `interactive` 继续表示首个 IFC 可浏览的旧时刻，`firstUsableGeometryReady` 单独说明首个有效三维画面。不得把新增 DOM 时间点直接当作性能提升，或重算旧记录的 First usable。

基础表示完成采用该 LOD 的 settled 口径，`allStationReady` 只描述 L2，不用作启动完成条件。若有 `failedOccurrences > 0`、`unknownBounds > 0` 或几何范围拒绝，必须在报告里列出，不能把带失败项的工程写成完整成功。

超时统一记为 `>N s`，**不要**用超时时刻反推完成时间。

### 1.3 冷启动与暖启动

- **冷启动**：清空已核实的独立验收应用数据目录后重新打开同一个 `.gim`。包含解压、语义解析、IFC 转换、DEV 编译和缓存写入。
- **暖启动**：冷启动达到基础表示 settled 且对应缓存写入完成后，关闭应用进程，**只重启并重新打开同一工程**；不删除应用数据，不清理缓存。

暖启动有效的硬条件：

1. 上一轮冷启动确实达到基础表示 settled，并确认基础缓存写入完成；
2. 使用的是同一个 exe、同一份源码、同一个工程文件；
3. 只重启进程，没有重新解压、没有改缓存版本、没有改样本。

IFC 浏览 LOD 及连接线的可选缓存位于 WebView 的 IndexedDB，与 profile 绑定；DEV 派生缓存位于原生应用数据目录。暖启动必须同时保留这两处数据及原 profile。仅保留 SQLite/DEV 缓存却创建新 profile 的运行，应记录为混合缓存恢复，并分别列出 DEV 命中和 IFC 转换次数，不能写成完整暖启动。

冷启动未完成时，下一次打开不能标记为暖启动；只能记录“部分缓存恢复”，不能计入完整暖启动。

当前视图对照还需分别列出 L1 命中与冷编译数：L0/IFC 全命中而仍新增 L1 编译的运行，不能与 L1 全命中的 Current view 直接判定收益。完成判断优先核对应用就绪状态和 productMoments；异步缓存回调可能改写状态栏文字，不能只按“IFC 已结束”字符串判断超时。

**计时起点**统一为“向应用发起打开样本的动作”（点击“打开 GIM”或选择样本），不包含双击 exe 到窗口出现的时间。进程启动耗时如需要，单独记录为 launch time，不能混进三个 SLO。

---

## 2. 测试前准备

### 2.1 环境记录

每次测试至少记录：

- Git commit：`git rev-parse HEAD`；
- 应用版本：`desktop/package.json` 与 Tauri 配置中的 `version`；
- 构建方式：`npm run tauri:build` 产出的 Release，不是 `npm run dev`；
- Windows 版本、CPU 逻辑核数、内存、GPU；
- WebView2 运行时来源：Tauri Fixed Runtime 或系统运行时；
- 是否接通电源、是否高性能电源计划；
- 测试时是否关闭了其他构建、浏览器、杀毒扫描和大型应用。

性能数字只在同一环境、同一构建、同一缓存状态下比较。不要把开发模式、旧 exe、不同 WebView2 运行时的结果混在一张表里。

### 2.2 构建 Release

在 `desktop/` 下执行：

```powershell
cd desktop
npm ci
npm run build
npm run tauri:build
```

`npm run tauri:build` 会执行 Tauri Release 构建，并在结束后生成 portable 目录/ZIP。不要用 `npm run dev` 或 `tauri:dev` 做验收，它们是开发构建。

快速验证单个 exe 可以只用：

```powershell
npx tauri build --no-bundle
```

但正式验收应使用 `npm run tauri:build`，确认 portable 包中的 exe 与 Fixed WebView2 Runtime 一起启动。

常见产物：

- Release exe：`desktop/src-tauri/target/release/gim-viewer.exe`
- NSIS 安装包：`desktop/src-tauri/target/release/bundle/nsis/`
- Portable ZIP：`desktop/src-tauri/target/release/bundle/portable/GIM-Reader_<version>_x64_portable.zip`

Portable 包不是单文件；`GIM-Reader.exe` 必须和同目录的 `webview2-fixed-runtime/` 一起移动。只复制 exe 可能启动到系统 WebView2，导致结果不可比。

### 2.3 检查样本

构建完成后回到仓库根目录：

```powershell
cd ..
Get-ChildItem demo -Filter *.gim | Select-Object Name, Length
```

本指南使用的固定矩阵：

```text
line01.gim
line02.gim
line03.gim
line04.gim
line05.gim
line06.gim
substation01.gim
substation02.gim
substation03.gim
substation04.gim
500-A3-1 三维设计.gim
500-B1-1 三维设计.gim
500-B1-2 三维设计.gim
500-B1-3 三维设计.gim
500-B1-4 三维设计.gim
```

同一轮测试不要替换样本路径、大小写或内容。变电样本的 `substation03` 含很大的 `设备接线.ifc`，`B1-1`/`B1-4` 的解压条目数和 DEV 模板数也显著高于其他站；基础表示完成可能显著晚于 First usable，必须单独注明。`500-B1-3` 是没有 GIMPKG 头的裸 7z 工程包，容器类型按 magic 记录，不要因为缺少头部而跳过。

### 2.4 先跑正确性测试（不是计时）

```powershell
cd desktop
npm test
npm run test:sqlite
npm run test:sample
```

`npm test` 是快速单元测试；`test:sqlite` 需要 Rust SQLite harness；`test:sample` 依赖 `demo/` 下的解压样本，缺失会跳过。

这些命令用于确认构建没有明显回归，**不产生性能结论**。不要在跑性能的同时执行 `npm test`、`npm run build` 或其他 Tauri 构建。

### 2.5 独立数据标识的原生验收预检

在 `desktop/` 下执行：

```powershell
npm run test:acceptance-tools
npm run acceptance:build
# 使用上一步明确打印的 manifest 路径，不按文件名通配选择旧二进制。
npm run acceptance:stage -- '<构建生成的 acceptance-build.json 绝对路径>'
# 使用 stage 打印的临时目录清单；其内容和原清单保持一致。
node scripts/benchmarks/acceptance-probe.mjs '<临时目录 acceptance-build.json 的绝对路径>'
```

验收构建仍为优化的 Release，沿用同一固定 WebView2，仅用 `tauri.acceptance.conf.json` 改为独立应用标识 `com.bamboosjtu.gimviewer.acceptance`；不修改生产缓存版本。构建入口记录包含已修改及未跟踪文件的源码指纹、exe 哈希和完整固定运行时指纹；构建期间源码改变时拒绝发布清单。产物保存在被忽略的 `output/acceptance/builds/`，不覆盖已有 portable 包。

`acceptance:stage` 校验当前源码、exe 和完整运行时指纹，再将同一验收包复制到 Windows 本地临时目录下的唯一子目录，保留原始构建清单及来源凭据。它不修改目录权限、不修改二进制，也不触及应用缓存。仓库构建目录可能继承开发环境的特殊权限；从临时目录运行可避免把此类目录因素混入应用性能。正式验收仍须记录最终运行路径和指纹；复制成功不等于启动成功。

预检校验当前源码及产物哈希，为本轮创建独立 WebView profile，并通过本实例的 loopback CDP 读取原生 `get_db_path`，校验 Known Folder 目录、实际数据库路径与解析后的真实路径。构建清单中的 `nativeCachePathVerified: false` 不会因目录存在而变成成功；只有运行记录中的原生路径校验通过才算隔离已验证。预检不打开 GIM、不选择对象，结束时清理本次启动的进程树，保留日志和 profile 供排查。

`output/acceptance/runs/` 下的 `native-startup.json` 分别记录原生 setup 失败、浏览器 GPU 子进程启动失败、应用退出和启动超时。即使预检成功，也只证明原生桥接及缓存路径可用，不证明工程可操作、三维可见或任一性能 SLO；`stationPerformanceAccepted` 始终为 false。预检失败后先排查启动环境，不把该运行记为冷启动成绩，也不通过关闭浏览器安全机制来取得验收结果。

---

## 3. 冷启动步骤

### 3.1 关闭旧进程

```powershell
# 正常关闭本轮验收实例，并确认其自身的子进程已退出。
# 不按 msedgewebview2 进程名称批量结束其他应用。
```

注意：`msedgewebview2` 可能被其他应用共用。自动化环境可只结束 GIM 进程树；手工环境确认没有其他 WebView2 应用正在运行。

### 3.2 核实独立验收缓存目录

冷启动只能清理独立验收目录，不能清理用户日常的 `com.bamboosjtu.gimviewer` 数据。可使用固定 Release 配置中的独立应用 identifier，记录该配置、exe 和 WebView2 身份；通过应用诊断 `get_db_path` 核实实际数据库及派生缓存均位于该独立目录。

当前安装的 Tauri 2.11.3 在 Windows 使用 Known Folder 解析 `app_data_dir()`，仅修改子进程的 `APPDATA` 环境变量不能证明数据库已经隔离。尚未核实实际目录时，不执行清理，不开始冷启动验收，也不把指定了环境变量的运行标成已隔离。

正常关闭验收实例并确认其子进程退出后，验收脚本应检查解析后的绝对目标仍位于专用目录，再清理该目录中的数据库、解压内容和派生缓存。只删除某个缓存子目录不算完整冷启动。原始 GIM 与用户日常缓存保留。

### 3.3 启动并打开样本

手工验收：

1. 启动 Release exe；
2. 用“打开 GIM”选择 `demo/<sample>.gim`，不要用拖拽和最近项目混用；
3. 点击打开的瞬间开始计时；
4. 记录 First usable；
5. 继续观察状态栏，记录 Current view；
6. 等到 基础表示完成，记录 Full。

自动化或需要 CDP 时（在仓库根目录）：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
Start-Process 'desktop\src-tauri\target\release\gim-viewer.exe'
```

打开 `http://127.0.0.1:9222` 或连接 CDP。生产构建不保证 DevTools UI 可用，但远程调试端口仍可用于 `Runtime.evaluate`。

### 3.4 读取 DEV 状态（变电）

在 DevTools Console 或 CDP 中执行：

```js
(() => {
  const state = globalThis.__gimAppState;
  const dev = state?.deviceLodRuntime;
  return {
    projectId: state?.currentProjectId,
    type: state?.currentProjectType,
    footer: document.querySelector('footer')?.innerText ?? '',
    dev: dev?.diagnostics ?? null,
  };
})()
```

重点字段：

- `deviceLod.diagnostics.occurrences`：总实例数；
- `readyOccurrences`：已显示；
- `pending`：模板处理中；
- `directoryCompleted` / `catalogReady`：目录是否完成；
- `failedOccurrences`、`unknownBounds`：失败和未知范围；
- `currentViewReady`、`currentViewSettled`、`baseRepresentationsSettled`；`allStationReady` 另作 L2 诊断；
- `compiled[0..2]`、`lodHits[0..2]`：各 LOD 冷编译/缓存命中。

基础表示完成 的判定不能只看“已显示 N”：

```text
catalogReady === true
且 baseRepresentationsSettled === true
且已分别报告显示、合法空源、不支持、部分和失败数量
主动 L2 是否 pending 不影响基础表示 settled
```

如果 `failedOccurrences > 0` 或 `unknownBounds > 0`，可以记录“已 settled 但有失败/未知范围”，但不能写成完整成功。

### 3.5 结构化导出

应用内置两个快捷键：

| 快捷键 | 内容 | 用途 |
|---|---|---|
| `Ctrl+Shift+B` | 稳定 benchmark JSON | **性能验收主数据** |
| `Ctrl+Shift+D` | 数据库/诊断 JSON + timings | 排障，不替代 benchmark |

`Ctrl+Shift+B` 的 JSON 包含：

- `schemaVersion`、`commit`、`platform`、`buildMode`；
- `sample`、`coldWarm`、`sourceSha256`；
- `productMoments`（如 `interactive`、`devCurrentViewReady`、`devBaseRepresentationsSettled`、`fullModelReady`）；
- `longTasks`、`memorySamples`、`ifcProfiles`、`devGeometryProfile`；
- `fragmentsCacheProfile`、`cleanupProfile`。

taskPhases 提供有界的任务阶段聚合及慢样本，DEV 的 taskId 关联模板、Worker 与实例提交；sourcePath、LOD、优先级、cacheSource、Worker 会话/序号用于区分来源和调度。默认不逐任务写 console 日志。需要排查完整链路时，在诊断控制台/CDP 中于打开工程前设置 `localStorage.setItem('GIM_PERF_TASK_TRACE', '1')`，检查 Ctrl+Shift+D 的 timings.spans；结束后删除该键。taskPhases.spanWindow 报告窗口上限与淘汰数，存在淘汰时不能把保留窗口当作完整轨迹。阶段可能嵌套或并行，不将 totalMs 相加；cpuTimeAvailable: false 表示未测得 CPU 时间。

`productMoments.devCurrentViewSettled` 记录当前视图真正 settled 的首次时刻，包括已结束但有失败的情况，其 meta 保留失败数；`devCurrentViewReady` 继续表示没有失败的 ready 时刻。两者不能互相替代。启动成绩优先用 benchmark 导出，并在记录中标注额外诊断的触发区间。

`Ctrl+Shift+D` 只读取当前会话已经采集的状态，不重新扫描源文件。`substationCapabilitiesStatus` 区分 `available`、`not-collected` 和线路的 `not-applicable`；未收集不表示源文件异常。数据库路径和工程诊断并行读取，各自等待最多 5 秒，失败记录在 `diagnosticReadErrors`，其余性能状态仍导出。同一工程/性能会话的并发导出合并读取，工程切换后旧结果不提交。JSON 在写入剪贴板前输出到控制台；剪贴板失败仍可保留证据。读取上限不是对主线程阻塞的硬时限，也不取消已经发出的只读原生请求。

DEV diagnostics 的 cacheWriteReservedBytes、cacheWriteWaitingBytes、cacheWritePendingCount 提供缓存队列额度与等待量；waiting 的模板字节仍由输入额度保护，和 inputBudgetBytes 存在重叠。cacheWritesSettled 表示 DEV 写入已结束，cacheWritesReady 还要求没有保存失败或取消；它们不是 IFC、语义缓存或全进程内存的完成证明。基础表示 settled 不等待缓存落盘，暖启动记录还需核对所需缓存实际完成。

内存验收使用 Windows 原生 `processTreePrivateBytes`（当前进程及其后代进程的私有提交量），与 `processTreeRssBytes` 分开。`processTreePrivatePeakBytes` 保存该性能会话观测到的最大私有提交量，即使最早样本已退出最多 512 条的窗口仍保留。连续采样在前一次原生查询结束后等待 5 秒，采样间隔内的瞬时峰值可能遗漏；GPU 内存另行记录。不可用时为 null/unknown，浏览器 JS heap 或 RSS 不能填补私有提交量数据。

DEV `devGeometryProfile` 中的 `viewIndex` 提供 entries/rebuilds/visitedNodes/testedBoxes/candidates，表示空间筛选规模，不等于帧耗时改善。使用同一固定路线比较实际帧间隔和长任务；当前调度仍逐 occurrence 检查基础任务。

DEV 实例化仅作受控 A/B 试点，默认关闭。在验收 profile 中打开工程前设置 `localStorage.setItem('gim-debug-dev-instancing', '1')` 启用，设为 `'0'` 关闭；每次重启进程，保持同一构建、源文件、profile 和缓存。记录实际开关值及 `deviceLod.instancing` 的批次数、网格数、实例缓冲字节与失败数；`avoidedMeshDraws` 只是内部理论差值，实际 draw calls 以 renderer 测量为准。核对两次的 occurrence、LOD、矩阵、颜色和可见对象集合，再以同一相机与 30 秒真实输入路线比较。只有实际 draw calls 至少下降 30%、帧耗时不回退，且拾取、高亮、显隐、精化和工程切换通过，才可默认开启。保留原节点层级意味着场景节点数未必下降，不能只用批次数证明主线程收益。

JSON 会复制到剪贴板并输出到 Console。保存到仓库外或已被忽略的 `output/`，文件名建议：

```text
<yyyy-mm-dd>-<commit短sha>-<sample>-<cold|warm>-<run序号>.json
```

在导出前设置元数据（可选，便于自动归档）：

```js
globalThis.__GIM_BENCHMARK_SAMPLE_ID__ = 'substation01.gim';
globalThis.__GIM_BENCHMARK_COLD_WARM__ = 'cold';
```

这两个值在 `Ctrl+Shift+B` 时读取；每次打开样本前设置成当前值。

### 3.6 判定完成

```text
First usable  = productMoments.interactive.atMs
Current view  = 严格口径用 deviceLod.currentViewSettled（状态栏“当前视图已完成”）；
                productMoments.devCurrentViewReady 只表示视觉 ready，不能替代严格 SLO
基础表示 = productMoments.devBaseRepresentationsSettled.atMs
           同时核对 deviceLod.baseRepresentationsSettled 与各终态数量
           IFC、连接线和用户主动精化分别记录，devAllStationReady 不作启动完成条件
```

不同版本的产品时刻命名可能略有差异；以当前 `perfTimings` 的 `PerfProductMoment` 为准，报告时写清用了哪一个字段。没有产品时刻时，退回状态栏和 diagnostics，且要在报告注明。

---

## 4. 暖启动步骤

前提：上一轮冷启动已达到基础表示 settled、对应缓存写入完成，并且缓存没有被删除或改写。

1. 关闭应用进程；
2. 保留本轮已核实的独立验收缓存，日常缓存始终不清理；
3. 重新启动同一个 exe；
4. 打开同一 `demo/<sample>.gim`；
5. 按冷启动同样的三个 SLO 记录；
6. `Ctrl+Shift+B` 导出，`coldWarm` 设为 `warm`。

如果冷启动未到 基础表示完成：

- 不允许把下一轮称为暖启动；
- 只能记录“暖启动未验证”；
- 需要重新做完整冷启动，或延长冷启动完成窗口后再测。

暖启动不是“第二次打开更快”这么简单：同一进程内再次打开不重启进程，不能代表冷进程恢复；必须重启应用。

---

## 5. 线路工程

线路样本同样执行冷/暖。因为没有 DEV L0/L1/L2：

- First usable、Current view、基础表示完成 通常重合；
- 地图瓦片加载不属于启动 SLO，不要用“底图 tiles 加载完”作为 基础表示完成；
- 若 OSM/CARTO/Esri 不可达，记录底图状态，但不要把底图失败算作工程启动失败；
- 地图数据、塔位、导线段、跨越物是否出现，属于线路功能验收，不是本指南的三 SLO。

可检查：

```js
(() => ({
  type: globalThis.__gimAppState?.currentProjectType,
  footer: document.querySelector('footer')?.innerText ?? '',
}))()
```

---

## 6. 重复次数与统计

正式验收建议：

- 完整矩阵为每个样本 **冷启动 3 次**、每个有效冷启动后 **暖启动 3 次**；
- 工程量大时最低可接受矩阵为每样本 **冷启动 1 次、暖启动 3 次**，但必须写明缺少第二次/第三次冷启动，不能称为完整冷暖矩阵；
- 报告 **中位数** 和 **最大值**，不要只报最好一次；
- 冷、暖分开统计，不能把暖启动的最快值填进冷启动列；
- 暖启动需分别记录 L0 与所需 L1 的冷编译数；只命中 L0/IFC 的运行不能标成严格全命中暖启动。

最小可接受记录：

```text
样本：substation01.gim
commit：<sha>
构建：<exe sha256 / 产物路径>
环境：Windows <版本> / <核数> 核 / <内存> GB / <GPU> / WebView2 <版本>
冷启动：
  run1 First 22.4 / Current 55.0 / Full 55.0
  run2 ...
  run3 ...
  中位数 / 最大值
暖启动（冷启动已 Full）：
  run1 ...
```

---

## 7. 结果报告模板

建议直接使用以下表头：

| 样本 | 轮次 | 冷/暖 | First usable | Current view | 基础表示完成 | DEV 完成/总数 | failed | 备注 |
|---|---|---|---:|---:|---:|---:|---:|---|

必须写进备注的内容：

- 是否超时（`>60 s` 等）；
- `failedOccurrences` / `unknownBounds`；
- `catalogReady` 和 `pending` 是否为 0；
- 是否达到有效暖启动前提；
- 特殊样本：`substation03` 的 452 MB IFC、`substation02` 的 1265 unique DEV/3326 实例；
- 底图/网络异常只在线路工程备注，不影响工程 SLO。

不要只给一张“平均启动时间”汇总表；那会隐藏长尾和失败。

---

## 8. 常见错误

1. **用开发模式测**：`npm run dev` / `tauri:dev` 有 HMR、未压缩资源和不同 Worker，不能与 Release 比较。
2. **删错目录**：只允许清理核实过的独立验收缓存；只删 `device-lod` 或只清 WebView2 缓存不是完整冷启动，覆盖 APPDATA 环境变量也不是隔离证据。
3. **冷启动未完成就测暖启动**：缓存只写了一半，暖启动数字会虚高或虚低。
4. **换 exe/换 commit 后继续用旧缓存**：缓存域版本可能失配或保留旧几何；性能对比必须固定构建并在变更后重新冷启动。
5. **把“已显示数”当 Full**：还要看 pending、catalog、failed、unknown 和后台任务。
6. **把超时值写进完成时间**：`>60 s` 不是 60 s。
7. **并行跑构建/测试/其他基准**：CPU、磁盘和 WebView2 争用会污染结果。
8. **只测一次**：单次结果不能代表稳定性能，尤其 IFC 转换和磁盘缓存。
9. **忽略 GPU/WebView2 差异**：同一 exe 在不同机器/运行时上的结果不能直接合并。
10. **把底图失败算工程失败**：线路地图瓦片是外部网络；工程启动 SLO 不依赖它。

---

## 9. Agent 执行清单

1. 确认工作区干净或记录未提交变更；`git rev-parse HEAD`。
2. `cd desktop && npm ci && npm test && npm run test:sqlite`；样本相关改动再跑 `npm run test:sample`。
3. `npm run tauri:build`；记录 exe/portable 的 SHA-256 和时间戳。
4. 对每个样本：核实并清理独立验收目录 → 启动 → 打开 → 计时 → 导出 `Ctrl+Shift+B` JSON → 关闭。
5. 只有冷启动基础表示 settled 且对应缓存写入完成的样本才做完整暖启动；重启进程但不删缓存。
6. 完整矩阵为每样本 3 次冷/3 次暖；最低矩阵为 1 次冷/3 次暖，并显式写明缺口。记录中位数和最大值。
7. 把 JSON 与汇总表放在同一目录，表中引用 JSON 文件名。
8. 更新 [performance.md](performance.md) 时只写当前构建的实测结果，并保留未达标/失败说明；不要复制历史数字冒充当前结果。
9. 若改变缓存版本、Worker 数量、LOD 策略或 IFC 队列顺序，重新跑完整矩阵，不能只跑受影响样本后宣称全局回归通过。

---

## 10. 相关命令速查

```powershell
# 工作区/构建身份
git rev-parse HEAD
Get-FileHash desktop\src-tauri\target\release\gim-viewer.exe -Algorithm SHA256

# 构建
cd desktop
npm ci
npm test
npm run test:sqlite
npm run test:sample
npm run tauri:build

# 冷启动：先按 3.2 核实独立验收缓存实际路径并关闭所属进程。
# 本速查不提供清理用户日常 APPDATA 的命令。

# 远程调试启动
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
Start-Process 'desktop\src-tauri\target\release\gim-viewer.exe'

# 查看 CDP 页面
Invoke-RestMethod 'http://127.0.0.1:9222/json' | Select-Object title, url, webSocketDebuggerUrl
```

---

## 11. 相关文档

- [performance.md](performance.md)：当前基线、已知未达标项、实现相关性能事实；
- [validation.md](validation.md)：验证证据边界和验收规则；
- [open-issues.md](open-issues.md)：未关闭缺陷与已知限制；
- [架构](architecture.md)：IFC/DEV 分级、Worker 与缓存设计；
- 变电模型树（开发中）：[业务树](impl/model-tree-business.md)、[来源](impl/model-tree-source.md)、[空间](impl/model-tree-spatial.md)；
