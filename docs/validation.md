# 正确性与验证

验证区分源包事实、源码契约、自动测试、真实桌面交互。每种证据只支持相应范围。 当前可用复核覆盖十个包的身份、文件清单与相关源码契约，未形成当前构建的完整运行门禁结果。 本文件说明各项验证的范围与完成条件；未关闭的代码缺陷与实现风险见 [未决事项](open-issues.md)。

## 当前复核范围

| 范围 | 当前证据 | 结论边界 |
|---|---|---|
| 十包源身份、magic、payload 和清单 | 实际包 SHA、归档文件清单 | 统计限于在册包 |
| 六线路 F2/FAM 原属性 | 从源包读取 CBM/FAM | 不代表设计长度或几何测量 |
| 变电嵌套 PHM、矩阵、PARTINDEX | 解包目录与原始引用 | 全文件扫描不等于场景可达实例 |
| 当前 parser/cache/worker/选择逻辑 | 当前源码 | 机制存在不等于真实运行全部通过 |
| 当前构建端到端和几何等价 | 尚无完整当前验收 | 不能沿用不同构建的成功结论 |

源身份与统计详见 [样本台账](schema/sample-corpus.md)。

## 必须成立的不变量

| 主题 | 检查要求 |
|---|---|
| 源身份 | magic 决定类型；源改变拒绝继续；源 SHA 与缓存一致 |
| 路径 | 大小写、分隔符兼容；全局 resolver；唯一候选才挂接 |
| FAM | 原文和行号可追溯；重复行不丢；单值视图与原记录分开 |
| PARTINDEX | 按 DEV 身份关联；限制父装配子树；歧义保留；不增加 seed |
| 递归装配 | PHM→PHM 可达；逐边矩阵；分支防环；合法重复路径保留 |
| 模板共享 | clean DEV 解析数接近 unique DEV；placement 不修改共享 geometry |
| 变换 | 非单位阵、旋转、缩放、镜像与深层路径保持；单位/轴转换只应用一次 |
| 缓存几何 | 冷/暖/raw fallback 同引用语义；坏 GLB 局部回退；不以失败写完整标记 |
| IFC 顺序 | 首个 anchor 一致；模型数量、GUID 和 IFC/MOD 相对位置一致 |
| Spatial | hit 不重扫 STEP；坏 snapshot 拒绝；nodes/objects/links/placement/source 等价 |
| 选择 | 慢 A/快 B 后属性、高亮、相机、树全部属于 B；重复 B 不新增 occurrence |
| 工程切换 | A 未完成转换时切换 B；A 的 worker、slice、恢复结果不提交 B |
| 线路图 | 唯一路径节点与引用边分开；共享边界塔不丢；同塔跳线不当跨塔档 |
| 安全 | SLD 禁执行/外部资源；解压配额；异常局部来源隔离 |

## 自动验证命令

从仓库根进入 `desktop/`：

