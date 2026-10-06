# 任务 B：默认完整 IFC 路径的阻塞归因与隔离

日期：2026-10-05—06，Windows / Asia/Shanghai。任务 A 单独见
[嵌套 PARTINDEX 正确性](substation_nested_partindex_correctness.md)。
本报告区分阶段修复、通过的正确性门禁、失败的响应目标及未执行桌面项。
任务 A 的嵌套定位及最终 02/03 warm 观察通过。本轮仍不能宣称完整冷暖持续响应验收通过：
02 冷路径完整时间和残余响应间隔、03 冷路径响应目标仍有失败，具体结果逐次保留。

## 可恢复的源码、构建和输入基线

开始 HEAD 为 `a0e05124b148c02755c01c4514f201f0e4611ba4`，工作区干净。
该提交已包含上一轮 FAM、occurrence 和 SelectionRequest；本轮没有覆盖后续修改，也未创建 commit。
实验材料在 Git 忽略的 `output/playwright/runtime-closeout/`。原样本和完整解包目录未提交。

| 实验源码/构建 | 身份与可恢复材料 |
|---|---|
| baseline | `baseline/source-head.zip`、空 `working-tree.patch`、逐文件 `manifest.json`；tracked 源码集合 SHA `4c6681ff25471e4569d023e2d56e402da8b08a03d45b69a276c6c5c029ac896e` |
| 仅任务 A | `task-a.patch`、`task-a-new-tests.zip`；在任务 B 开始前保存 |
| 任务 A + IFC Worker | `fixed/source.zip`、源码 manifest、frontend dist、release EXE；源码集合 SHA `f86919c7227c476405f3d5f5f6e59cff7ab02781246b9bbb5ec8020d46453c2e` |
| 再加 Spatial Worker | `stage2/source.zip`、`working-tree.patch`、manifest、frontend dist、release EXE；源码集合 SHA `8382f6c1b2b73f28ab8d578fa3bfda858f99650525865a2a4d9e2c5bd53fc366` |
| 缓存位置校验补测 | `verified/` 保留源码、patch、dist、manifest、EXE；此阶段尚未修正 IFC 恢复顺序 |
| 最终恢复顺序修复 | `release-final/` 的 `source.zip`、`working-tree.patch`、`frontend-dist.zip`、manifest 和 EXE；desktop 文件集合 SHA `2a386dff0b296525efd036ad98e3bab78bb10e546eeda0f8f4e237aeb8a0d733` |

构建命令为 `npm run build`，随后
`cargo build --release --features tauri/custom-protocol --manifest-path desktop/src-tauri/Cargo.toml`。
均为 production Vite + Tauri release，实际打开 `http://tauri.localhost/`，不是 dev server。

| production EXE | SHA-256 |
|---|---|
| baseline | `bd72856cd438aa3df0ad66f5e78834bd9a9c52adee70c721082e73d300ac5f27` |
| fixed（IFC Worker） | `2061fbc430eef8d6fde14c42987bd9147f9691d2a71e314be9f4403ea287af31` |
| stage2（IFC + Spatial Worker） | `1de0cd9f84ec0403e3ebdf8ec5d59c3d0d7c3e0047978739c94b8905a26529c0` |
| verified（缓存位置） | `4a3e47912a5f8530b46d19bbf46423c5b9ed4812a881b315fb85d7ac064377a3` |
| release-final（再修复恢复顺序） | `fa57a79a36de7ce173a6ad4789d430492ea3caa137a39e017c3bb32958341675` |

上述已测 EXE 与源码快照不被替换。`final/gim-viewer.exe` 是已撤回、未解决问题的路径假设试验，
不属于有效修复构建；该试验材料保留，不能与 `verified/` 混用。
baseline 实验 identifier 为 `com.bamboosjtu.gimviewer.closeout`，修改版为
`com.bamboosjtu.gimviewer.closeoutfixed`，隔离实验 SQLite/DEV 缓存，不清除正常用户缓存。
WebView profile 也在实验目录，启用 CDP 9331/9332；补测启动尝试为 9333/9334，最终为 9336。

