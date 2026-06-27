# GIM 文件角色矩阵

## 1. 文件角色总览

| 文件类型 | 线路 demo | 变电 demo | 主要目录 | 粗判格式 | 当前角色判断 | 当前处理策略 |
|---|---:|---:|---|---|---|---|
| .cbm | 27829 | 8701 | Cbm/CBM | text-like | 工程层级与引用关系 | 已作为核心解析对象 |
| .fam | 26485 | 13056 | Cbm/CBM, Dev/DEV | text-like / unknown-text | 属性文件 | 继续字段字典分析 |
| .dev | 4518 | 4179 | Dev/DEV | text-like | 设备物理模型与设备属性 | 继续引用关系分析 |
| .phm | 1836 | 4179 | Phm/PHM | text-like | 组合模型 / 装配体候选 | 静态分析引用关系 |
| .mod | 1807 | 4179 | Mod/MOD | text-like / unknown-text | 基础几何模型候选 | 仅静态体检，不解析几何 |
| .stl | 181 | 1803 | Mod/MOD | binary-like | 三角网格资源候选 | 仅统计，不解析 |
| .ifc | 0 | 12 | DEV | text-like | 变电 3D / 土建模型交互格式 | 继续走既有 IFC viewer |
| .sch | 0 | 1 | CBM | text-like | 逻辑模型入口 | 后续分析 |
| .std | 0 | 1 | CBM | text-like | 逻辑模型定义 | 后续分析 |
| .sld | 0 | 1 | CBM | text-like | 主接线图 / 图形表达 | 后续分析 |

## 2. 规范背景与 demo 实证差异

内部背景资料中提到：

* 变电工程土建及水暖系统可采用 IFC 进行交互。
* 电气设备、安装材料、线路工程可采用基本图元、参数化模型或 STL 进行交互。
* CBM / DEV / PHM / MOD 分别承担工程骨架、设备模型、组合模型、基础几何模型角色。

但当前两个 demo 的实证结果与规范描述存在一些路径和格式差异：

| 主题       | 背景描述                   | demo 实证                                                        | 当前处理                 |
| -------- | ---------------------- | -------------------------------------------------------------- | -------------------- |
| IFC 存放目录 | 背景中可能描述为 CBM 或被 CBM 引用 | demo-substation 的 12 个 IFC 位于 DEV 目录                           | 不写死 IFC 目录，按实际文件索引搜索 |
| MOD 格式   | 背景中提到 XML / 基本图元       | demo-line 存在 key-value 点线型 MOD；demo-substation 存在 XML-like MOD | 按样本分型，不统一假设          |
| 目录大小写    | 规范不强调大小写               | 线路为 Cbm/Dev/Phm/Mod，变电为 CBM/DEV/PHM/MOD                        | 路径匹配必须大小写不敏感         |
| STL 角色   | 复杂几何三角网格               | 两个 demo 均存在 STL，且粗判为 binary-like                               | 仅统计，不解析              |

当前文档以 demo 实证为准；规范背景只作为解释线索，不直接替代样本事实。

---

## 3. FAM 格式观察

当前 demo 中 `.fam` 基本可按 plain text 处理。

线路 `Dev/*.fam` 样例显示，FAM 常见格式不是简单 `key=value`，而是三段式：

```text
中文标签=英文KEY=值
```

示例字段：

```text
电压等级=VOLTAGE=AC500kV
型号=TYPE=5TDZ-62、63-1
导线分裂数=BUNDLENUMBER=4
挂接点信息=WIREPOINT=...
```

需要注意：

* 中文标签可用于人工理解。
* 英文 KEY 适合进入字段字典。
* value 可能跨行续写。
* 无等号行不应直接视为脏数据，可能是上一字段的 continuation。

当前 FAM 解析建议：

| 元素           | 说明                   |
| ------------ | -------------------- |
| label        | 第一个 `=` 前的中文标签       |
| key          | 第二个字段中的英文 KEY        |
| value        | 第二个 `=` 后的原始值        |
| continuation | 后续无等号行，暂记录为上一字段的续行候选 |