```powershell
cd desktop
npm test
npm run test:sample
$env:GIM_REQUIRE_SUBSTATION04 = '1'
npm run test:substation:strict
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

`test:sample` 在缺失本地样本时可跳过；skip 不能算样本通过。
日常 IFC 加载改动使用 `npm run test:ifc-critical`，覆盖转换所有权、工程切换、缓存回退、名称补全、磁盘文件边界、关系记录扫描、区域/孔截面判定、0.0.78 流式接口兼容及产品细节控件。保留关键契约，不用全站样本回归替代单文件性能对照。

单模型复用还须验证源字节和坐标设置一致、借用方不能提前释放所有者、异常后 API 方法恢复，以及归一化包围盒只还原一次。真实单文件复核比较远景对象数、完整区域索引、GlobalId/ExpressId、近景紧固件覆盖、源属性和缓存路径；浏览器证据与 Portable 包启动证据分别记录。

设备变更使用 `vitest run src/services/__tests__/devGeometryWorkerClient.test.ts src/services/__tests__/devLodRuntime.test.ts src/services/__tests__/coordinateAlignmentService.test.ts src/services/__tests__/devGlbTemplateRuntime.test.ts src/viewer/__tests__/xmlModGeometry.test.ts` 验证并发配额、导出结果背压、模板去重、选择优先级、工程取消及占位协调矩阵竞态。真实几何门禁在 `desktop/` 设置 `$env:GIM_VERIFY_SUBSTATION01='1'` 后运行 `vitest run src/services/__tests__/devGeometryGate.test.ts --maxWorkers=1 --minWorkers=1`，覆盖主变、出线间隔和冷暖 occurrence 集合；另设 `$env:GIM_VERIFY_SUBSTATION02_LOCAL='1'`，同一门禁只读取该样本本体和散热器的两个真实 MOD，核对拉伸端点、解析范围和 LOD0/2 可见实体覆盖，不启动全站 IFC。未启用的 skip 不算样本通过。参考程序的平铺键表、递归深度和独立居中需先与原始分节及装配引用核对，不能为了匹配参考图而改动生产坐标。

桌面场景必须在独立缓存中覆盖冷编译、新进程暖启动、同进程关闭重开和同模板不同位置。记录源 SHA、DEV、instanceKey、同档位模板 SHA/局部包围盒、CBM 矩阵、首个 IFC、工程矩阵、世界包围盒和代表点；冷暖代表点误差 ≤0.1 mm，核心几何关键点误差 ≤1 mm，整机包围盒分段误差 ≤10 mm。核对 IFC 对象的 GlobalId、实际世界包围盒及相邻设备中心差，不用自动居中或整体偏移遮掩问题。

默认显示验证不先点击工程树，覆盖已知及未知范围、视野内外、选择和取消选择、远近切换、失败重试、坏缓存局部修复及工程切换。状态栏的就绪、目录、编译、命中和失败计数应与诊断一致，基础或 partial 表示不能冒充完整几何。性能对照固定同源、同进程启动方式和相机路线，各运行两次基线及修复后的空缓存；另列缓存回退、CPU 竞争和峰值内存，不把 Worker 墙钟当 CPU 时间，不把工作量变化当单模板提速。

近景实例化检查共享模板、实例槽变化后的身份、单对象高亮、返回远景的释放及镜像回退。构件数量、实例数量、模板数量和绘制提交数分别记录，不能用 draw calls 降低代替对象覆盖或坐标验证。

设备 LOD 分级须按 DEV 核对 0/1/2 的切换条件与粘滞行为、选中强制 2、视野外仍提交 LOD0 基础表示；核对模板键包含源身份、DEV 路径与 LOD 级别，128 MiB LRU 淘汰后能正确重编译；核对工作闸允许最多一个 IFC WASM 任务与两个 DEV 工作单元并行，且模板编译不等待坐标锚点。分级只改变表示精度，occurrence 身份、选择身份、语义层级与冷/暖坐标必须保持一致，不能以 LOD 切换生效替代显示正确性。
`npm test` 不包含默认关闭的 IFC Preview/单对象精化实验；修改这些实验时使用 `npm run test:experimental`。
真实 Preview 样本仍由 `test:ifc-preview:sample` 单独执行。`test:sample` 只运行真实样本回归，桥接测试由默认入口维护，避免 `test:all` 重复执行。 严格变电门禁要求其配置的样本，使用上述环境变量要求 substation04；`GIM_SAMPLE_ROOT` 可指定另一样本根。样本目录名称和别名见 [台账](schema/sample-corpus.md)。 命令的覆盖与策略以 [严格门禁脚本](../desktop/scripts/test-substation-strict.mjs) 为准。

需要准备解包样本时，从仓库根运行：

```powershell
python desktop/scripts/gim_survey/extract_inventory.py --samples demo-substation substation02 substation03 substation04 --extract-only
```

该命令会写解包目录，不属于只读检查；检查已有目录和源包身份后再使用。 静态分析方法与脚本输出边界见 [Schema 复核入口](schema/README.md)。

## 真实桌面复核

固定源码提交、源 SHA、EXE/资产哈希、WebView 环境与缓存初始状态。 通过生产打开入口连续加载，不设置断点暂停解析、设备编译或 IFC 读取。

变电选择一个物理根、其 PARTINDEX、嵌套装配与具有 IFC 关联的对象，检查来源、属性、高亮范围和相机最终状态。制造慢 A/快 B 的受控测试必须与默认运行分开记录；真实点击还需覆盖 A→B、重复 B、搜索、切换工程和关闭。

冷/暖比较覆盖根数、unique DEV、occurrence 路径、几何状态、有效 alias/歧义数量、IFC 插入顺序和空间索引结构。anchor 等价不能代替全几何顶点或变换等价。

线路按六包检查根、F2/F3、共享塔位、WIRE 与 CROSS 关系、塔形预览、搜索、树↔图、空值和缺文件降级；原属性长度与几何长度分列。

跨越分类需核对六包全部 2,159 个实际 CROSS 与自身 FAM 来源，逐包七类分布与台账一致；铁路空接触网高、空英文键但有展示标签、公路车道数、河流通航、电缆最简键族均纳入检查。通用 DEV/MOD/CODE 和属性值不得判型；未命中、不同 FAM 拼接、多个键族冲突、CBM/DEV 同名 FAM 和全局歧义均须有回归。验证序列化恢复等价、旧语义契约自动重建且源包保留；浏览器类型筛选、普通/沉浸概览字段一致及窄屏单列分别检查。桌面树以既有跨越分组汇总叶类型，与移动端叶对象计数分开。

## 移动端验证

在 `app/` 运行 `npm test`、`npm run build`；先用
`python scripts/prepare-samples.py` 从六个原包准备忽略目录中的文本输入，再运行`npm run test:sample`。六样本测试不允许缺包跳过，检查唯一对象、共享塔 occurrence、物理档聚合、跳线排除、完整树可达、原始属性与 HNum 预览，以及 JSON 恢复等价。

从仓库根执行原生存储门禁：

```powershell
cargo test --manifest-path crates/gim-native-core/Cargo.toml
cargo test --manifest-path app/src-tauri/Cargo.toml --lib
cargo test --manifest-path app/src-tauri/Cargo.toml six_native_imports -- --ignored --nocapture
```

最后一条是需要真实源包而显式启用的六包测试，必须实际执行并报告零 skip。 检查源身份、有界解压、空 7z 文件、SQLite、重复导入与删除；常规存储单测另覆盖取消清理、路径限制、语义身份拒绝、有效缓存下源 magic/大小/SHA 改变的拒绝，及损坏数据库由校验后的原包重建。

Android 使用同一 APK，通过系统 DocumentsUI 选择 `.gim`，核对私有工程目录、metadata、源 SHA、语义计数和 UI 来源。API 36 模拟器已完成六包 SAF 导入；P8/LM 的来源、精确前台权限与模拟定位、受控定位超时/系统关闭/后台取消、大屏尺寸切换、系统返回及受控底图回退具有交互证据。签名 Release APK 另检查启动、恢复和 SAF 重复输入，不能用未开启 R8 的诊断构建代替发布配置检查。

浏览器预览另检查手机/展开布局、真实底图、虚拟树末端搜索、属性和塔形。

API 29 的原装 WebView 74 单独检查普通 Worker、二维瓦片、line04/line02 SAF 与缓存、P8 HNum、窗口变化和定位权限拒绝。诊断构建用于结构断言，最终签名 Release 另检查原生闭环。

API 36 Pixel Fold profile 使用模拟器真实 fold/unfold 和 user-rotation 命令，核验内外显示切换，比较同一工程的相机、选择、树展开与页签；截图明确指定活动物理显示。低高度横屏另检查详情页签及内容滚动区可达，fit/zoom 按钮不重叠。普通 `wm size` 调整不等同于这一检查。

面板检查覆盖窄屏、展开屏、三栏和低高度横屏的四种开关组合：工程树/详情独立关闭、重新打开与“地图”同时收起，关闭后地图占满释放区域，相机/选择/页签保持，重开工程恢复偏好。

密钥检查覆盖新安装空值、旧设置清除、新版手动输入保存/重启/清空；发布 APK 的每个解压条目和两架构原生库扫描开发 key，不输出 key 正文。浏览器开发预览的 `.env` 入口仅存在于 Vite dev。

窗口检查要求 WebView 和 `#app` 填满窗口、全局 padding 为零，状态栏安全区只保护 Header 内容，导航栏安全区只保护底部控件。API 29 / WebView 74 与 API 36 折叠屏分别检查横竖屏、内外屏、完整工程范围与沉浸按钮的独立点击、全屏地图边界、原生返回、设置页退出和前后台恢复。

