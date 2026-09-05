# GIM 文件角色矩阵

> 本文定义当前解析器对 GIM 文件类型的角色和处理入口。数量仅作为样本规模
> 参考，不代表标准中固定的文件配比；跨工具差异见 [22-ten-sample-verification-0824.md](22-ten-sample-verification-0824.md)。

## 1. 文件角色总览

| 文件类型 | 主要目录 | 业务角色 | 当前处理 |
|---|---|---|---|
| `.cbm` | `CBM/` 或 `Cbm/` | 工程层级、引用和 placement | 变电/线路分别解析为 CBM tree/graph，并写入对应 SQLite 域 |
| `.fam` | `CBM/`、`DEV/` 或对应大小写目录 | 设备、杆塔、导线和基础属性 | 按分节或键值解析，属性按字典展示并缓存 |
| `.dev` | `DEV/` 或 `Dev/` | 设备定义、PHM/子 DEV 组合 | 解析 `SOLIDMODELS`、`SUBDEVICES` 和变换矩阵；变电几何按 unique DEV 编译 GLB |
| `.phm` | `PHM/` 或 `Phm/` | 可复用装配模型 | 递归解析 `SOLIDMODEL`、矩阵和颜色，带 visited 防环 |
| `.mod` | `MOD/` 或 `Mod/` | 基础几何或线路文本记录 | 变电 XML MOD 进入 Geometry IR；线路按四类文本格式供属性面板/HNum 预览消费 |
| `.stl` | `MOD/` 或 `Mod/` | 三角网格资源 | 变电 DEV GLB 管线支持 binary/ASCII 读取；线路仅保留来源追溯，不创建独立 3D |
| `.ifc` | 常见于 `DEV/` | 变电 IFC 空间/构件模型 | 发现后由 OBC Fragments 加载；Spatial Core 只保留空间和 placement 语义 |
| `.sch` | `CBM/` 或 `Cbm/` | 逻辑模型入口 | 解析逻辑模型引用，供 STD/SLD 视图选择 |
| `.std` | `CBM/` 或 `Cbm/` | 逻辑模型定义 | 解析电压等级、间隔和设备关系 |
| `.sld` | `CBM/` 或 `Cbm/` | 主接线图 | 白名单净化后在中间工作区渲染，保持与三维模型叠加 |
| `.gl` | 导出器定义的几何目录 | 低频辅助几何资源 | 作为可发现条目保留；只有引用链明确支持时才进入渲染 |

## 2. 引用关系

```text
CBM
 ├─ OBJECTMODELPOINTER → DEV
 │   ├─ SOLIDMODEL → PHM / DEV
 │   │   ├─ SOLIDMODEL → MOD / STL
 │   │   └─ TRANSFORMMATRIXn / COLORn
 │   └─ SUBDEVICEn → DEV
 ├─ BASEFAMILY → FAM
 ├─ IFCFILE / IFCGUID → IFC 构件
 └─ SCH → STD / SLD
```

引用解析按 entry path 归一化，目录和文件名匹配大小写不敏感；业务名称不由 GUID
或文件名直接决定。线路 CBM 的 `SECTION`、`STRAINSECTION`、`GROUP`、`TOWER`、
`WIRE`、`CROSS` 引用由线路 graph 额外保留。

## 3. 格式差异与处理原则

| 主题 | 样本事实 | 当前处理原则 |
|---|---|---|
| IFC 位置 | 常见于 DEV，但不保证固定目录 | 全量文件索引搜索，不写死目录 |
| MOD 表层格式 | 变电以 XML primitive 为主，线路以四类文本族为主 | 先按工程类型和内容分型，再选择 parser |
| 目录大小写 | 变电通常大写，线路通常 PascalCase | 统一使用大小写不敏感键空间 |
| PHM 结构 | 可嵌套，矩阵可能非单位阵 | 递归 + 防环，始终应用累积矩阵 |
| STL 角色 | 可选，工具间数量和用途差异很大 | 按引用链判断，不假定固定配比 |
| 逻辑图纸 | SCH/STD/SLD 可能缺失或由不同导出器组合 | 缺失时只隐藏对应入口，不阻塞三维/地图模型 |

## 4. 当前消费入口

| 文件类型 | 解析/编排入口 | 主要消费方 |
|---|---|---|
| CBM/FAM/DEV/PHM/MOD/STL | `desktop/src/gim/` 与 `desktop/src/services/` | 导航树、属性抽屉、Geometry IR、DEV GLB 管线 |
| IFC | `gimIndexer.ts`、`ifcSpatialParser.ts`、`ifcEntryLoader.ts` | 空间树、Fragments 三维、高亮与按需属性 |
| SCH/STD/SLD | `schParser.ts`、`stdParser.ts`、`sldParser.ts` | 主接线图和逻辑模型工作区 |

单类字段和语法说明见本目录的 `cbm.md`、`fam.md`、`dev.md`、`phm.md`、`mod.md`、
`sch.md`、`std.md` 和 `sld.md`。性能、实验和下一步功能不在 Schema 文档中维护。

