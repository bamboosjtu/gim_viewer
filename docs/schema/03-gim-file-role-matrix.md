# GIM 文件角色矩阵

目标：确认每类文件在这个样本中扮演什么角色。

> **2026-07-17 说明**：文件角色与三样本数量仍有效；下表“当前处理策略”保留的是研究启动时基线，不代表当前代码。MOD/STL parser、渲染与 GLB 缓存的现状见 [21-schema-conclusion-review-0717.md](21-schema-conclusion-review-0717.md)。

## 1. 文件角色总览

| 文件类型 | 线路 demo | 变电 demo | 主要目录         | 粗判格式                 | 当前角色判断               | 当前处理策略           |
| -------- | --------: | --------: | ---------------- | ------------------------ | -------------------------- | ---------------------- |
| .cbm     |     27829 |      8701 | Cbm/CBM          | text-like                | 工程层级与引用关系         | 已作为核心解析对象     |
| .fam     |     26485 |     13056 | Cbm/CBM, Dev/DEV | text-like / unknown-text | 属性文件                   | 继续字段字典分析       |
| .dev     |      4518 |      4179 | Dev/DEV          | text-like                | 设备物理模型与设备属性     | 继续引用关系分析       |
| .phm     |      1836 |      4179 | Phm/PHM          | text-like                | 组合模型 / 装配体候选      | 静态分析引用关系       |
| .mod     |      1807 |      4179 | Mod/MOD          | text-like / unknown-text | 基础几何模型候选           | 仅静态体检，不解析几何 |
| .stl     |       181 |      1803 | Mod/MOD          | binary-like              | 三角网格资源候选           | 仅统计，不解析         |
| .ifc     |         0 |        12 | DEV              | text-like                | 变电 3D / 土建模型交互格式 | 继续走既有 IFC viewer  |
| .sch     |         0 |         1 | CBM              | text-like                | 逻辑模型入口               | 后续分析               |
| .std     |         0 |        1 | CBM              | text-like                | 主接线逻辑模型定义         | 后续分析               |
| .sld     |         0 |         1 | CBM              | text-like                | 主接线图 / 图形表达        | 后续分析               |

```plaintext
CBM
 ├─ DEV
 │   ├─ PHM
 │   │   ├─ MOD
 │   │   └─ STL
 │   └─ DEV / SUBDEVICE
 ├─ IFC
 ├─ FAM
 └─ CBM
```

## 2. 规范背景与实证差异

内部背景资料中提到：

- 变电工程土建及水暖系统可采用 IFC 进行交互。
- 电气设备、安装材料、线路工程可采用基本图元、参数化模型或 STL 进行交互。
- CBM / DEV / PHM / MOD 分别承担工程骨架、设备模型、组合模型、基础几何模型角色。

但当前两个 demo 的实证结果与规范描述存在一些路径和格式差异：

| 主题         | 背景描述                           | demo 实证                                                              | 当前处理                            |
| ------------ | ---------------------------------- | ---------------------------------------------------------------------- | ----------------------------------- |
| IFC 存放目录 | 背景中可能描述为 CBM 或被 CBM 引用 | demo-substation 的 12 个 IFC 位于 DEV 目录                             | 不写死 IFC 目录，按实际文件索引搜索 |
| MOD 格式     | 背景中提到 XML / 基本图元          | demo-line 存在 key-value 点线型 MOD；demo-substation 存在 XML-like MOD | 按样本分型，不统一假设              |
| 目录大小写   | 规范不强调大小写                   | 线路为 Cbm/Dev/Phm/Mod，变电为 CBM/DEV/PHM/MOD                         | 路径匹配必须大小写不敏感            |
| STL 角色     | 复杂几何三角网格                   | 两个 demo 均存在 STL，且粗判为 binary-like                             | 仅统计，不解析                      |

当前文档以 demo 实证为准；规范背景只作为解释线索，不直接替代样本事实。

---

## 3. 当前结论

- `.cbm / .fam / .dev / .phm / .mod` 均可作为文本或准文本文件进入 analysis。
- `.stl` 当前按 binary-like 三角网格资源处理。
- `.ifc` 当前只在 demo-substation 中出现，且位于 DEV 目录。
- CBM 通过 `OBJECTMODELPOINTER` 指向 `.dev`。
- CBM 通过 `BASEFAMILY`、`SUBDEVICEn`、`IFCFILE` 建立 FAM / CBM / IFC 引用。
- DEV 可以通过 `SOLIDMODELn` 引用 `.phm` 或 `.dev`。
- DEV 可以通过 `SUBDEVICEn` 引用子 `.dev`，说明设备物理模型存在递归组合关系。
- DEV / PHM 层文件级引用完整性已完成校验，`DEV -> PHM/DEV`、`PHM -> MOD/STL`。
- PHM 通过 `SOLIDMODELn` 引用 `.mod` 或 `.stl`，承担组合模型 / 装配体角色。
- MOD 不能统一定义为 XML，也不能统一定义为 CODE/POINTNUM 点线格式。
- MOD 在变电与线路中表现出不同表层格式。

---

## 4. 文件类型分析引用

针对单类文件的字段结构、引用关系、实证样本统计及背景对比，已沉淀到对应的格式说明文档：

| 文件类型 | 文档                                                        | 角色                                       |
| -------- | ---------------------------------------------------------- | ------------------------------------------ |
| `.cbm`   | [cbm.md](cbm.md)                                           | CBM 工程骨架与层级关系说明                 |
| `.fam`   | [fam.md](fam.md)                                           | FAM 属性文件说明                           |
| `.dev`   | [dev.md](dev.md)                                           | DEV 物理模型与设备组合说明                 |
| `.phm`   | [phm.md](phm.md)                                           | PHM 组合模型与 MOD/STL 引用说明            |
| `.mod`   | [mod.md](mod.md)                                           | MOD 基础几何/参数化模型说明                |
| `.sch`   | [sch.md](sch.md)                                           | SCH 逻辑模型说明                           |
| `.std`   | [std.md](std.md)                                           | STD 逻辑定义说明                           |
| `.sld`   | [sld.md](sld.md)                                           | SLD 主接线图/图形表达说明                  |

> `.stl` 为二进制三角网格资源，仅在 `05-gim-reference-integrity.md` 与 `07-dev-phm-geometry-reachability.md` 中作为统计对象出现，未单独提供格式说明文档。
> `.ifc` 复用 IFC 标准格式，由 web-ifc 直接解析，未单独提供格式说明文档。