依赖锁未修改：`package-lock.json` SHA
`c65dd889a57fdff85948794530535b6b76b3021dc2a2e3b17b8db7035709f140`，
`Cargo.lock` SHA `fd89bfbaf65074c4597536ac67bb3fb0754a0c472183a44ad86155299fae3493`。
实际安装 components/fragments 均 3.4.6、web-ifc 0.0.77、three 0.184.0、camera-controls 3.1.2，
Node 23.8.0；实际 WebView 为 Edg 154.0.4258.53 / V8 15.4.11.7。
机器为 Windows 11，32 GB RAM，GPU 设备信息保留在 `scene.json`。
最终 WebView 实际 GPU 为 NVIDIA GeForce RTX 2060 / ANGLE D3D11。

实际 .gim 文件已重新 SHA-256 校验，解包目录有来源 stamp：

| 样本 | 精确字节 | SHA-256 |
|---|---:|---|
| 01 / demo-substation | 14381403 | `711259814db95999f5282af1871da9cb50db4548b71626637b33038b062fc390` |
| 02 | 34176631 | `a1c0990162e769f678f2fe5eeb275b1266fb8640776399289197d1998d372f29` |
| 03 | 71831575 | `3197c03ef2c6c423cbb85447f71491a4112db0f9a8cea0c9f72f0b410b8175ab` |
| 04 | 11789608 | `00b7746d5ea6ab3b92c215c1e42ffc7eec5a9f0517c1c555fa27a596d4d800dc` |

最大 IFC 的真实解包 entry：

| 样本 | entry | 字节 | SHA-256 |
|---|---|---:|---|
| 02 | `CBM/0302-钢结构.ifc` | 390725879 | `71d5d31cdddbf01f336864cc6d13a469ce07efa475e175f2f7b7ec65df679605` |
| 03 | `CBM/设备接线.ifc` | 452493315 | `c64fc8cb5f764651277b3bf9fa14c67d88be4192e1dd3324497c6888baca5658` |

默认完整测量均未暂停大 IFC，没有旧 `INTERACTION` / `RELEASE_DEVICE` / `READ_STARTED` 拦截，
Fragments 默认关闭，localStorage `gim-debug-fragments-cache` 为 null。
CDP 添加被动 1 s 心跳观测和每 3 s trusted Shift 输入；没有替换生产加载函数。
baseline warm 开启 CPU profiler，baseline 部分运行与回归检查并行；修改版冷路径未开启 CPU profiler。
这些差异影响 wall time，单次数据不能用来宣称稳定速度提升。此前受控暂停 IFC 的截图不属于本报告。

在实验前固定每轮 600 s 完整加载上限、interactive 后最长心跳间隔 ≤2 s、输入延迟 ≤1 s。
每条有效路径只测一次（n=1），逐次报告，不给平均值或统计置信结论。没有不断提高超时。

## 修改前归因

历史 02 OFF warm 271.9 s / 最大 Long Task 221.7 s、steel conversion 198.8 s 只是线索。
本轮 baseline 冷路径全部 17 个 IFC 成功，但钢结构文件 native 读取约 4.229 s、decode 0.311 s，
原 conversion/composite span 为 288.958 s。页面 Long Task 最大 272.581 s。
对应 CPU profile 在主线程 web-ifc WASM / 属性序列化调用中。

检查实际安装源码：components `IfcLoader.load()` 直接创建 `FRAGS.IfcImporter`，
在主线程调用 `process()`；process 虽返回 Promise，其 `web-ifc.OpenModel`、几何及属性转换
仍执行同步工作。Fragments 自带的 worker 没有隔离这一步。不能用 Promise 包装或一次延迟消除它。

