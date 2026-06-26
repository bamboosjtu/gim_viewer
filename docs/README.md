# 文档索引

> GIM 阅读器项目文档总览。

## 线路 GIM 可视化（M3 MVP）

| 文档 | 说明 |
|------|------|
| [MVP 实现说明](m3-line-gim-mvp.md) | 线路 GIM 可视化 MVP 的架构、数据流、设计决策、关键文件 |
| [手动验收清单](manual-acceptance-checklist.md) | 线路/变电首次/二次打开、切换、清空、异常场景验收步骤 |
| [已知限制](known-limitations.md) | MVP 阶段的地图/塔位/导线/CROSS/IFC/底图/缓存限制 |
| [地图底图评估](map-basemap-evaluation.md) | MapLibre / Leaflet / Cesium 对比，M4 集成建议，M4-A1 技术验证结果 |
| [M4 路线图](m4-roadmap.md) | 地图增强、悬链线、MOD 几何、工程化改进路线 |
| [M4 Sprint 1 总结](m4-sprint1-summary.md) | 缓存管理 UI + 诊断摘要增强 + MapLibre 技术验证（默认关闭） |

## 变电 IFC

| 文档 | 说明 |
|------|------|
| [Fragments 缓存设计](fragments-cache-design.md) | .frag 缓存方案设计（当前默认关闭） |

## 日志与诊断

| 文档 | 说明 |
|------|------|
| [日志与诊断说明](logging-and-diagnostics.md) | 日志分类、localStorage override、Ctrl+Shift+D 诊断、生产排障 |

## GIM 文件格式

| 文档 | 说明 |
|------|------|
| [Demo 工程分析](gim_spec.md) | Demo GIM 工程结构与内容分析 |
| [格式规范 - CBM](schema/cbm.md) | CBM 层级文件格式 |
| [格式规范 - DEV](schema/dev.md) | DEV 设备文件格式 |
| [格式规范 - FAM](schema/fam.md) | FAM 属性文件格式 |
| [格式规范 - MOD](schema/mod.md) | MOD 几何文件格式 |
| [格式规范 - PHM](schema/phm.md) | PHM 装配体文件格式 |
| [格式规范 - SCH](schema/sch.md) | SCH 图纸文件格式 |
| [格式规范 - SLD](schema/sld.md) | SLD 单线图文件格式 |
| [格式规范 - STD](schema/std.md) | STD 标准文件格式 |
