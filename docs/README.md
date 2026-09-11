# GIM Viewer 文档索引

文档只描述架构、当前实现和下一步计划，不记录按日期排列的开发流水。

## 架构与共性

| 文档 | 内容 |
|---|---|
| [architecture.md](architecture.md) | Runtime 分层、打开生命周期、边界和版本化策略 |
| [gim_common.md](gim_common.md) | GIM 容器、应用状态、清理、共性缓存和诊断契约 |
| [dev-log.md](dev-log.md) | 尚未关闭的技术债务、证据缺口和明确的非目标 |
| [gim_viewer_product_roadmap.md](gim_viewer_product_roadmap.md) | 产品阶段、交付顺序和后续路线图 |

## 当前功能实现

| 文档 | 内容 |
|---|---|
| [gim_powerline.md](gim_powerline.md) | GIMPKGT、线路语义图、地图、属性和线路缓存 |
| [gim_substation.md](gim_substation.md) | GIMPKGS、CBM/IFC、Fragments、DEV/MOD 和变电缓存 |

## 性能证据

| 文档 | 内容 |
|---|---|
| [benchmark_powerline.md](benchmark_powerline.md) | 线路性能模型、当前基线和正式测量契约 |
| [benchmark_substation.md](benchmark_substation.md) | 变电 Fragments RC v2 的 A/B benchmark、正确性和决策 |

## GIM 样本与格式

样本分析、格式研究、引用链和几何可达性统一归档在 [schema/README.md](schema/README.md)；
文件类型说明也集中在 `schema/`，产品实现文档只引用结论，不复制样本流水。

| 文档 | 内容 |
|---|---|
| [schema/README.md](schema/README.md) | 样本研究主线、新样本接入顺序和格式文档索引 |
| [schema/cbm.md](schema/cbm.md) | CBM 工程骨架与层级关系 |
| [schema/dev.md](schema/dev.md) | DEV 物理模型与设备组合 |
| [schema/fam.md](schema/fam.md) | FAM 属性文件 |
| [schema/mod.md](schema/mod.md) | MOD 几何/参数化模型 |
| [schema/phm.md](schema/phm.md) | PHM 组合模型与 MOD/STL 引用 |
| [schema/sch.md](schema/sch.md) | SCH 逻辑模型 |
| [schema/sld.md](schema/sld.md) | SLD 主接线图 |
| [schema/std.md](schema/std.md) | STD 逻辑定义 |

## 文档维护边界

- 架构变化先更新 `architecture.md`，共性生命周期、缓存和诊断变化同步更新 `gim_common.md`。
- 线路/变电功能变化只更新对应实现文档；共享缓存细节统一维护在 `gim_common.md`，不再维护重复的缓存导航页。
- 性能数字和测量规则只写入对应 benchmark 文档；仍未解决的问题写入 `dev-log.md`。
- 新样本先进入 `schema/`，确认跨样本规则后再更新实现文档。