baseline warm 又测到钢结构 composite conversion 408.329 s，心跳间隔 392.175 s、
输入延迟 391.260 s。这证实主线程长时间被占用，与历史阶段归因一致；wall time 与历史数值不同。
CDP 没有断连，最终 17/17 模型成功；外部进程监测继续记录 CPU/内存，故这不是单纯自动化超时。
4 s 级 IPC 读取和约 0.3 s decode 不是数分钟冻结的主导项。内存峰值不能据此排除内存压力，
但已确认的同步转换足以解释这次主线程冻结。

baseline cold 的外部 monitor 启动较晚并收到前一次 04 的历史 console，
它的 response-summary、fullModelReady 与不完整内存窗口作废；该路径只使用经 sourceSha 校验的
`baseline/02-cold-benchmark.json` 产品时刻/Long Task 和局部 CPU 归因，不伪造全程输入响应。
baseline warm 的语义已 warm，但首次冷实验未完成所有 DEV 编译，起始 DEV 缓存为部分命中，
不能称为“完整 DEV warm”。后来继续完成缓存仅用于补测准备。

## 第一阶段：只隔离原始 IFC conversion

新增 `viewer/ifcConversion.ts` 和 `ifcConversionWorker.ts`，由 dedicated module Worker
执行实际安装的 `IfcImporter.process()`。保留原 wasm/webIfc settings、runtime modelId 和
主线程 `fragments.core.load()`、模型登记/回调；保留首个 IFC 的 autoCoordinate/坐标锚点契约。
入口 `ifcLoader.ts`、`ifcEntryLoader.ts` 仅替换原始 conversion 边界。Fragments HIT 逻辑未改。

每次转换复制一份调用者字节给 Worker 并 transfer，避免 detach 调用者持有的 IFC 数据；
返回 fragment 字节 transfer 后 terminate 本文件 Worker，释放其 WASM。
不同时改变批次、优先级或 DEV 启动依赖。Worker 错误沿原有逐文件失败隔离处理，
不自动回退到阻塞主线程的 converter。工程 cleanup 终止旧工程转换；选择变化不取消同工程资源。

02 第一阶段默认冷路径钢结构 Worker span 333.529 s；转换期间心跳约 1 s、输入约 1 ms。
这证明数分钟转换期间界面可继续响应，但没有声称转换本身变快。
全部 17 IFC 成功后，原 Spatial STEP 扫描又产生约 12.792 s 心跳间隔 / 11.745 s 输入延迟。
现有逐 IFC STEP profile 中钢结构 scan 10.777 s；这成为第二次修改的独立证据。
完整模型未在 600 s 达到，保留失败。超时后观察到 fullModelReady 790.304 s，
仅作为后续 DEV 编译和暖缓存准备记录，不能将该轮改判通过。

## 第二阶段：隔离已确认的 Spatial STEP scan/finalize

`substationSpatialWorker.ts` 在 Worker 中复用现有纯 `SubstationSpatialIndexBuilder`，
`substationSpatialWorkerClient.ts` 延续顺序逐文件读取、大小写路径 resolver、缺文件/读取失败证据，
transfer 每个 IFC ArrayBuffer，在 Worker decode/scan/finalize，再 structured-clone 完整图回来。
没有删属性、空间关系、来源或 confidence；没有改变 snapshot 结构或缓存判定。
`substationRuntime.ts` 仅替换原 builder 调用，cleanup 取消旧工程扫描。
主线程仍负责原有工程会话检查、scene/resource/UI 提交。

03 第二阶段默认冷路径实际扫描 452493315 字节的最大 IFC，STEP scan 12.147 s，
发生于 Worker；空间图 8 个模型、32 spatial nodes、9572 objects、610 links。
页面全轮最大 Long Task 1.473 s，但心跳仍出现 4.301 s 间隔、输入 2.728 s 延迟。
多个主线程工作/调度间隔不能只用单个 Long Task 推断；残余来源还需要独立测量，
本轮不将其唯一归因或继续开展 DEV/CSG 性能重构。持续响应门禁仍失败。

