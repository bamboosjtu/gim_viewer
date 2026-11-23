# GIM Viewer 文档

本目录是 GIM Viewer 的长期文档：只描述当前实现、当前契约和当前验收状态，不保存研究过程、历史方案或未复核推断。桌面版本 `0.2.5`，Android 线路版 `0.1.6 Preview`；版本以 `desktop/package.json` 和 `app/package.json` 为准。

文档以源码、测试和实际运行证据为准。研究材料在 `research/`，未关闭缺陷在[问题与限制](open-issues.md)，工程样本放在 `demo/`（不随仓库分发），性能输入登记在 [`benchmarks/`](../benchmarks/README.md)。

## 从这里开始

| 目标 | 先读 | 然后 |
|---|---|---|
| 了解桌面端能力与限制 | [桌面软件规格](software-spec.md) | [问题与限制](open-issues.md) |
| 了解 Android 线路端 | [移动端规格](mobile-spec.md) | [线路与移动端](architecture/line-mobile.md) |
| 调整布局、控件或界面反馈 | [桌面端 UI 规范](desktop-ui.md) / [移动端 UI 规范](mobile-ui.md) | [验证](validation.md) |
| 第一次接触代码库 | [系统架构](architecture.md) | [分层与依赖](architecture/layers.md) → [开发指南](development.md) |
| 改工程实体、目录或三视图 | [工程实体模型](engineering/README.md) | [实体与来源](engineering/entities.md) → [工程组成](engineering/composition.md) → [目录](engineering/catalogs/README.md) |
| 改 Parser 或格式契约 | [Parser](architecture/parser.md) | [Schema](schema/README.md) → [验证](validation.md) |
| 改 DEV/XML 几何 | [DEV 几何运行时](architecture/dev-geometry.md) | [XML primitive](schema/xml-primitives.md) → [几何模型](schema/geometry-model.md) |
| 改 IFC / Spatial | [IFC 运行时](architecture/ifc-runtime.md) | [语义模型](schema/semantic-model.md) → [缓存域](architecture/caches.md) |
| 改线路地图或 Android 线路语义 | [线路与移动端](architecture/line-mobile.md) | [线路 MOD](schema/powerline-mod.md) → [移动端规格](mobile-spec.md) |
| 改选择、高亮、属性面板 | [选择与交互](architecture/selection.md) | [表示与绑定](architecture/representations.md) |
| 修改可能影响性能的路径 | [性能门禁](performance/gates.md) | [性能测试指南](performance/guide.md)；不替代开发者本地实测 |
| 跑性能测试或本地 Benchmark | [性能测试指南](performance/guide.md) | [Benchmark CLI](performance/benchmark.md)；权威结果在本地 `tmp/` |
| 核对验证门禁与证据边界 | [验证](validation.md) | [开发指南](development.md) |
| 复核 GIM 格式与样本 | [Schema](schema/README.md) | [样本台账](schema/sample-corpus.md) |
| 查术语 | [术语表](glossary.md) | — |

## 文档目录

### 产品与验收

| 文档 | 维护内容 |
|---|---|
| [桌面软件规格](software-spec.md) | 用户可见的打开、三视图、三维、属性、地图与能力限制 |
| [移动端规格](mobile-spec.md) | Android 导入、树/地图、杆塔预览、隐私与验收口径 |
| [桌面端 UI 规范](desktop-ui.md) | Windows 工作台、三种工程模式、布局断点与 UI 复核 |
| [移动端 UI 规范](mobile-ui.md) | Android 地图工作区、响应式面板、安全区与沉浸地图 |
| [问题与限制](open-issues.md) | 唯一权威的未关闭缺陷与已接受限制 |
| [术语表](glossary.md) | 跨文档固定术语 |

### 架构

