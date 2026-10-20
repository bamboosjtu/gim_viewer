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
| 变电 | `substation01`–`substation04` | IFC 加载、DEV 目录、DEV L0/L1/L2、场景提交 |
| 线路 | `line01`–`line06` | 容器解析、线路图/地图数据、首次可交互 |

线路工程没有分阶段 DEV 几何，First/Current/Full 通常相同；不要把变电的“当前视图已完成”状态套到线路工程。

### 1.2 三个 SLO

统一使用以下定义，报告时写全称，不只写“启动时间”。

| 名称 | 判定 |
|---|---|
| **First usable** | 工程已打开，主界面可交互，项目名称/状态栏已出现；不要求全部几何完成。 |
| **Current view** | 当前相机范围内需要的 DEV 基础表示完成；以状态栏“当前视图已完成”或 `deviceLod.currentViewSettled === true` 为准。`currentViewReady === true` 只表示视觉上已显示，catalog 可能仍未 settled，不能替代 Current view SLO。 |
| **Full fidelity** | 当前工程的全部 DEV/目录工作 settled：没有模板 pending、没有场景提交等待、目录 ready；不是“首屏可见”。 |

Full fidelity 要求上述条件同时成立。若有 `failedOccurrences > 0`、`unknownBounds > 0` 或几何范围拒绝，必须在报告里列出，不能把带失败项的工程写成完整成功。

超时统一记为 `>N s`，**不要**用超时时刻反推完成时间。

### 1.3 冷启动与暖启动

- **冷启动**：删除应用数据目录后重新打开同一个 `.gim`。包含解压、语义解析、IFC 转换、DEV 编译和缓存写入。
- **暖启动**：冷启动达到 Full fidelity 后，关闭应用进程，**只重启并重新打开同一工程**；不删除应用数据，不清理缓存。

暖启动有效的硬条件：

1. 上一轮冷启动确实达到 Full fidelity；
2. 使用的是同一个 exe、同一份源码、同一个工程文件；
3. 只重启进程，没有重新解压、没有改缓存版本、没有改样本。

冷启动未完成时，下一次打开不能标记为暖启动；只能记录“冷启动未完成，暖启动未验证”。

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
```

同一轮测试不要替换样本路径、大小写或内容。变电样本的 `substation03` 含很大的 `设备接线.ifc`，Full fidelity 可能显著晚于 First usable；必须单独注明。

### 2.4 先跑正确性测试（不是计时）

```powershell
cd desktop
npm test
npm run test:sqlite
npm run test:sample
```

`npm test` 是快速单元测试；`test:sqlite` 需要 Rust SQLite harness；`test:sample` 依赖 `demo/` 下的解压样本，缺失会跳过。

这些命令用于确认构建没有明显回归，**不产生性能结论**。不要在跑性能的同时执行 `npm test`、`npm run build` 或其他 Tauri 构建。

---

## 3. 冷启动步骤

### 3.1 关闭旧进程

```powershell
Get-Process GIM-Reader, msedgewebview2 -ErrorAction SilentlyContinue |
  Stop-Process -Force
```

注意：`msedgewebview2` 可能被其他应用共用。自动化环境可只结束 GIM 进程树；手工环境确认没有其他 WebView2 应用正在运行。

### 3.2 清空应用数据

应用标识来自 `desktop/src-tauri/tauri.conf.json` 的 `identifier`，当前为：

```text
com.bamboosjtu.gimviewer
```

清空：

```powershell
$appData = Join-Path $env:APPDATA 'com.bamboosjtu.gimviewer'
Remove-Item $appData -Recurse -Force -ErrorAction SilentlyContinue
```

这会删除项目数据库、解压目录和 DEV/IFC 缓存，是真正的冷启动。不要只删某个缓存子目录后仍称“冷启动”。

### 3.3 启动并打开样本

手工验收：

1. 启动 Release exe；
2. 用“打开 GIM”选择 `demo/<sample>.gim`，不要用拖拽和最近项目混用；
3. 点击打开的瞬间开始计时；
4. 记录 First usable；
5. 继续观察状态栏，记录 Current view；
6. 等到 Full fidelity，记录 Full。

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
- `currentViewReady`、`currentViewSettled`、`allStationReady`；
- `compiled[0..2]`、`lodHits[0..2]`：各 LOD 冷编译/缓存命中。

Full fidelity 的判定不能只看“已显示 N”：

```text
catalogReady === true
且 pending === 0
且没有模板/场景提交/目录准备中的阻塞
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
- `productMoments`（如 `interactive`、`devCurrentViewReady`、`devAllStationReady`、`fullModelReady`）；
- `longTasks`、`memorySamples`、`ifcProfiles`、`devGeometryProfile`；
- `fragmentsCacheProfile`、`cleanupProfile`。

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
Full fidelity = productMoments.devAllStationReady.atMs
               或 devGeometryReady / fullModelReady 中语义最接近的 settled 时刻
```

不同版本的产品时刻命名可能略有差异；以当前 `perfTimings` 的 `PerfProductMoment` 为准，报告时写清用了哪一个字段。没有产品时刻时，退回状态栏和 diagnostics，且要在报告注明。

---

## 4. 暖启动步骤

前提：上一轮冷启动已达到 Full fidelity，并且缓存没有被删除或改写。

1. 关闭应用进程；
2. **不要**删除 `%APPDATA%\com.bamboosjtu.gimviewer`；
3. 重新启动同一个 exe；
4. 打开同一 `demo/<sample>.gim`；
5. 按冷启动同样的三个 SLO 记录；
6. `Ctrl+Shift+B` 导出，`coldWarm` 设为 `warm`。

如果冷启动未到 Full fidelity：

- 不允许把下一轮称为暖启动；
- 只能记录“暖启动未验证”；
- 需要重新做完整冷启动，或延长冷启动完成窗口后再测。

暖启动不是“第二次打开更快”这么简单：同一进程内再次打开不重启进程，不能代表冷进程恢复；必须重启应用。

---

## 5. 线路工程

线路样本同样执行冷/暖。因为没有 DEV L0/L1/L2：

- First usable、Current view、Full fidelity 通常重合；
- 地图瓦片加载不属于启动 SLO，不要用“底图 tiles 加载完”作为 Full fidelity；
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

- 每个样本 **冷启动 3 次**；
- 每个有效冷启动后各做 **暖启动 3 次**；
- 报告 **中位数** 和 **最大值**，不要只报最好一次；
- 冷、暖分开统计，不能把暖启动的最快值填进冷启动列。

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

| 样本 | 轮次 | 冷/暖 | First usable | Current view | Full fidelity | DEV 完成/总数 | failed | 备注 |
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
2. **删错目录**：冷启动必须清 `%APPDATA%\com.bamboosjtu.gimviewer`；只删 `device-lod` 或只清 WebView2 缓存不是完整冷启动。
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
4. 对每个样本：清 APPDATA → 启动 → 打开 → 计时 → 导出 `Ctrl+Shift+B` JSON → 关闭。
5. 只有冷启动 Full 的样本才做暖启动；重启进程但不删缓存。
6. 每个样本至少 3 次冷/3 次暖；记录中位数和最大值。
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

# 冷启动清理（先关进程）
Get-Process GIM-Reader, msedgewebview2 -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item (Join-Path $env:APPDATA 'com.bamboosjtu.gimviewer') -Recurse -Force -ErrorAction SilentlyContinue

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
- [impl/performance-lod.md](impl/performance-lod.md)：LOD、Worker、缓存设计。