另将 benchmark JSON 输出移到 clipboard await 之前，防止导出权限提示挂起时丢失日志。
这是诊断可用性修改，不能算性能问题修复；导出产生的权限页属于监测后操作，无 IFC 拦截。

## 逐次默认路径结果

所有时间从工程打开计起，单位秒。`first usable` 和 `interactive` 本轮均来自第一个 IFC。

| 路径 | coreSemantic | first usable / interactive | allIfc | fullModel | 最长心跳 / 输入 | 判定 |
|---|---:|---:|---:|---:|---:|---|
| baseline 02 cold | 36.582 | 37.864 / 37.865 | 367.474，17/17 | 600 s 内未完成 | 监测窗口污染，未采信；最大 LT 272.581 | 失败/部分证据 |
| baseline 02 semantic warm、DEV 部分命中，profiler ON | 46.769 | 49.038 / 49.039 | 518.986，17/17 | 609.265 | 392.175 / 391.260 | 完整时间及响应失败 |
| 第一阶段 02 cold，默认 OFF | 38.844 | 40.907 / 40.907 | 431.468，17/17 | >600；窗口外 790.304 | 12.792 / 11.745 | 失败；转换隔离有效，后续仍阻塞 |
| 第二阶段 03 cold，默认 OFF | 29.063 | 37.971 / 37.972 | 114.368，8/8 | 184.095 | 4.301 / 2.728 | 完整时间通过，持续响应失败 |
| 第二阶段 02 重试，语义 MISS + 已有 DEV cache | 36.920 | 39.085 / 39.086 | 422.207，17/17 | >600；窗口外 725.383 | 5.150 / 4.252 | 完整时间及响应失败；不是完整 warm |
| 第二阶段 03 重试，缓存校验失败后 cold fallback | 47.995 | 59.000 / 59.000 | 168.881，8/8 | 268.709 | 2.114 / 1.534 | 完整时间通过，响应失败；不是 warm |
| verified 02 真正 warm，恢复顺序未修复 | 1.286 | 2.547 / 2.547 | 343.159，17/17 | 346.297 | 1.381 / 0.038 | 响应/完成通过，但首个 IFC 锚点不一致，完整性失败 |
| 最终 02 semantic + DEV warm，默认 OFF | 1.573 | 4.181 / 4.182 | 437.758，17/17 | 443.603 | 1.586 / 0.062 | 本次完成/持续响应通过；首 IFC 和锚点与冷路径一致 |
| 最终 03 semantic + DEV warm，默认 OFF | 1.722 | 11.371 / 11.372 | 98.848，8/8 | 101.639 | 1.911 / 0.788 | 本次完成/持续响应通过；锚点与冷路径一致 |

baseline warm monitor 自己的 timeout=false 并不代表产品 fullModel ≤600 s；
609.265 s 仍判失败。产品 moment 和外部心跳 wall time 分别保留，不混为一个时钟。

内存为实验应用及子进程合计，外部约 2 s 采样，精确值保存在 `process.jsonl`：

| 路径 | 峰值 RSS / Private bytes | 最后采样 RSS / Private bytes | 窗口限制 |
|---|---|---|---|
| baseline 02 warm | 4045131776 / 5333274624 | 2919563264 / 2783948800 | full 后短暂观察，非长期驻留 |
| 第一阶段 02 cold | 5257900032 / 6127431680 | 4217458688 / 4173705216 | 600 s 截止，未完成；不能作为结束驻留 |
| 第二阶段 03 cold | 5000368128 / 5711380480 | 2031382528 / 1822441472 | full 后约 20 s；非长期驻留 |
| verified 02 warm，恢复顺序未修复 | 3248455680 / 3263692800 | 2151600128 / 2122637312 | full 后约 20 s；坐标失败结果仍保留 |
| 最终 02 warm | 4053344256 / 4632461312 | 2185863168 / 2151260160 | full 后约 20 s；非长期驻留 |
| 最终 03 warm | 4023832576 / 4090671104 | 1548664832 / 1333878784 | full 后约 20 s；非长期驻留 |