| 文档 | 维护内容 |
|---|---|
| [系统架构](architecture.md) | 系统边界、SDK 能力图、目录归属、运行时主干 |
| [分层与依赖](architecture/layers.md) | 运行面、目录所有权、依赖规则与边界检查 |
| [打开与生命周期](architecture/lifecycle.md) | 源身份、打开决策、会话取消、首开、关闭与失败 |
| [缓存域](architecture/caches.md) | 存储面、缓存版本、发布/恢复与失效规则 |
| [工程实体运行时](architecture/engineering-runtime.md) | 来源图 → 实体归一化 → 三视图的 Worker、缓存与状态 |
| [表示与绑定](architecture/representations.md) | 三层身份、来源 occurrence、表示索引与选择范围 |
| [DEV 几何运行时](architecture/dev-geometry.md) | DEV/PHM/MOD/STL 编译、放置、LOD、Worker 预算与缓存 |
| [IFC 运行时](architecture/ifc-runtime.md) | IFC 发现、空间语义、bim-lod、区域近景、连接构件 |
| [几何资产与表示索引](architecture/geometry-assets.md) | 模板复用、表示索引、分治预算与缓存层级 |
| [选择与交互](architecture/selection.md) | 选择请求、点击/拖拽、自动定位、高亮、隔离、视角历史 |
| [线路与移动端](architecture/line-mobile.md) | 线路运行时、共享 core 与 Android 边界 |
| [运行时与数据库模块](architecture/runtime-modules.md) | 大型服务与原生数据库模块的内部职责 |
| [测量与 Benchmark](architecture/measurement.md) | 测量协议、采集面、完整性口径与 SDK 前置门禁 |
| [平台、安全与发布](architecture/platform.md) | 安全边界、发布资产、配置开关、诊断与发布边界 |
| [Parser](architecture/parser.md) | 格式语法、原始值、诊断契约与宿主适配边界 |
| [Semantic Core](architecture/semantic.md) | 证据、上下文识别、归属与快照生成阶段 |

### 工程领域

| 文档 | 维护内容 |
|---|---|
| [工程实体模型](engineering/README.md) | 领域原则与文档分工 |
| [实体与来源模型](engineering/entities.md) | 来源图、对象证据、角色、整体/待归集合、归一化顺序 |
| [工程组成与三视图](engineering/composition.md) | 组成模板、分配规则、来源树、JSON 导出 |
| [建筑推断](engineering/building-inference.md) | 建筑/楼层/房间的名称与空间证据 |
| [空间推断](engineering/spatial-inference.md) | 轮廓、区域、防火墙阈值与失败条件 |
| [目录总则](engineering/catalogs/README.md) | 分类优先级、目录版本、未知/冲突处理 |
| [设备目录](engineering/catalogs/equipment.md) / [装置性材料](engineering/catalogs/materials.md) / [构件](engineering/catalogs/components.md) | E/M/C 类别、粒度与跨目录边界 |
| [机器目录索引](engineering/catalogs/catalog-index.md) | 由 `catalog.json` 生成的全量编码表，不手工编辑 |

### GIM 格式

| 文档 | 维护内容 |
|---|---|
| [Schema](schema/README.md) | 格式文档导航、复核顺序与实现边界 |
| [样本台账](schema/sample-corpus.md) | 唯一权威的样本 ID、SHA、容器、文件与对象统计 |
| [容器与文件角色](schema/container.md) | magic、压缩载荷、编码、条目解析与文件类型 |
| [语义模型](schema/semantic-model.md) | CBM/FAM、层级、引用、线路 CROSS 与 IFC 证据等级 |
| [几何模型](schema/geometry-model.md) | DEV/PHM、模板与 occurrence、矩阵、单位、颜色、STL/GL |
| [变电 XML MOD](schema/substation-mod.md) / [XML primitive](schema/xml-primitives.md) | XML grammar 与已实现 primitive 的字段、近似和限制 |
| [线路文本 MOD](schema/powerline-mod.md) | 四类文本 grammar、HNum、WIRE 与挂点 |
| [逻辑模型](schema/logical-model.md) | SCH、STD 内容变型、SLD 与关联边界 |

### 开发、验证与性能

