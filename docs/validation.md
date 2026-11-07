# 正确性与验证

本文件维护**正确性门禁、验证边界和证据记录规则**，不重复实现机制或性能数字：

- 当前实现机制见[架构索引](architecture.md)及各主题文档；
- 工程实体、三视图和目录见[工程实体模型](engineering/README.md)；
- 性能 SLO 与实测见 [性能](performance.md)；
- 未关闭缺陷与已接受限制见 [问题与限制](open-issues.md)；
- 样本身份/格式统计见 [样本台账](schema/sample-corpus.md)；

测试临时输入、输出、子进程 TEMP/TMP/TMPDIR 统一使用工作区 `.tmp/` 或 `desktop/.tmp-vitest/`，禁止访问系统目录作为测试数据或清理目标。Node 测试入口通过工作区临时目录启动器运行，Rust 测试从编译期工作区路径取得临时目录。

测试集和对照基线由开发者自行构建。远程 CI 仅运行不依赖工程样本的单元测试、静态检查和构建；真实与合成工程样本、九工程对照和性能矩阵均不纳入 CI。`performance.md` 只描述作者的本地结果，不能将缺样本跳过或单元测试通过表述为复杂工程验收通过。

## 1. 证据边界

源包事实、当前源码、自动测试、真实桌面/移动交互是不同证据层：

| 证据 | 能证明 | 不能证明 |
|---|---|---|
| 源包 SHA/清单/解包 | 输入身份、条目与引用存在 | 场景可达、渲染正确 |
| 单元/集成测试 | 代码契约、边界与竞态 | 真实 WebView、GPU、完整样本 |
| 真实桌面交互 | 当前构建的打开、选择、缓存、坐标 | 其他机器/其他包、长期稳定性 |
| 性能计时 | 指定输入/构件的耗时 | 不同工作量或不同构建的“提速” |

同一结论必须注明输入身份、构建、缓存状态与操作路径；不能用不同构建或不同工作量的成功结果互相替代。

## 2. 必须成立的不变量

| 主题 | 检查要求 |
|---|---|
| 源身份 | magic 决定类型；源改变拒绝继续；源 SHA 与缓存一致 |
| 路径 | 大小写、分隔符兼容；全局 resolver；唯一候选才挂接 |
| FAM | 原文/行号可追溯；重复行不丢；单值视图与原记录分离 |
| PARTINDEX | 按 DEV 身份关联；限制父装配子树；歧义保留；不增加 seed |
| 工程来源 | 从实际文件/CBM/DEV/IFC 建图；不接收旧展示树；缺条目/歧义/循环保留；来源完整性可核对 |
| 工程整体 | 身份不使用 F2/F3/F4、展示名、数组顺序或 Mesh；每份来源唯一主归属；未知/待归保留 |
| 表示绑定 | 按来源 ID 绑定；同名/同模板/邻近不补造；粗表示跨整体时 ambiguous；变量替换不改变选择身份 |
| 三视图 | 清册/组成/来源覆盖整体与对应来源；清册按类别、子类、名称模板分组且不合并同名实例；分组计数按实体去重；来源可追溯整体；空声明组不伪造成员 |
| 点击/拖拽 | 左键单击才选择；移动 >5 px 不选；三维点击不自动定位；相机手势不产生选择请求 |
| 递归装配 | PHM→PHM 可达；逐边矩阵；分支防环；合法重复路径保留 |
| 模板共享 | clean DEV 解析数接近 unique DEV；placement 不修改共享 geometry |
| 变换 | 非单位阵、旋转、缩放、镜像与深层路径保持；单位/轴转换只应用一次 |
| 缓存几何 | 冷/暖/raw fallback 同引用语义；坏 GLB 局部回退；失败不写完整标记 |
| IFC 顺序 | 首个 anchor 一致；模型数量、GUID 与 IFC/MOD 相对位置一致 |
| Spatial | hit 不重扫 STEP；坏 snapshot 拒绝；nodes/objects/links/placement/source 等价 |
| 选择 | 慢 A/快 B 后属性、高亮、相机、树全部属于 B；重复 B 不新增 occurrence |
| 视角历史 | 返回前结算待记录移动；失败保留历史；代次拒绝旧完成；取消后不跳回旧目的地 |
| 静态容器 | 每帧不重算静态子树；动态对象、重挂载与显式锚点更新仍传播世界矩阵 |
| 缓存视图 | 借用视图只在同一次同步解包内；返回缓冲独立、偏移为 0，不引用相邻条目 |
| 工程切换 | A 未完成时切 B：A 的 worker、slice、恢复结果不提交 B |
| 线路图 | 唯一路径节点与引用边分开；共享边界塔不丢；同塔跳线不当跨塔档 |
| 安全 | SLD 禁执行/外部资源；解压配额；异常局部来源隔离 |

## 3. 自动验证