系统边缘滑动还需用原生窗口状态确认 transient bars 显示及自动消失；只改变 CSS 不算原生沉浸通过。

受控丢失一次 Insets 事件后，检查前台刷新恢复安全区；过期异步结果不得覆盖较新的原生事件。

旧 WebView 不支持 CSS `max()` / `dvh`，控件安全间距和窗口高度回退也须实测。

方向策略按当前最小屏宽检查：手机与折叠外屏在旋转请求后仍保持竖屏，展开屏/平板恢复旋转；覆盖展开→闭合→展开与沉浸状态切换，不能只按横屏的当前宽度识别窄屏。

沉浸概览须通过实际地图点选杆塔、档与跨越物核对字段，检查关闭、重新点选、滚动、进入详情、返回及相机/面板状态保持，浮层与全屏/缩放控件不重叠，旧 WebView 的文本与按钮可达。

HNum 预览须覆盖 P 分散于多个 Body、R 集中于文件尾部的来源，核对完整杆件数、塔头两侧和顶端范围；重复点号必须保持 Body 隔离。升级检查旧预览缓存被新版本重建，同时语义缓存和工程身份保留；不能仅以存在一条线或第一基塔可预览作为完整性通过。

工程根节点检查概览、属性和来源中的 GIM 头部字段，按原包字节和编码核对工程名称、设计单位、导出软件、时间与标准信息，同时核对源 SHA。无法确认角色的单位保留原值，未知布局保留原始文本，不把已知样本的偏移约定套到其他布局，也不要求清除现有语义缓存才能展示头部。

模拟位置、尺寸调整和 Windows 存储测试只支持相应功能，不能替代真实 GNSS、X Fold5 内外屏或性能验收。设备错误路径与最终发布门禁按本节条件在本文件核验；移动端未关闭的代码缺陷见 [未决事项](open-issues.md)。

## 证据记录

每个结果记录输入身份、命令/操作、实际通过/失败/跳过项、运行环境、输出位置和边界。截图只支持可见状态，结构断言需要对象与来源记录。结束码、有效 JSON、缓存命中或模型阶段完成本身不能证明语义正确。

文档维护检查包括 Markdown 链接和锚点、源码路径、匿名化、当前版本唯一性、事项归档边界及原始样本/研究资产哈希。可重复运行材料独立保存，不追加为正文流水。