Worker 增加并行驻留和一次输入 copy，实测内存较高，未声称内存优化。
`measurement-summary.json` 是从原始日志派生的索引；baseline cold 混入的旧 fullModel 字符串不能采用。

最终 warm 02 钢结构 Worker span 为 369.014 s，随后 `fragments.core.load` wall span 1.784 s；
03 设备接线 Worker span 35.225 s，`core.load` wall span 1.657 s。
页面最大 Long Task 分别 761 ms、856 ms，与 wall time 分开统计；对应最长心跳/输入见表。
Worker 的长 wall span 仍在执行实际转换，主线程没有因这一步冻结数分钟；没有声称转换变快。
最终有效 warm 每样本 n=1，03 响应接近预设阈值，不能根据单次通过承诺所有机器和重复运行稳定达标。

重试的目录 `stage2/02-warm`、`stage2/03-warm` 沿用了开始时的计划名称；生产缓存校验及
产品日志证明实际发生 MISS，报告按实际路径标记，不能按目录名当作 warm 通过。
02 重试的峰值 RSS/private 为 3844820992/4749045760，03 重试为 4052152320/4678500352。
02 在 600 s 后继续完成只用于准备缓存，03 重试时 02 缓存准备尚在进行，wall time 不作速度对比。
02 重试残余响应间隔出现在 IFC 已为 17 个、DEV group 从 1302 到 1316 的后续编译阶段，
已隔离的 IFC/STEP 扫描不再解释这一段；本轮未把这项残余判为通过或开展大规模几何重构。

## 补测暴露的两个缓存恢复问题

生产 `validate_gim_cache` 对已完成的 02/03/04 分别报告 0/17、0/8、0/19 个有效 IFC，
原因是“缓存路径不匹配”，语义 v25 和 geometry v8 本身均存在。直接沿用这个结果会误测 cold。
最初“重复分隔符”假设未得到生产验证，相关归一化试验已撤回。

独立 Rust 路径实验使用实际 SQLite 字段和应用根证明：当前 Codex/MSIX Windows 环境中，
`AppData/Roaming` 在 canonicalize 后成为 `AppData/Local/Packages/OpenAI.Codex_…/LocalCache/Roaming`。
数据库保留 app_data_dir 的词法路径，原校验只接受规范化后的名称，因而拒绝同一个物理文件。
`db.rs` 仅接受由可信应用根及已校验 entry 构造的词法名称或规范名称，
不 canonicalize 任意候选，不放松 `..`、越界、逐级链接/junction 检查和文件大小检查。
修正版 native 校验确认三个项目均有效，IFC 分别 17/17、8/8、19/19。

真正 warm 又独立发现 `get_gim_index_connection` 按哈希 `model_id` 排序，
使首个 IFC 从冷路径的围墙变成事故油池，02 的坐标锚点随之改变。
新增真实 SQLite 顺序用例在修改前失败。恢复查询改为已有 INSERT 的 `id` 顺序，
保留冷路径的首个 IFC 和原锚定规则；严格四样本门禁也断言整个 IFC 顺序等价。
这两个修复没有重写缓存格式或对样本文件名分支。

## 完整性、桌面行为与未执行项

02 baseline/fixed/final 均加载 17 个 IFC，sourceSha 与输入身份相同。正确顺序的 cold/final warm
projectSourceToViewerMatrix 16 元素逐项相同，平移为 `[-17.75,-0.73,-0.025]`；
03 cold/final warm 的 16 元素也相同，平移为 `[-46.67348,0.9,19.31654]`。
独立比较结果在 `release-final/coordinate-check.json`，保留先 IFC 锚定再 DEV 的原依赖。
最终 warm 的所有 loaded model IDs 均属于各自工程；02 为 2532 个不同渲染 root、无重复 root，
03 为 162 个不同渲染 root、无重复 root。源语义 root/DEV 总量和编译状态另见严格门禁，
渲染 root 数量不能等同于全站所有 primitive 已可显示。
真实全部 IFC 几何顶点逐项比较未执行，不能把 anchor 等价夸大为全模型几何等价。

