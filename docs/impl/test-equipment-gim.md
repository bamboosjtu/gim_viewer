# 设备 GIM 支持与桌面 0.1.2 验证

日期：2026-10-26。

## 当前实现

独立设备根据唯一 `ENTITYNAME=Device` CBM 及有效 DEV 引用识别，不要求 `project.cbm` 或 IFC。支持 GIMPKGS 头和裸归档，压缩签名本身不决定业务类型；原生和浏览器都继续执行路径与资源配额检查。设备仍是浏览对象，不引入编辑功能。

入口位于 `gim/equipmentModel.ts`，装配沿既有 DEV→PHM→MOD/STL 引用链解析；设备根只生成一个几何 seed，DEV 子装配保留原路径和身份。UTF-8/GBK 语义文本在当前输入内兼容解码，磁盘源不改写。`services/equipmentRuntime.ts` 复用现有树、搜索、属性、DEV LOD、选择与释放机制；没有 IFC 时使用源 Z-up→Y-up 旋转，不等待 IFC 锚点。保留完整工程结构但没有 IFC 的包也可以启动 DEV 浏览。

设备重复打开复用同 SHA 的源解压清单和 LOD 派生产物，重新建立设备语义树，不写虚假的完整变电语义缓存标记。普通浏览保持 L0/L1，明确请求才生成 L2。全量语义缓存、IFC、线路和 Android 版本均未因桌面版本号变更而整体失效。

视觉核对发现旧 StretchedBody 解释会压短支柱：样本以 304.8 mm 表达一英尺方向基矢，另由 L 给出实际长度。统一位移函数现同时识别单位及一英尺方向，几何与目录范围共用该函数；其他非单位向量保留完整位移兼容解释。DEV 几何与相应目录键一起更新，具体当前版本只在[架构缓存域](../architecture.md#当前缓存域)维护。

桌面 npm、锁文件、Cargo 包与锁文件、Tauri 配置均为 0.1.2；Android 版本保持原值。源码版本升级和本地 Release 构建不代表已上传 GitHub 发布附件。

已生成生产 identifier 的 Portable ZIP：`desktop/src-tauri/target/release/bundle/portable/GIM-Reader_0.1.2_x64_portable.zip`，322,200,745 B，SHA256 为 `dcce9c2ab8cd14d859fcb228ca52dbb38eb3f6c9215ab49a2317adff02f0e3b2`。包内含 Fixed WebView2 Runtime，归档完整性检查通过。功能回归运行使用独立 identifier 的验收构建，未启动生产包读取日常数据库。

## 样本研究

输入身份、全量匿名清单、重复源口径、文件数量和设备/工程形态分别见[样本台账](../schema/sample-corpus.md)及其 CSV。分析包括容器签名、载荷位置、所有归档文件清单、CBM 入口，以及所有单入口设备的可达 DEV/PHM/MOD/STL 引用、矩阵、环与 XML grammar；原包 SHA 保持不变。

静态物理主链验证没有把 FAM 文件数、唯一 DEV 数、引用次数或几何 occurrence 混算。语义 FAM 的实际显示另通过中文属性检查；静态引用完整不代表全部图元都已渲染。大条目工程形态保留全量归档清单和 CBM 入口证据，没有以不完整解包目录宣称全图通过。

独立样本的可选电缆符号/集合记录不被补造为真实布线；原始记录与不支持状态保留，边界见[问题与限制](../open-issues.md)。

## 运行回归

最终浏览器验证使用独立 Headless Edge profile、Vite 与 WASM 解压，依次打开两份厂商设备、通用装配和混合 MOD/STL 装配，以及一个无 IFC 的工程层级包。五个输入均产生可见几何，设备四例的树选择均生成高亮；根设备及中文子装配、FAM 概览已截图核对。工程层级包保持工程类型，未被强制改成单入口设备。它们是功能验证，不是四站性能矩阵。

另在同一浏览器会话执行设备→line04→另一设备切换：线路地图正常进入，返回设备后重新显示设备类型、几何与选择属性，当前设备显示实例数为 1。记录为 `switching.log` 与对应 `browser-final-*` 目录。

原生验证采用隔离 identifier `com.bamboosjtu.gimviewer.acceptance` 的 Release，启动后实际核对 SQLite 数据根，使用同一 Fixed WebView2 155.0.4283.62。对 JW10-252、LW36-72.5 和一个通用装配各执行一次源/派生真冷打开和一次关闭后缓存重开：

| 输入 | 次数 | 首开 L0/L1/L2 冷编译 | 重开 L0/L1/L2 冷编译 | 重开 L0/L1 命中 | 显示/失败 | 树选中 |
|---|---:|---|---|---|---|---|
| JW10-252 | 冷/重开各 1 | 1/1/0 | 0/0/0 | 1/1 | 1/0 | 高亮、属性可用 |
| LW36-72.5 | 冷/重开各 1 | 1/1/0 | 0/0/0 | 1/1 | 1/0 | 高亮、属性可用 |
| 通用装配 equipment-generic-001 | 冷/重开各 1 | 1/1/0 | 0/0/0 | 1/1 | 1/0 | 根及子装配中文可用 |

六次均正常关闭，保存前确认基础表示及派生缓存写入结束。没有 IFC 的设备不要求 `allIfcReady` 标记，不把“没有 IFC”误判为超时；冷开/重开口径只指源与设备派生缓存，未宣称命中完整变电语义索引。记录的时间仅用于排查流程，不计入性能 SLO，执行期间另有兼容检查负载。

已有单元测试 130 个文件、1127 项通过、3 项既有跳过；针对设备入口、歧义引用、GBK、裸容器和拉伸体语义只扩展现有用例，没有新增仓库测试文件。原生容器测试 14 项通过，覆盖裸 7z 的 bytes/path 两种输入、裸 ZIP 及相同配额限制。四变电严格 SQLite/几何链回归 4 项通过，必需样本零跳过。

初次在系统 TEMP 构建/检查遇到本机临时文件“拒绝访问”；将 TEMP/TMP/SQLITE_TMPDIR 仅在对应进程中指向仓库 `.tmp/device-build-temp` 后重跑通过。没有为此修改业务判断、放宽断言或删除失败记录。

## 证据与适用范围

本轮原始证据位于 `output/device-gim/`：`inventory.json`、`device-static.json`、`stretched-body.json`、`references.log`、构建与测试日志；`browser-final-*/browser.json` 与截图记录实际界面；`native/*.json`、截图及 `native.log` 记录六次原生冷开/重开。构建清单为 `output/acceptance/builds/2026-10-26T13-59-22.183Z-25efba960b1e/acceptance-build.json`，包含完整源码指纹、EXE 哈希、提交及运行时身份。`final-audit.json` 核对最终产品源码指纹与验收构建一致、全部输入 SHA 未变、生产 ZIP 校验值与 0.1.2 包清单匹配；`portable-integrity.log` 为归档检查结果。

复核脚本放在忽略目录 `.tmp/device-gim/` 与 `desktop/.tmp/device-gim/`，不进入发布构建。未对全部设备逐个进行三维人工验收，未完成大条目设备库工程的性能/内存验收，也未重新完成四变电三次原生冷暖性能矩阵。此次交付证明设备打开、装配显示、选择属性及已验证样本的缓存恢复，不宣称全库图元或既有性能问题全部解决。
