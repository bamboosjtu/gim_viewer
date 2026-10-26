# 设备与变电连续打开的 IFC 初始化修复

日期：2026-10-28。输入为设备样本 equipment-generic-308（隔离开关）及 `demo/substation01.gim`。本轮为生命周期缺陷修复，不作为性能 A/B 或全样本验收。

## 根因

设备浏览复用 Viewer，但没有 IFC，不启动 web-ifc WASM 和 Fragments worker。设备启动器将 `AppState.initialized` 置为 true，使 DEV 拾取可用；原 `initEngine` 也以该标记直接返回。随后切到变电，注册 IFC 模型事件访问未初始化的 `fragments.core`，抛出 `FragmentsManager not initialized. Call init() first.`。重新启动 EXE 后该标记恢复为 false，所以直接打开变电能正常工作。

清理路径还有同一前提错误：`fragments.list` 本身也依赖 core 初始化。设备首次打开后的清理遍历列表时抛错，跳过后续 MOD/STL 释放；资源统计读取同一列表也会失败。不能只改 IFC 启动而留下设备资源残留。

## 实现

- `ifcLoader` 用按 ViewerContext 持有的 Promise 独立管理 IFC 初始化。DEV 就绪不代表 IFC 就绪；并发调用共享一次 WASM/worker 初始化，失败移除 Promise，后续打开可重试。
- 保持 Viewer 的交互标记及模型事件的一次注册语义。工程切换释放模型，保留已初始化的引擎；设备浏览仍不提前启动 IFC。
- 清理和资源统计按 FragmentsManager 的公开 `initialized` 属性判断是否可以访问列表。没有 IFC core 时继续释放 DEV、STL 与高亮，Fragments 模型数记为 0。
- 不改变 GIM 数据、持久化含义、缓存版本、依赖、加载并发或 LOD 策略。

## 验证条件

原生 Release 使用独立标识 `com.bamboosjtu.gimviewer.acceptance`，实际数据库路径核对为该标识下的 `gim_cache.db`。未运行生产 EXE、未操作日常版本数据库。两版使用同一 Fixed WebView2（运行时清单 SHA256 `1bc71a6d464da1cd3f63ac1ff0d1b748f528aa8b3957b5e3a7f9ae28d6df7071`），独立验收 profile、1600×900 窗口。记录实际缓存命中，不以脚本参数中的 warm 标签代替缓存事实；本轮未清空验收缓存。

| 版本 | 源码指纹 | EXE SHA256 |
| --- | --- | --- |
| 修复前 | `61ed15429f73f00032452df62bea00eba7c19bf60d73b5263624e020bd433136` | `a728f80cfb675ff523365c45bd14a9ded24b05b2b498fc6ed7a75134b35077eb` |
| 修复后 | `c849dbeb9506b83f8499ad889956ce77ac0e8b22eb929fffd5bf4674854987ff` | `43460aeefd0a6c73dd519dbe9f193de76b1dbf3671d6aa53599da6f9396884b3` |

修复后构建清单：`output/acceptance/builds/2026-10-28T03-22-12.167Z-c849dbeb9506/acceptance-build.json`。源码指纹不含文档、忽略目录中的临时验收脚本和输出。

## 结果

修复前的现有测试文件新增回归用例，得到与截图一致的 FragmentsManager 异常；并发初始化和失败重试用例也失败。修复后相关 6 个测试文件共 43 项通过，包含工程迟到结果拒绝、选择交互、设备拾取、加载生命周期、资源统计及清理。仅在既有两个测试文件补充 4 个必要用例，未增加测试框架或测试文件。TypeScript/Vite 及原生 Release 构建通过。

修复前原生 EXE 的完整复现保持到 240 s 观察窗口结束：设备显示 1，切到 substation01 后 IFC 0/12、DEV 0/285；L0 虽命中 285，仍等待 IFC 坐标锚点。`initialized=true`、`eventsRegistered=false`，Fragments core 不可用；日志含清理异常及 IFC 外层加载失败。这与原截图的“缓存命中但场景为空”一致。

同一修复后 EXE 的第一组连续打开：

| 顺序 | 输入 | IFC AppState / runtime 模型数 | DEV 显示 | 缓存事实 |
| --- | --- | --- | --- | --- |
| 1 | 设备 | 0 / 0 | 1 | L0/L1 命中 1/1；尚未初始化 IFC |
| 2 | substation01 | 12 / 12 | 285 | 语义命中；IFC 冷转换 12；DEV 编译 L0/L1 为 285/14 |
| 3 | 设备 | 0 / 0 | 1 | L0/L1 命中 1/1；旧站 IFC 已释放 |
| 4 | substation01 | 12 / 12 | 285 | 语义命中、IFC 命中 12；DEV 编译 0/0，L0/L1 命中 285/14 |

两次变电加载均 `failed=0`，基础表示、当前视图与缓存写入完成后取证；原生进程正常关闭，截图已核对整站可见。日志中仍有已有的暖恢复 SCH/STD/SLD 资料缺失警告，不影响此次 IFC 显示；不据此宣称图纸完整。

第二组在新的 EXE 进程中执行 `substation01 → 设备 → 关闭工程 → substation01`。两次变电均 IFC 12/12、DEV 285，设备显示 1；关闭后 `currentProjectId=null`、`currentProjectType=null`、AppState 模型数及 Fragments 模型数均为 0，MOD 根已清空，进程正常关闭。该组两次变电的 IFC 均命中 12 份缓存；最后一次 DEV 的 L0/L1 编译为 0/5、命中计数 286/14，出现当前视图需要的额外 L1 编译，不能将该次称为全部基础档位缓存命中。没有用功能回归记录证明性能提升或稳定内存目标达标。

## 原始记录

目录均在仓库忽略的 `output/device-gim/`：

- `ifc-init-before.log`：修复前单元复现；`ifc-init-after.log`：43 项通过。
- `ifc-init-acceptance-build.log`、`ifc-init-stage.log`：原生构建和隔离运行目录。
- `native/switch-regression-warm-baseline-1793156258057.json`：初次原生复现，记录到设备清理异常后提前停止。
- `native/switch-regression-warm-baseline-1793158333569.json` 及对应 `-1.png`：完整原生复现，观察窗口结束仍为 IFC 0/12、DEV 0/285。
- `native/switch-regression-warm-candidate-1793157975439.json` 及对应 `-0.png` 至 `-3.png`：第一组四次连续打开、缓存状态、计数、日志与截图。
- `native/switch-regression-warm-candidate-station-first-1793158958742.json` 及对应截图：第二组三次打开与关闭后的资源状态。
- 复用的临时 CDP 脚本为 `desktop/.tmp/device-gim/native-switch.mjs`，未进入产品代码。

## 桌面产物

生产 Portable 保持 0.1.2，重新构建为 `desktop/src-tauri/target/release/bundle/portable/GIM-Reader_0.1.2_x64_portable.zip`，SHA256 为 `b82f6586692ac41c2cca6750808f60758f48bd65cb03e6d147c78bb2b0dd10f2`，322,201,215 bytes。ZIP 完整性检查通过，260 个文件、18 个目录，含完整 Fixed WebView2 目录。`ifc-init-portable.log` 与 `ifc-init-zip-integrity.log` 保存构建和压缩包检查记录。原生功能验证使用上述独立验收 EXE，生产包未运行以保持日常缓存不受验收影响。