| 文档 | 维护内容 |
|---|---|
| [开发指南](development.md) | 环境、命令、工作区、运行时资产、文档维护 |
| [验证](validation.md) | 证据分层、必须成立的不变量、自动门禁、真实复核与覆盖率 |
| [性能测试指南](performance/guide.md) | 怎么测：测量定义、冷/暖步骤、手工与 CLI 路线 |
| [Benchmark CLI](performance/benchmark.md) | 批量 CLI、子命令、注册表、报告、Trace/Profile 与状态/退出码 |
| [性能门禁](performance/gates.md) | 打开、来源、几何、缓存、投影、交互和测量的审查规则 |
| [性能经验索引](performance/README.md) | 每方向一页的保留做法、失败反例、结构/计数检查 |

## 仓库内其他文档

| 文档 | 用途 |
|---|---|
| [根 README](../README.md) | 下载、安装、桌面开发入口 |
| [AGENTS.md](../AGENTS.md) | 编码助手的工作约定与边界 |
| [benchmarks/README](../benchmarks/README.md) | L0/L1/L2 样本登记与批次命令示例 |
| [desktop/local-tests/README](../desktop/local-tests/README.md) | 开发者本地验收注册表 |
| [desktop/scripts/benchmarks/README](../desktop/scripts/benchmarks/README.md) | Benchmark 工具目录说明 |
| [app/README](../app/README.md) | Android 构建、密钥与存储 |
| [tools/README](../tools/README.md) | 独立 Python 工具的运行与打包 |
| [`.agents/skills`](../.agents/skills/) | 可复用的样本复核等工作流 |

## 单一权威

同一事实只在一处维护，其他文档引用而不复制：

| 事实 | 权威位置 |
|---|---|
| 缓存域版本与失效范围 | [缓存域](architecture/caches.md) |
| 样本身份、SHA 与统计 | [样本台账](schema/sample-corpus.md) |
| 未关闭缺陷与已接受限制 | [问题与限制](open-issues.md) |
| 界面结构、视觉样式与响应式布局 | [桌面端 UI 规范](desktop-ui.md)、[移动端 UI 规范](mobile-ui.md) |
| 性能测量方法与 CLI | [性能测试指南](performance/guide.md)、[Benchmark CLI](performance/benchmark.md) |
| 性能接受与基线批准 | 开发者本地 `tmp/gim-bench/` 报告；Agent 不自动批准 |
| 命令与工作区约定 | [开发指南](development.md) |
| 验证证据规则 | [验证](validation.md) |
| 实体目录维护源与运行时配置 | [实体索引表](engineering/catalogs/变电三维设计建模规范_实体索引表.xlsx)；由维护导入器生成 JSON 配置 |
| 术语定义 | [术语表](glossary.md) |

## 写作与维护

1. **每页先说明范围。** 首段回答“本页覆盖什么、不覆盖什么”，并链接相邻文档。
2. **标题不写序号。** 二级标题用名词短语，靠目录和锚点导航。
3. **长页给目录。** 二级标题较多或需要跨节跳转的页面，在开头放 `## 目录`。
4. **事实与边界分开。** 当前行为、证据范围、未实现/未验收分别表述；不把研究候选、计划或历史方案写成当前能力。
5. **数字只写权威处。** 阈值、版本、样本数在权威文档维护，其他文档引用而不复制。
6. **匿名化。** `docs/schema/` 只使用匿名样本 ID；其他目录不写真实工程名、地理归属、建设单位或内部工程标识。
7. **链接用相对路径。** 仓库内链接相对当前文件；外部资料用完整 URL 并注明用途。
8. **同一事实只维护一处。** 架构变化更新对应 `architecture/` 页；目录变化更新 `engineering/catalogs/`；格式变化更新 `schema/`；性能口径更新 `performance/`。

Markdown 文档不作为 CI 测试输入；事实正确性仍需对照源码与运行证据。机器目录索引在 `desktop/` 下执行：

```powershell
npm run check:engineering-catalog
```