| 桌面项目 | 默认完整 IFC 条件下的证据 | 结果/限制 |
|---|---|---|
| 02 A/B 共用 DEV | 冷路径和最终 warm 均执行。最终 warm 默认 IFC 为 7 时 A→B、重复 B；只高亮 B root，B 的 GLB key 不增，camera target 与冷路径相同；之后 17 IFC 全部完成 | 实例范围本次观察通过；`release-final/02-warm/interaction.json`、`shared-dev-B.png`；不能宣称完整双柜几何还原 |
| 02 A/B → empty | 冷/warm 均选 `9feab04d…`，empty 证据、属性新对象、旧高亮集合空，camera target 保持前一快照；最终 full 后仍是该选择 | 本次观察通过；最终 `empty.json`、`empty.png`、`after-full.json` |
| 02 重复点击 | 首轮全站 4→50 比较无效；第二阶段重试期间 A→B、重复 B，B root 的单个 GLB key、属性、高亮、相机 target 相同 | root 范围本次观察通过；`stage2/02-warm/interaction.json`、截图。该轮实际是 MISS，未冒充 warm |
| 03 反序部件 | cold/final warm 均点击 PARTINDEX `F2B6047C…`，指向 `25E4F816…dev`；语义 index 0，真实 assembly `sub:1`；高亮仅 root `976E4AA2…`；full 后仍是该选择 | 本次观察通过；`release-final/03-warm/reversed-part.png`、`interaction.json`、`after-full.json`。原始 DEV SYMBOLNAME 与语义部件名不同，未猜测改名或形状含义 |
| 04 嵌套 PARTINDEX | 冷路径与最终 warm 均执行；warm 默认后台 IFC 为 11 时快速父→子，16 叶子均归 `c93b6211…`；重复 root key 不变；之后 19 IFC / 532 groups | 本例冷/warm 观察通过；`release-final/04-warm/interaction.json`、截图，任务 A 独立报告 |
| 02 待完成转换 → 切换 03 | 02 7 个 IFC、钢结构 Worker target `0CEBAB05…` 尚存时切换；旧 target 消失；03 request 19、属性接线端子板、`sub:1`；03 最终 8 IFC、162 个不同 root、全为当前工程 | 本次观察通过；`release-final/project-switch/`；此轮明确取消旧工程，不计入 02 完整加载测量 |
| 人为可控 slow A/fast B | 生产处理链 deferred 测试保留；桌面使用真实加载交错，没有注入人工延迟 | 人为受控桌面时序未执行；不混入默认路径 |

搜索鼠标自动化先出现 detached/未激活 option，相关失败操作已保留且排除；
改用产品键盘 ArrowDown+Enter 后才得到上述选择观察。旧 inline-style CSP 报错亦保留，
没有据此扩大本轮 CSS 修复范围。相机动画未 settle 的快照不作为最终 target 的等价断言。

补测启动时两个新 stage2 profile 出现 WebView browser 进程崩溃，Crashpad
`msedge.dll` 154.0.4258.53 / offset 45688693 / `0xc0000005`，native window 尚在而 CDP 拒绝连接。
后续指定另一 runtime 的启动尝试显示 “Could not find the WebView2 Runtime”，属于无效环境设置，
不纳入模型实验。恢复自动 runtime 后 baseline 新 profile 可启动；故不能宣称所有应用都受同一
外部故障影响，也不能唯一归因于前端代码。随后改用既有 harness 的 page WebSocket CDP，
新 profile 和真实 WebView 可正常启动；浏览器根 attach 与故障有关联，但未证明唯一因果。
崩溃及无效环境设置材料保留，不计入模型性能通过/失败。

