# 文档索引

> GIM 阅读器项目文档总览。所有文档描述当前实现状态，便于新开发者理解。

## 总览

| 文档 | 说明 |
|------|------|
| [技术架构](architecture.md) | 技术选型、源码结构、模块关系、SQLite 表结构、功能开关 |
| [变电 GIM](gim_substation.md) | 变电站工程（GIMPKGS）文件格式、解析流程、3D 可视化 |
| [线路 GIM](gim_line.md) | 输电线路工程（GIMPKGT）文件格式、地图渲染、树↔图联动 |
| [开发者日志](dev-log.md) | 已知限制、技术债务、关键决策、日志系统、诊断工具 |
| [线路悬链线参数研究](schema/14-line-catenary-study.md) | M4-B1/B2/B3/B3A/B3B/B3C 线路几何与悬链线研究合并：字段审计、档距聚合、拓扑分类、审计服务 API、用户核验流程、决策与后续路线 |
| [线路 WIRE 悬链线静态分析证据](schema/15-wire-catenary-evidence.md) | demo-line 全量静态分析（5460 WIRE / 327 TOWER），KVALUE / MATRIX0 / BLHA / 拓扑分类字段语义确认 |

## GIM 文件格式规范

| 文档 | 说明 |
|------|------|
| [格式规范 - CBM](schema/cbm.md) | CBM 层级文件格式 |
| [格式规范 - DEV](schema/dev.md) | DEV 设备文件格式 |
| [格式规范 - FAM](schema/fam.md) | FAM 属性文件格式 |
| [格式规范 - MOD](schema/mod.md) | MOD 几何文件格式 |
| [格式规范 - PHM](schema/phm.md) | PHM 装配体文件格式 |
| [格式规范 - SCH](schema/sch.md) | SCH 图纸文件格式 |
| [格式规范 - SLD](schema/sld.md) | SLD 单线图文件格式 |
| [格式规范 - STD](schema/std.md) | STD 标准文件格式 |
