# 文档索引

> GIM 阅读器项目文档总览。所有文档描述当前实现状态，便于新开发者理解。

## 总览

| 文档 | 说明 |
|------|------|
| [技术架构](architecture.md) | 技术选型、源码结构、模块关系、SQLite 表结构、功能开关 |
| [变电 GIM](gim_substation.md) | 变电站工程（GIMPKGS）文件格式、解析流程、3D 可视化 |
| [线路 GIM](gim_line.md) | 输电线路工程（GIMPKGT）文件格式、地图渲染、树↔图联动 |
| [开发者日志](dev-log.md) | 已知限制、技术债务、关键决策、日志系统、诊断工具 |
| [线路几何审计](m4-b-line-geometry-research.md) | M4-B1 线路几何与导线语义审计：字段清单、悬链线候选字段、缺口与 M4-B2 建议 |
| [悬链线参数验证](m4-b3-catenary-param-validation.md) | M4-B3 悬链线参数语义验证：候选字段覆盖率、样本分析、语义假设、阻塞问题、M4-B4 建议，以及 M4-B3A 用户核验导出流程（Ctrl+Shift+C） |
| [档距聚合验证](m4-b3b-span-grouping-validation.md) | M4-B3B 档距聚合与 MATRIX0 平移分量验证：spanKey 规则、4x4 矩阵平移解析、每档 WIRE 数统计、M4-B4 决策条件（Ctrl+Shift+C 自动包含 spanGroupingReport） |

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