最终 02 首次 native picker 没在原有 5 s 内暴露文件名 Edit，模型尚未打开（0 模型/无工程 SHA）。
取消该原生对话框后将 monitor/进程日志保存在 `release-final/02-picker-failure/`，另起实际测量，
没有把这段准备等待算作 IFC 时间，也没有提高模型 600 s 上限。
最终 02/03 测量没有并行构建或回归测试；04 定位补测及单独工程取消观察曾与严格门禁并行，
这两类用于正确性观察，不拿来宣称独立速度提升。
最终环境为 i7-9750H、12 logical CPUs、32 GB RAM、平衡电源方案；电池状态为充电，
采样 71%。CPU 当前频率字段只是一次系统报告，不据此给 wall time 差异猜测唯一因果。

## 自动门禁与版本

实际修改清单（相对仓库根；未修改依赖锁、FAM schema、AppState/SelectionRequest、线路 Runtime 或 primitive factories）：

| 分组 | 文件 |
|---|---|
| A：派生 alias 与相同 seed 谓词 | `desktop/src/gim/substationEvidence.ts`；`desktop/src/services/modAutoLoadService.ts` |
| A：独立小 fixture、raw/GLB/选择 | `desktop/src/gim/__tests__/nestedPartIndex.test.ts`；`desktop/src/services/__tests__/nestedPartIndexFixture.ts`；`occurrenceInteraction.test.ts`；`selectionInteraction.test.ts`（后二者同 services tests 目录） |
| 共用真实门禁与 IFC 顺序断言 | `desktop/scripts/test-substation-strict.mjs`；`desktop/src/services/__tests__/strictSubstation.test.ts`；`famSqlite.test.ts`（同目录；只增 IFC 顺序及第二文件，不重写 FAM） |
| B：原始 IFC Worker 边界 | `desktop/src/viewer/ifcConversion.ts`；`ifcConversionWorker.ts`；`ifcEntryLoader.ts`；`ifcLoader.ts`（同 viewer 目录） |
| B：Spatial STEP Worker 边界 | `desktop/src/services/substationSpatialWorker.ts`；`substationSpatialWorkerClient.ts`；`substationRuntime.ts`（同 services 目录） |
| B：取消、诊断导出与缓存恢复 | `desktop/src/services/projectCleanupService.ts`；`desktop/src/app/bootstrap.ts`；`desktop/src-tauri/src/db.rs` |
| B：生产链/已有缓存策略测试 | `desktop/src/viewer/__tests__/ifcConversion.test.ts`；`ifcFragmentsCache.test.ts`；`ifcSessionRace.test.ts`（同目录）；`desktop/src/services/__tests__/substationSpatialWorker.test.ts` |
| 文档 | 本报告、`docs/substation_nested_partindex_correctness.md`、`docs/gim_substation.md`、`docs/substation_runtime_correctness.md`、`docs/substation_interaction_correctness.md`、`docs/benchmark_substation.md` |

最终检查：

| 命令 | 结果 |
|---|---|
| `npm test -- --maxWorkers=1 --minWorkers=1` | 恢复顺序修复后 76 文件、788 项通过，44.72 s；保留原 23 项选择竞争，新嵌套项后 24 项 |
| `GIM_REQUIRE_SUBSTATION04=1 npm run test:substation:strict` | 最终 4 样本全部通过、零 skip，737.07 s；前次 210.64 s 的结果另保留，未拿它替代最终顺序断言 |
| `npm run build` | 通过，production Worker assets 正常打包 |
| `cargo check --manifest-path src-tauri/Cargo.toml` | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 缓存位置修复后 35 通过、0 失败、0 ignored，新增可信根路径测试，含 SQLite 原始行迁移/往返 |