---

## 4. MOD 内部格式初步分型

### 4.1 demo-line

线路 MOD 共 1807 个。

按 `CODE / POINTNUM` 粗分：

| 类型                |   数量 | 特征                             | 判断          |
| ----------------- | ---: | ------------------------------ | ----------- |
| CODE/POINTNUM 点线型 |  315 | 存在 `CODE`、`POINTNUM`、`LINENUM` | 点线几何 / 拓扑候选 |
| 未分类文本型            | 1492 | 未发现 `CODE`、`POINTNUM`          | 待进一步字段分析    |

CODE 分布：

| CODE |  数量 |
| ---- | --: |
| 201  | 128 |
| 31   |  74 |
| 32   |  63 |
| 34   |  19 |
| 35   |  13 |
| 33   |  10 |
| 30   |   8 |

线路 MOD key Top 观察：

| key                                            |     数量 | 观察                      |
| ---------------------------------------------- | -----: | ----------------------- |
| `Bolt1` ~ `Bolt4`                              | 各 1300 | 螺栓 / 金具类参数 |
| `BoltNum`                                      |   1300 | 螺栓数量                  |
| `CODE`                                         |    315 | 点线型 MOD 类型码             |
| `POINTNUM`                                     |    315 | 点数量                     |
| `LINENUM`                                      |    315 | 线数量                     |
| `POINT1..N`                                    |     多组 | 点坐标 / 点参数               |
| `LINE1..N`                                     |     多组 | 线段连接关系                  |
| `OUTSIDEDIAMETER`、`SECTIONALAREA`、`WIREWEIGHT` |    各 9 | 疑似导线物理参数                |

当前判断：

* demo-line 的 MOD 不是统一 XML。
* 部分 MOD 是 key-value 点线描述。
* 大量 MOD 与 `Bolt*` 字段相关，可能描述线路金具 / 塔材局部构件。
* 暂不进入几何解析，只做字段分型与引用链分析。

### 4.2 demo-substation

变电 MOD 共 4179 个。

当前未发现 `CODE / POINTNUM` 模式。

变电 MOD key Top 观察：

| key / 标签特征               |    数量 | 观察                       |
| ------------------------ | ----: | ------------------------ |
| `<?xml version`          |  4179 | 所有变电 MOD 都疑似 XML-like 文本 |
| `<TransformMatrix Value` | 46250 | 大量变换矩阵                   |
| `<Entity ID`             | 46250 | 大量几何实体                   |
| `<Color R`               | 46250 | 实体颜色                     |
| `<Cylinder R`            | 20421 | 圆柱体图元                    |
| `<Cuboid L`              | 12401 | 长方体图元                    |
| `<StretchedBody Array`   | 10263 | 拉伸体图元                    |
| `<PorcelainBushing R`    |  1506 | 套管 / 绝缘类专用图元候选           |
| `<TruncatedCone TR`      |   730 | 截锥体                      |
| `<Ring DR`               |   235 | 环形图元                     |
| `<Sphere R`              |   141 | 球体                       |
| `<ChannelSteel Model`    |   129 | 槽钢图元候选                   |

当前判断：

* demo-substation 的 MOD 与线路 CODE/POINTNUM 型 MOD 不同。
* demo-substation 的 MOD 更接近 XML-like 基本图元组合。
* 变电 MOD 中确实存在基础图元、颜色、变换矩阵等几何表达。
* 但当前变电 3D 查看已有 IFC 主路径，MOD 暂不进入渲染或解析实现。

---

## 5. 当前结论

* `.cbm / .fam / .dev / .phm / .mod` 均可作为文本或准文本文件进入 analysis。
* `.stl` 当前按 binary-like 三角网格资源处理。
* `.ifc` 当前只在 demo-substation 中出现，且位于 DEV 目录。
* MOD 不能统一定义为 XML，也不能统一定义为 CODE/POINTNUM 点线格式。
* MOD 在变电与线路中表现出不同表层格式。
* 当前阶段只做格式分型、字段分布、引用链分析，不进入几何解析。
