# 性能测量

当前没有可作为本源码构建正式性能承诺的完整数字基线。
测量必须先验证语义、引用、坐标和交互正确，再比较时延与内存。
当前响应与完成时延的核验任务见 [未决事项](open-issues.md)。

## 指标

| 指标 | 起止或口径 | 必须同时说明 |
|---|---|---|
| 打开总时延 | 用户打开输入至指定 ready 状态 | 输入复制是否计入、首次可交互/完整模型 |
| 身份检查 | SHA/源读取和缓存校验 | 源大小、native/browser |
| 解压 | payload 解码、条目写出与调度 | 各阶段拆分、条目数、配额 |
| 核心语义 | graph/FAM/DEV 解析与持久化 | Worker wall time 与主线程工作 |
| IFC conversion | 单文件与总转换 wall time | Worker 并发、输入 copy、文件顺序 |
| Fragments load | `core.load`、回调与更新 | 与转换时延分别列示 |
| DEV | 读取、唯一模板编译、GLB I/O、placement、scene commit | unique DEV 与 occurrence 数 |
| Spatial | read/deserialize/hydrate 或 rebuild | hit 与 miss 分开 |
| 交互 | 输入到最终属性/高亮/相机提交 | 选择 ID、加载阶段、动画 settle |
| 主线程响应 | Long Task、heartbeat 间隔、输入延迟 | 监测窗口、最长值、分位数 |
| 内存 | JS heap、WebView/Worker/Tauri RSS 与峰值 | 单进程和进程树，采样方法、回收时间 |

ready 含义以 [架构](architecture.md#配置与加载状态) 为准。`allIfcReady` 和 `fullModelReady` 都须附加载失败、partial/unsupported 数；达到阶段不能解释为全源模型覆盖。

## 样本与运行条件

变电四包覆盖不同 IFC 布局、嵌套装配和 primitive；线路六包覆盖导出变体。
line02 为六线路中最大文件数与解包体积的样本，可作为线路压力输入。
具体身份与数量只在 [样本台账](schema/sample-corpus.md) 维护。

记录源码提交、依赖安装版本、EXE 与运行时资产哈希、OS/WebView、CPU/RAM、源位置、浏览器或原生、底图网络、监测器和缓存目录。
不同时运行其他基准任务；profiler 测量单独标注，不与未开 profiler 的值直接比较。

## 冷、暖与缓存策略

| 场景 | 初始条件 |
|---|---|
| 全冷 | 独立空缓存与独立进程；没有语义、GLB、snapshot、Fragments |
| 语义暖 | 合法语义缓存；明确列出其他缓存缺失或部分命中 |
| GLB 暖 | 有完整几何 manifest 和逐项命中统计 |
| Spatial 暖 | 合法 snapshot，记录 hydrate 与 rebuild 是否发生 |
| Fragments OFF/build/hit | 明确开关和源/依赖匹配，分别运行 |

不清除原始 GIM 和解包源。样本缓存准备不能算正式冷运行。
部分 GLB 命中不能标为完全 warm。默认 Fragments OFF 的结果不能外推为 HIT。

## 连续测量

从生产入口开始到指定终点，完整记录响应；不通过暂停大 IFC 或中断 DEV 管线降低时间。
超出时间上限是失败，之后完成只作为结束观察，不能改判达标。
取消/切换用例属于生命周期验证，与连续完整加载基准分开。

`Ctrl+Shift+D` 导出包含 timings 的诊断 JSON；`Ctrl+Shift+B` 进入基准相关工具。
埋点入口为 [perfTimings](../desktop/src/utils/perfTimings.ts)，DEV 细分入口为 [devGeometryTelemetry](../desktop/src/services/devGeometryTelemetry.ts)。
报告同时保存 root/alias/instance、IFC 数、缓存命中与选择结果，便于判定速度改善是否改变行为。

## 可采信基线

正式基线需具有相同输入和清晰构建身份，完成规定正确性门禁，报告多次运行的 p50/p95/max、内存峰值及释放后驻留。
只测到 warm、只测首批模型或缺少连续响应窗口时，只能说明对应范围。

当前没有满足上述条件的完整构建基线，正文不沿用不同构建的数字。
Android 真机冷导入和 warm 目标属于待核验要求，完成条件在未决事项维护。

## 移动端测量

移动端“地图设置 → 查看本机运行信息”显示本次会话的打开总时延及导入阶段耗时。
冷导入从 SAF 返回后复制开始，包含复制/SHA、原生校验与解压、Worker 投影、SQLite 提交，
终点是树和 Canvas 工程覆盖层可交互；不包含选择器停留或在线瓦片等待。
warm 从点击已有工程开始，终点相同。重复选择原包需要再次复制和 SHA，应单独记录。

Android 模拟器必须标注 API、WebView、native debug/release、ABI、模拟器资源和构建任务竞争。
单次模拟器记录用于定位瓶颈，不能作为 X Fold5 的 ≤10s/≤3s 达标证据。
指定真机需记录完整正确性、连续主线程响应和内存；仅构建优化成功不能认定性能达标。