```powershell
cd desktop
npm test                 # 快速单元测试（不启动 Cargo）
npm run test:sqlite      # 真实 SQLite 集成：构建一次，直接运行 harness
npm run test:sample      # 真实样本回归（缺样本时可跳过，skip 不算通过）
npm run test:engineering:nine   # 九工程来源/实体/投影严格对照
npm run test:engineering:worker # 真实 Worker/Blob/缓存/取消（headless Edge）
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

工程实体基线先准备独立参考和几何输入：

```powershell
npm run engineering:baseline
npm run engineering:geometry-input
npm run test:engineering:nine
```

`engineering:baseline`/`geometry-input` 依赖本地 `research/` 和样本；缺少必需输入应失败，不能用旧输出或跳过冒充复跑。`test:engineering:worker` 是功能夹具，不替代原生 IPC、真实渲染或性能验收。

SQLite 集成测试独立于单元测试和样本回归，Windows CI 必须单独执行 `test:sqlite`。准备阶段最多 10 分钟，通过 Cargo JSON 产物消息取得本次测试程序；每次 SQLite 执行最多 30 秒，外层测试最多 60 秒。输入、输出和临时 SQLite 文件位于已忽略的 `desktop/.tmp-vitest/sqlite/`，每次调用独立目录，进程退出后清理。

按改动选择更窄的门禁：

- IFC 加载/转换：`npm run test:ifc-critical`；
- 静态容器矩阵：`src/viewer/__tests__/staticContainer.test.ts`；
- 视角历史：`src/viewer/__tests__/viewHistory.test.ts` 与 `src/ui/__tests__/viewHistoryFeedback.test.ts`；
- 原生批读/GIMR 协议：`bridge/__tests__/devLodCache.test.ts`、`devLodNativeBatch.test.ts`、`database.test.ts`；
- DEV 几何/缓存/选择：`devGeometryWorkerClient`、`devLodRuntime`、`devGlbTemplateRuntime`、`xmlModGeometry` 对应测试；
- 真实几何门禁：`GIM_VERIFY_SUBSTATION01=1` 后运行 `devGeometryGate.test.ts --maxWorkers=1 --minWorkers=1`；
- 严格变电样本：`GIM_REQUIRE_SUBSTATION04=1 npm run test:substation:strict`，缺样本必须失败，不能 skip 通过。

样本解包（只读检查前置）：

```powershell
python desktop/scripts/gim_survey/extract_inventory.py --samples demo-substation substation02 substation03 substation04 --extract-only
```

### 九工程归一化研究

研究阶段对九个变电包做过全量来源扫描和独立归一化（不调用产品业务树、粒度判定或渲染结果）。方法边界：

- 输入为 s01–s04、a31、b11–b14；只读源 ID、原始名称/类型、属性原行、实际父引用、GUID 和来源路径，忽略扫描快照中的既有分类列。
- F2/F3/F4 标签、当前软件节点层级不参与整体边界；IFC 内部类型不新建工程对象。
- 先解释当前对象角色（整体/内部件/独立功能/装置拆件/来源诊断），再按共同工程标识、编号名称和兼容签名跨平级来源归一；不足时进入待归集合。
- 每份来源恰有一个主去向：整体、待归集合或仅来源；内部件不要求细分类，来源必须守恒。
- 组织等价性测试改变输入顺序、包装层、F 层级和设计拆分深度，整体集合应保持一致；粗模型没有装配边时不能补造配件。

研究阶段得到的关键判断（不是当前工程台套真值）：

| 场景 | 结论 |
|---|---|
| 局部 FAM 借用上级名称 | 在线监测仪、放电间隙、电动机构等先判当前对象角色，12 个来源未被中性点装置吞并。 |
| 单相本体成组 | 明确主变编号 + 单相证据可组成一个工程主变；本体数、相别完整性另存，不按“三份”机械拆组。 |
| 跨平级 CBM 成套 | 共同工程编码 + 编号名称 + 兼容装置签名可建立声明整体；泛称“接地变”仍聚为待确认集合。 |
| 组件级歧义 | 候选都落在同一整体时可在整体层挂属性；不按数组下标强配零件，跨整体歧义保留。 |
| 装配内配件 | 真实 DEV 装配边内的端子箱、机构箱、散热器等归宿主；无装配边的独立安装对象才另建整体。 |

研究阶段的整体候选数、未知类别数和待归集合数记录在 `research/data/engineering-wholes/`，只作研究台账，不是当前产品计数或验收期望。当前回归以 `npm run test:engineering:nine` 和实体/投影测试为准；没有人工逐台套真值时，不宣称归属准确率。

## 4. 真实桌面复核

固定提交、源 SHA、EXE/资产哈希、WebView 环境和缓存初始状态，通过生产入口操作，不暂停解析/编译。

变电至少覆盖：

- 一个物理根、PARTINDEX、嵌套装配、IFC 关联对象的来源/属性/高亮/相机终态；
- A→B、重复 B、搜索、关闭、同进程重开；
- 工程组成/来源切换、来源→整体、分组选择、待归集合、粗表示歧义；
- 自动定位开/关、树/搜索定位、三维单击不移动相机、拖拽超过 5 px 不选择、Esc 清除/恢复；
- 冷/暖的根数、unique DEV、occurrence、几何状态、IFC 顺序与空间索引；
- 默认显示不先点树，覆盖已知/未知范围、视野内外、选择/取消、远近切换、失败重试、坏缓存局部修复。

线路至少覆盖：六包根/F2/F3、共享塔位、WIRE/CROSS、塔形预览、搜索、树↔图、缺文件降级；原属性长度与几何长度分列。

性能验收必须同时记录 First usable / Current view settled / 基础表示完成 三个 SLO，不能只报首屏；浏览器开发模式与 Release/WebView2 结果分开报告。

当前已覆盖：

- `npm run test:engineering:separation` 直接读取四个在册变电包及具有匹配 SHA 标记的解包目录，验证来源分区、三视图覆盖、组织声明变更和输入顺序不影响实体、几何 occurrence 不变，并对 s04 执行来源/实体/导航三域往返。缺样本直接失败，结果写入 `output/v020-stage1/sample-separation.json`；不证明实体人工金标准或原生渲染；
- 九工程入口的研究台账守恒、固定案例与来源扫描对照属于不同验收项；旧输出与当前 parser/规则指纹不一致时不能作为本版通过证据。完整实体/成员/投影金标准尚待建立；
- 生产构建的真实浏览器操作覆盖工程组成/来源、搜索、显隐、精化和工程切换；真实桌面原生操作、完整九工程路线与性能矩阵仍未齐备；
- 旧 0.1.x 九站冷/暖基线（见[性能](performance.md)）只证明旧构建，不能替代 v0.2 工程实体/三视图链路的原生性能；
- `substation01`–`substation04` 的选择隔离、L2 精化、空间语义与严格 SQLite/几何链；
- 设备样本的源/派生冷开与缓存重开、树/属性/选择、设备→线路→设备切换；
- 线路六包地图、导航、搜索和导出；
- 零 GUID、坏矩阵、异常范围、坏缓存与迟到结果的隔离路径。

未覆盖：v0.2 原生三次真冷/有效暖、完整集合选择与持续交互、设备全库逐个人工显示、大条目设备库性能/内存、自动 L1 与增量连接线的完整组合边界、逐台套人工归属真值。具体未关闭项见 [问题与限制](open-issues.md)。

分类/清册验收使用 `npm run test:engineering:classification`，四包直接走当前来源适配和实体归一化，核对目录编码、子类、来源分区、三模板版本及缓存往返；输出独立写入 `output/v020-stage2`。`npm run check:engineering-catalog -- --python` 检查共享目录与参考工具标签一致，不能证明两者归并策略一致。模板测试单独检查组成路径变化不影响清册/来源、清册使用自己的搜索索引、同名实例不合并。完整九工程人工实体边界真值仍未建立。

## 5. 移动端验证

在 `app/` 运行 `npm test`、`npm run build`；样本测试先准备本地输入，缺包不允许 skip。覆盖唯一对象、共享塔 occurrence、物理档聚合、跳线排除、完整树可达、原始属性与 HNum 预览、JSON 恢复等价。

原生存储门禁：

```powershell
cargo test --manifest-path crates/gim-native-core/Cargo.toml
cargo test --manifest-path app/src-tauri/Cargo.toml --lib
cargo test --manifest-path app/src-tauri/Cargo.toml six_native_imports -- --ignored --nocapture
```

最后一条必须实际执行并报告零 skip。Android 还需在指定 API/WebView/设备上验证 SAF 导入、权限/定位拒绝、折叠屏与沉浸模式；模拟器数据不能替代真机性能承诺。

## 6. 证据记录

每个结果记录：输入身份、构建/提交、命令或操作、通过/失败/跳过数、环境、输出位置和边界。截图只证明可见状态；结束码、JSON 可解析、缓存命中或阶段完成都不能单独证明语义正确。

不得：

- 把 skip 计入通过；
- 把旧构建的结论用于当前构建；
- 用自动居中/整体偏移掩盖坐标问题；
- 用 draw calls 降低代替对象覆盖/坐标验证；
- 把 Worker 墙钟当 CPU 时间，或把工作量变化当单模板提速。

可重复运行材料独立保存，不追加为正文流水。


## 纯逻辑质量门禁

远程 CI 的覆盖率只来自不依赖工程样本的单元测试。`npm run test:coverage` 对 `engineering/` 执行行/语句/函数 95%、分支 90% 下限；对 `gim/` 执行行/语句/函数 90%、分支 80% 下限。其余层报告覆盖率，不自动提高或更新阈值；该门禁不代表真实工程或原生性能通过。

Python 工具的 `tests/test_pure.py` 只检查普通值的矩阵、文本、编码等契约。CI 显式按此文件名执行，不能改成不加过滤的 discover：原有 `test_core.py` 与指针/UI 测试含模型目录或归档构造，应由开发者在工作区本地运行。

静态 CSS 类承载属性诊断和搜索副标题；主文档 CSP 仍兼容现有运行时样式。大量 CSSOM `cssText`、第三方视图组件及 SLD 的独立 SVG 样式需要完整兼容验证，因此移除少数 HTML style 属性不等于可以直接删 `unsafe-inline`。约束依据见 [MDN style-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/style-src)；收紧策略需逐项迁移运行时样式并验证地图、SLD 与 Viewer。