最初默认并发的快速测试出现调度超时，限定 4 workers 的阶段曾通过。
最终两次 4-worker 复跑又出现新嵌套用例 5 s 超时，未结束任务影响后续相机断言；
单独运行该用例 1.36 s 通过，串行全量 31.29 s、788 项通过。
未提高测试 timeout、移除测试或弱化 SQLite 门禁。并发失败日志保留，不能抹去。

| 样本 | FAM 行 / 重复键 / 冲突 | root / unique DEV | PARTINDEX / 未关联 / 歧义 | 可达叶子 | complete / partial / empty / unsupported / failed |
|---|---|---|---|---:|---|
| 01 | 40867 / 6 / 6 | 285 / 285 | 3894 / 0 / 0 | 5938 | 204 / 81 / 0 / 0 / 0 |
| 02 | 22887 / 0 / 0 | 3326 / 976 | 1349 / 0 / 0 | 4346 | 371 / 50 / 547 / 8 / 0 |
| 03 | 26395 / 11 / 3 | 162 / 162 | 224 / 0 / 0 | 3126 | 83 / 79 / 0 / 0 / 0 |
| 04 | 6376 / 0 / 0 | 532 / 207 | 137 / 0 / 108 | 621 | 184 / 23 / 0 / 0 / 0 |

每个样本验证 raw → 真实 SQLite save/query/restore → Rust/TS 完整 instance key/matrix/color →
实际 GLB 恢复和一个真实损坏 DEV 的 raw fallback。03 的 45 个 GL sidecar 仍仅辅助来源，
不进入普通主几何链。状态来自编译诊断，unsupported 没有被改为空或伪造 complete。
gate 的 `visual:not-executed` 指自动门禁本身，桌面观察另表列出。

新增 Worker 生产链测试验证独立 input ownership、原 settings/runtime ID、真实模型登记、
逐文件失败隔离、工程取消，以及完整 Spatial graph/Map/属性/来源的传输等价。
Worker IPC 为可控依赖，这些测试不能替代真实 WebView Worker 和桌面持续响应测量。

持久化含义未改变：变电语义 v25、geometry v8-occurrence、Spatial parser contract 与 snapshot v2、
线路 v1、Fragments 版本全部保持，默认 Fragments 开关保持 OFF。没有按厂商、样本或文件名打业务补丁。
未扩展 primitive、GL 空间语义、InstancedMesh、歧义唯一化或新的缓存体系。

## 后续可重复验收步骤

最终 production 已通过真实 WebView/CDP 的 02/03 warm 和 04 嵌套补测；复用现有 monitor 与 native picker，
记录新的 EXE/source hash、WebView/profile 和默认 OFF、无 IFC 拦截。
将 02/03 已完成的语义/DEV 缓存作 warm，分别执行到 allIfc/fullModel 或固定 600 s 截止，
保留 1 s 心跳、trusted 输入、外部 process 内存。
加载期间用生产搜索入口选 A/B，待最新 request 的属性/高亮提交后检查 root；
重复点击只比较该 root 的 instance keys，而非后台增长的全站 group 数。
执行 03 `F2B6047C…`、04 `85401e77…` 和 empty 对象，随后另开一次明确取消的工程切换实验。
02/03 warm、04 nested 和单独取消旧工程的桌面补测已完成。
人为注入属性/几何慢 A 的桌面测试未执行，保留生产链 deferred 自动测试，
不把人工拦截混入默认完整路径。Fragments HIT 额外对照本轮未执行，默认 OFF 原始路径已实际测量。
尚未关闭的是 02 原始冷路径 >600 s、后续 DEV 编译阶段残余间隔，以及 03 冷路径持续响应阈值。
这轮后续修改是缓存位置和恢复顺序，未改变这些冷路径的前端编译行为；
最终 EXE 的全新空缓存冷路径未额外重跑，不能把 warm 通过外推为冷路径通过。
