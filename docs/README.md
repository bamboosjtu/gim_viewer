# GIM Viewer 文档

本文档库存放当前实现的产品行为、架构契约、工程实体规则、GIM 格式和验证边界。当前桌面版本为 `0.2.0`；文档以源码和实际验证为准，不把研究候选或过程计划写成已实现能力。

```text
docs/
├─ software-spec.md / mobile-spec.md      用户行为
├─ architecture.md                        架构总览与不变量
├─ architecture/                          分层、生命周期、缓存、实体、表示、DEV、IFC、选择、平台
├─ engineering/                           工程实体契约、三视图、设备/材料/构件目录
├─ schema/                                容器、语义、几何、XML MOD/primitive、线路、样本
├─ validation.md / performance.md / meassurement.md / open-issues.md
```

## 阅读入口

| 需要了解 | 文档 |
|---|---|
| 桌面功能、操作与限制 | [桌面软件规格](software-spec.md) |
| Android 线路能力 | [移动端规格](mobile-spec.md) |
| 系统边界与架构索引 | [系统架构](architecture.md) |
| 分层、打开、缓存、DEV/IFC、选择等机制 | [架构文档目录](architecture.md#架构文档分工) |
| 工程整体、来源、成员与三视图 | [工程实体模型](engineering/README.md) |
| 设备目录/装置性材料目录/构件清单 | [目录总则](engineering/catalogs/README.md) |
| GIM 容器、语义、几何、XML MOD | [Schema](schema/README.md) |
| 已实现 XML primitive | [XML primitive](schema/xml-primitives.md) |
| 样本身份与数量 | [样本台账](schema/sample-corpus.md) |
| 正确性门禁与证据边界 | [验证](validation.md) |
| 当前性能基线与 SLO | [性能基线](performance.md) |
| 冷/暖测试步骤与命令 | [性能测试指南](meassurement.md) |
| 未关闭缺陷与接受限制 | [问题与限制](open-issues.md) |
| 术语 | [术语表](glossary.md) |
| 建筑推断规则 | [建筑推断](engineering/building-inference.md) |
| 空间推断算法 | [空间推断](engineering/spatial-inference.md) |
| 几何资产与表示索引 | [几何资产](architecture/geometry-assets.md) |

`research/` 只保留未关闭研究缺口、原始证据、复现脚本和规范参考；已实现结论维护在本 `docs/`，过程稿不长期保留。`demo/` 保存原始 GIM 包和本地解包样本，大型文件由 Git 忽略。

## 结构性约定

1. **架构按主题拆分。** [architecture.md](architecture.md) 只做总览和不变量；生命周期、缓存、工程实体、表示、DEV、IFC、选择、线路/移动端、平台各自独立文档。新增机制先判断归属，不往总览里堆细节。
2. **用户行为与内部契约分开。** [software-spec.md](software-spec.md) 描述用户可见操作和限制；`architecture/` 描述内部实现。规格不复制缓存版本表或算法细节。
3. **工程实体与格式分开。** `engineering/` 定义项目目录、对象角色、整体/成员/关系；`schema/` 定义 GIM 文件事实和 parser 边界。目录编码是项目映射，不宣称国标编码。
4. **单一权威表。** 缓存版本只在[缓存域](architecture/caches.md)维护；样本统计只在[样本台账](schema/sample-corpus.md)；未关闭缺陷只在[问题与限制](open-issues.md)；其他文档引用，不复制。
5. **当前状态，不写过程。** 已关闭问题、修改前后对照、实施阶段流水不进入长期正文；功能转正后把稳定契约并入正式文档并删除过程稿。
6. **证据分层。** 源包事实、源码/单测、真实浏览器/桌面、性能计时分别记账；skip 不算通过，旧构建结果不能证明当前构建。
7. **匿名化。** `docs/schema/` 只使用匿名样本 ID，不写真实工程名、地理归属、建设单位或内部工程标识；其他目录同样避免复制真实业务字段。

## 维护检查

- 修改内部机制：更新对应 `architecture/` 文档，并确认[分层](architecture/layers.md)/[缓存](architecture/caches.md)是否受影响。
- 修改分类/目录：更新 `engineering/catalogs/` 与领域测试，不把新规则写进 UI 或 parser。
- 修改 XML primitive：更新[XML primitive](schema/xml-primitives.md)与[XML MOD](schema/substation-mod.md)的引用，保留“解析成功≠可渲染”的边界。
- 修改持久化含义：只 bump 受影响域，更新[缓存域](architecture/caches.md)，不复制旧版本。
- 文档变更：检查相对链接、源码路径、匿名化、重复定义，以及样本/研究资产是否被意外修改。
