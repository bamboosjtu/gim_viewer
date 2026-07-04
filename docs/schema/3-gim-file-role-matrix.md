# GIM 文件角色矩阵

目标：确认每类文件在这个样本中扮演什么角色。

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
| .std     |         0 |         1 | CBM              | text-like                | 主接线逻辑模型定义         | 后续分析               |
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

## 3. sld 与 std 文件

属于中国国网 GIM 体系下的自定义格式，不是国际通用标准格式。

| 文件      | 实际格式      | 大小  | 内容                                                                                       |
| --------- | ------------- | ----- | ------------------------------------------------------------------------------------------ |
| `zjx.sld` | SVG 1.1 (XML) | 53 KB | 变电站主接线图（可视化图形），包含 "主接线元件层"、"主接线母线层" 等 CSS 图层              |
| `zjx.std` | XML           | 5 KB  | 变电站逻辑拓扑描述，定义了电压等级(220kV)、间隔(Bay)、导电设备(断路器、隔离开关、互感器等) |

两者通过 `gridId` 字段关联：STD 定义逻辑设备 → SLD 绘制对应的图形符号。

### `.sld` 文件

- **格式本身**：标准 SVG 1.1，这是国际主流的主接线图呈现格式（Powsybl、JointJS 等工具也是输出 SVG）
- **`.sld` 扩展名**：这是 GIM 体系的自定义命名约定。国际上，单线图一般直接使用 `.svg` 扩展名，而非 `.sld`
- **版本标识**：`version="DLT1"` 表明符合 DLT（电力行业推荐性标准）规范
- **生成工具**：`soft="GRevitTools"`——来自北京博超的 Revit 二次开发工具（STD-R 变电设计平台）

### `.std` 文件

std (Substation Template Definition)

- **专属格式**：GIM 体系内自定义的 XML 格式，描述变电站逻辑拓扑
- **国际对比**：国际上对应的标准是 **IEC 61850-6 SCL**（Substation Configuration Language，含 SSD 系统规范描述），以及 **CIM/CGMES**（IEC 61970/61968）
- **不属于** IEC 标准体系

### 总结

`.sld` 和 `.std` 在国内国网工程中是**事实上的交付标准**，在国网体系内属于主流格式。但在国际电力行业，这两个文件扩展名并不通用，国际上对标的是 IEC 61850 SCL 和 CIM/CGMES 标准。

| 层面       | 中国（GIM 体系）            | 国际                          |
| ---------- | --------------------------- | ----------------------------- |
| 逻辑拓扑   | `.std` (STD XML)            | IEC 61850 SCL (`.ssd`/`.scd`) |
| 接线图呈现 | `.sld` (SVG, DLT 扩展)      | SVG / CIM/CGMES + Powsybl     |
| 三维模型   | `.cbm`/`.dev`/`.phm`/`.mod` | IFC / BIM                     |

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
