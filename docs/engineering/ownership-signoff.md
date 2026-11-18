# 工程归属待签认清单

本清单记录两份匿名源包的静态证据和待核对的自动结果。工程人员应逐项确认类别、直接父级、整体归属和成员状态，记录签认人、日期与差异原因。清单当前处于待签认状态。

| 样本 | 来源 SHA-256 | 静态来源 | 待归整体 | 未决组成诊断 | IFC 缺口 |
|---|---|---:|---:|---:|---:|
| S-REVIEW-01 | `b8e8ef6dffad3c1b06247953cbe34fe3f5deef6ec2ab8272a529f6a97673cfe3` | 855 | 3 | 260 | 4 |
| S-REVIEW-02 | `3197c03ef2c6c423cbb85447f71491a4112db0f9a8cea0c9f72f0b410b8175ab` | 386 | 2 | 0 | 8 |

读取原始 CBM、DEV、FAM 并按实际引用解析来源。两份样本均保留 `ifc-manifest-incomplete`。下表的定位符是来源实例 ID 或 owner ID 的 SHA-256 前 16 位。原始路径、字段行号和取值保存在本地私有工作区，随工程签认交接。

| S-REVIEW-01 来源 | 原始证据 | 自动类别与角色 | 自动 owner / 直接父级 | 自动成员状态 | 待签认 |
|---|---|---|---|---|---|
| `bb9a2f90cce05873` | 根 CBM 的 `OBJECTMODELPOINTER` 指向 `CombinationApparatuGIS` DEV | E05 / object | `130f6e7203fda7fa` / 无 | `whole_member` | 核对 GIS 母体类别和台套粒度。 |
| `bb8774be1b86cb3f` | CBM 与 DEV 的 `SUBDEVICE0` 共同指向部件。源 TYPE 为 `MetalFence`，名称表明为断路器 | M09 / part | `130f6e7203fda7fa` / `bb9a2f90cce05873` | `whole_member` | 核对名称与源类型冲突所对应的工程类别，并确认部件归属。 |
| `93d48428c81e5b94` | 经 `SUBSYSTEM` 引用可达的另一物理根，DEV TYPE 为 `SwitchCabinet` | E12 / object | `d00bb6f03d20d9b1` / 无 | `whole_member` | 确认此开关柜是否为独立台套。两个样本的已解析来源中均未发现显式 independent 字段，因此该例只覆盖结构上的独立根。 |
| `9281ba1ba5d326ee` | 三条候选组成证据均指向同一物理父级，语义别名涉及多候选子件 | U-OBJECT / part | `a9ba72ec93dc4d7b` / `e4601a6110448ac4` | `whole_member` | 核对物理父级与归属是否成立，以及保留的候选是否能进一步消歧。 |

已核对 GIS 组成链及已确认物理父级。断路器细分类存在待确认差异。其余工程身份以人工签认结果为准，见 [L-12](../open-issues.md)。
