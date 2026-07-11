# GIM 工程完整变换链分析

> 本文档基于三个 demo 样本（`demo-line`、`demo-line1`、`demo-substation`）对 GIM 工程中变换矩阵的组合关系进行系统性梳理。每个分析维度下对比变电工程与线路工程的异同。
>
> 本报告不进入几何渲染实现，也不解释坐标系语义、单位换算、轴方向约定或三维构件拓扑。所有分析脚本集中放在文末附录 A。
>
> **修订记录**：本文档初版仅覆盖 PHM × MOD Entity 两级变换，得出"两级变换假设不成立、实际为单级变换"的错误结论，导致后续渲染管线开发出现装配矩阵缺失与实例位置丢失。本次修订补充 CBM/DEV/SUBDEVICE 完整链路分析与实例级多样性证据，并修正第 6/13/14/15/16 节的结论。详见 [16-substation-transform-matrix-bugs.md](./16-substation-transform-matrix-bugs.md) 的 bug 清单与修复建议。
>
> **2026-07-10 更正**：本样本的 `9866` 是把 F4 根 DEV 的 SUBDEVICE 路径与其 CBM PARTINDEX 语义别名重复遍历后的路径数，不是应渲染的物理实例数。PARTINDEX 与对应 SUBDEVICE 一一映射但不含局部矩阵；正确的几何引用基线为 `4135 MOD + 1803 STL = 5938`。详见 [20-substation-partindex-alias-correction.md](./20-substation-partindex-alias-correction.md)。

## 1. 分析目标与范围

### 1.1 目标

确认 GIM 工程中各级 `TRANSFORMMATRIXn` 字段在装配链路中的作用：

- CBM 节点的 `TRANSFORMMATRIX` 是否承担装配变换
- DEV 文件 `SOLIDMODELS` / `SUBDEVICES` 块的 `TRANSFORMMATRIXn` 是否承担装配变换
- PHM 的 `TRANSFORMMATRIXn` 是否承担装配变换
- 变电 MOD XML 的 `Entity.TransformMatrix` 是否构成两级变换
- 沿 CBM → DEV → SUBDEVICE → PHM → MOD 完整链路重建后的实例级 placement 矩阵多样性
- 同一 MOD 文件被多个不同 placement 引用时的实例分布（关键证据）
- 外部装配矩阵与 MOD Group 0.001 缩放的单位处理交互

### 1.2 分析对象

```text
demo-line        线路工程样本 A
demo-line1       线路工程样本 B
demo-substation  变电工程样本
```

### 1.3 分析范围

```text
矩阵存储约定（行优先 / 列优先 / 平移分量位置）
PHM 中 TRANSFORMMATRIXn 的数量、维度、值分布
PHM 中 SOLIDMODELn 与 TRANSFORMMATRIXn 的一一对应关系
PHM TRANSFORMMATRIX 的矩阵分类（单位 / 平移 / 旋转+缩放 / 组合）
变电 MOD XML Entity.TransformMatrix 的矩阵分类
PHM 矩阵 × MOD Entity 矩阵的组合分布（PHM 层验证）
CBM 节点 TRANSFORMMATRIX 字段分布（含 OBJECTMODELPOINTER 引用语义）
DEV 文件 SOLIDMODELS 块的 TRANSFORMMATRIXn 分布
DEV 文件 SUBDEVICES 块的 TRANSFORMMATRIXn 分布（递归子 DEV 链路）
CBM → DEV → SUBDEVICE → PHM → MOD 完整链路重建后的实例级 placement 矩阵分类
同一 MOD 文件被多个不同 placement 引用的实例数分布（关键证据）
外部装配矩阵与 MOD Group 0.001 缩放的单位处理交互
线路 MOD 是否依赖 TransformMatrix 字段
```

### 1.4 关键判断

```text
1. PHM 在三个样本中 100% 是单位矩阵，PHM 层不承担任何几何变换。
   PHM 的 TRANSFORMMATRIXn 仅起"占位"作用，与 SOLIDMODELn 一一对应但语义为空。
   （此条与初版一致，PHM 层结论保留。）

2. 变电 MOD XML Entity.TransformMatrix 承担全部"本地"变换（76% 非单位），
   但仅是局部变换，不是最终变换。
   （初版误把局部变换当作最终变换，本次修订修正。）

3. CBM 层存在 TRANSFORMMATRIX 字段（4645 / 8700 = 53.4% 节点含矩阵），
   其中 6.1% 为非单位矩阵（96 纯平移 + 189 平移+旋转），
   平移量级达数十米，是装配链路不可忽略的一环。

4. DEV SOLIDMODELS 块的矩阵 95.5% 为 IDENTITY，
   DEV → PHM 链路几乎不贡献变换 —— 与 PHM 恒为单位结论一致。
   DEV SUBDEVICES 块的矩阵 87.8% 非 IDENTITY
   （66.2% 纯平移 + 21.6% 平移+旋转），是整个变换链的"主变换源"。

5. 沿 CBM → DEV → SUBDEVICE → PHM → MOD 完整链路重建后：
   - 总实例数 9866（vs. 唯一 MOD 文件 5938）
   - 66.2% 的 MOD 文件被多个不同 placement 引用
   - 100% 实例的 placement 非 IDENTITY
   - 平移跨度：Tx/Ty ≈ 100m、Tz ≈ 43m（变电站工程典型尺度）

6. 变电工程存在两级变换（修正初版"单级变换"结论）：
   - 局部级：MOD Entity.TransformMatrix（本文档 §5）
   - 装配级：CBM × DEV_SOLID × SUBDEVICE × PHM 累积矩阵（本文档 §8-§10）
   最终变换 = 装配矩阵 × 局部矩阵
   其中装配矩阵 100% 非 IDENTITY（22% 纯平移 + 78% 平移+旋转），不可省略。

7. 线路 MOD 完全不依赖 TransformMatrix 字段，坐标以绝对值写入 POINTn / P 行中。

8. GIM 矩阵 16 浮点数采用列主序存储（Three.js / OpenGL 风格），
   平移分量在 m[12..14]，与 dev.md / phm.md 中"行优先、平移在最后一列"的
   描述存在矛盾，需修正。
```

---

## 2. 矩阵存储约定

### 2.1 文档现状

`dev.md` 与 `phm.md` 描述矩阵格式：

```text
4×4 矩阵按行优先展开为 16 个浮点数：
M00,M01,M02,M03,M10,M11,M12,M13,M20,M21,M22,M23,M30,M31,M32,M33

| M00  M01  M02  M03 |
| M10  M11  M12  M13 |
| M20  M21  M22  M23 |
| M30  M31  M32  M33 |

- 最后一列（M03, M13, M23）控制平移（X, Y, Z 方向）
- 最后一行固定为 0,0,0,1
```

### 2.2 实证样本

从 `demo-substation` MOD Entity 抽取一个含平移的样本：

```text
raw = 1,0,0,0, 0,1,0,0, 0,0,1,0, -317.951893831357, 336.065970013593, 1792.99999999997, 1
```

按 4 个一组展开：

```text
m[0..3]   = 1, 0, 0, 0
m[4..7]   = 0, 1, 0, 0
m[8..11]  = 0, 0, 1, 0
m[12..15] = -317.951893831357, 336.065970013593, 1792.99999999997, 1
```

平移分量 `(-317.95, 336.07, 1793.0)` 位于 `m[12..14]`，即**最后一行**，而非文档所述的"最后一列" `m[3]/m[7]/m[11]`。

CBM 与 DEV SUBDEVICE 的非单位矩阵样本（§8、§9）同样遵循此约定，例如：

```text
[4883d8d8-*.cbm] raw = 0,1,0,0, -1,0,0,0, 0,0,1,0, 45758.924,7382.144,5750,1
  按 Three.js Matrix4.elements（列主序）解析：
  列 0 = (0,1,0,0)  列 1 = (-1,0,0,0)  列 2 = (0,0,1,0)  列 3 = (45758.924,7382.144,5750,1)
  → 绕 Z 轴 90° 旋转 + 平移，平移在 m[12..14]
```

### 2.3 工程类型对比

| 维度 | 变电工程（demo-substation） | 线路工程（demo-line / demo-line1） |
| ---- | --------------------------- | ---------------------------------- |
| 矩阵精度 | 整数形式（`1,0,0,0,...`） | 浮点形式（`1.000000000,0.000000000,...`） |
| 平移分量位置 | m[12], m[13], m[14] | 无平移矩阵（PHM 全为单位） |
| 单位矩阵占比 | PHM 100%、MOD Entity 23.55% | PHM 100%、MOD 无矩阵 |

### 2.4 结论与文档修正建议

```text
GIM 实际矩阵存储约定：
  16 个浮点数，平移分量在 m[12], m[13], m[14]（最后一行）
  3x3 旋转/缩放在 m[0..2], m[4..6], m[8..10]
  最后一行 m[12..14] 为平移，m[15] 恒为 1
  等同于 Three.js Matrix4.elements 数组布局（列主序展开）

dev.md 与 phm.md 中"行优先、平移在最后一列"的描述与实证不符，
应修正为"列主序展开，平移在 m[12]/m[13]/m[14]"。
```

---

## 3. PHM TRANSFORMMATRIXn 数量与对应关系

### 3.1 数量统计

| 指标 | demo-line（线路） | demo-line1（线路） | demo-substation（变电） |
| ---- | ----------------: | ----------------: | ----------------------: |
| PHM 文件总数 | 1836 | 563 | 4179 |
| `NUM=0` 文件数 | 0 | 0 | 14 |
| `SOLIDMODEL` 引用总数 | 3136 | 719 | 5938 |
| `TRANSFORMMATRIX` 字段总数 | 3136 | 719 | 5938 |
| `COLOR` 字段总数 | 3136 | 719 | 5938 |
| SOLIDMODELn / TRANSFORMMATRIXn 数量不一致文件数 | 0 | 0 | 0 |
| `SOLIDMODEL → .mod` | 2955 | 637 | 4135 |
| `SOLIDMODEL → .stl` | 181 | 82 | 1803 |

### 3.2 一一对应关系

三个样本中，每个 `SOLIDMODELn` 都有同索引的 `TRANSFORMMATRIXn` 与之对应，**0 例不匹配**。`SOLIDMODEL<i>`、`TRANSFORMMATRIX<i>`、`COLOR<i>` 三者通过索引 `i` 严格一一对应，与 `phm.md` 字段说明一致。

### 3.3 工程类型对比

| 维度 | 变电工程 | 线路工程 |
| ---- | -------- | -------- |
| 平均每 PHM 的 SOLIDMODEL 数 | 1.42（含 14 个 NUM=0 装配节点） | 1.71 / 1.28（线路 A / B） |
| SOLIDMODEL 最大索引 | 75（大组合件） | 2 / 2 |
| 引用文件类型混合 | MOD 与 STL 混合引用 | 单个 PHM 要么全 MOD，要么全 STL |
| 矩阵对应关系 | 严格一一对应 | 严格一一对应 |

---

## 4. PHM TRANSFORMMATRIX 矩阵分类

### 4.1 分类规则

```text
IDENTITY                  16 个值严格等于单位矩阵 1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
TRANSLATION_ONLY          3x3 旋转/缩放部分为单位，但平移分量 (m[12], m[13], m[14]) 非零
ROTSCALE_ONLY             3x3 旋转/缩放部分非单位，平移分量为零
TRANSLATION+ROTSCALE      3x3 非单位 + 平移非零
OTHER                     其他（含 INVALID）
```

### 4.2 三样本分类结果

| 矩阵分类 | demo-line | demo-line1 | demo-substation | 工程类型 |
| -------- | --------: | ----------: | --------------: | -------- |
| IDENTITY | 3136 | 719 | 5938 | 全部 |
| TRANSLATION_ONLY | 0 | 0 | 0 | - |
| ROTSCALE_ONLY | 0 | 0 | 0 | - |
| TRANSLATION+ROTSCALE | 0 | 0 | 0 | - |
| OTHER / INVALID | 0 | 0 | 0 | - |
| **合计** | **3136** | **719** | **5938** | |
| 单位矩阵占比 | 100% | 100% | 100% | |

### 4.3 按引用类型分类

| 引用类型 | IDENTITY | 非 IDENTITY | 总计 |
| -------- | -------: | ----------: | ---: |
| `.mod`（demo-line） | 2955 | 0 | 2955 |
| `.stl`（demo-line） | 181 | 0 | 181 |
| `.mod`（demo-line1） | 637 | 0 | 637 |
| `.stl`（demo-line1） | 82 | 0 | 82 |
| `.mod`（demo-substation） | 4135 | 0 | 4135 |
| `.stl`（demo-substation） | 1803 | 0 | 1803 |

### 4.4 工程类型对比

```text
变电工程：
  5938 个 PHM TRANSFORMMATRIX 全部为单位矩阵。
  无论是 .mod 还是 .stl 引用，PHM 都不应用任何空间变换。

线路工程：
  3136 + 719 = 3855 个 PHM TRANSFORMMATRIX 全部为单位矩阵。
  与变电工程完全一致。

跨样本稳定性：
  两个线路样本（demo-line / demo-line1）和变电样本（demo-substation）的
  PHM 矩阵分类结果完全一致：100% 单位矩阵。
```

### 4.5 结论

```text
PHM 在所有样本中均不承担几何变换。
PHM 的 TRANSFORMMATRIXn 字段仅起"占位"作用，
与 SOLIDMODELn 一一对应但语义为空。
PHM 实际承担"装配容器"角色，将 SOLIDMODEL 引用与 COLOR 绑定，
不应用任何空间变换。

注：本结论仅针对 PHM 层。CBM/DEV/SUBDEVICE 层的分析见 §8/§9。
初版曾把此结论错误推广到整个外部装配链路，导致渲染管线缺失
装配矩阵。详见 §6 修正与 §13 对照。
```

---

## 5. 变电 MOD XML Entity.TransformMatrix 分析

### 5.1 数量统计（仅 demo-substation）

| 指标 | demo-substation |
| ---- | --------------: |
| MOD 文件总数 | 4179 |
| 含 `<Entity>` 的 MOD（XML_WITH_ENTITIES） | 4135 |
| Entity 总数 | 46250 |
| 含 `<TransformMatrix>` 的 Entity | 46250（100%） |
| 不含 `<TransformMatrix>` 的 Entity | 0 |
| Visible=True Entity | 45558 |
| Visible=False Entity | 692 |

### 5.2 矩阵分类结果

| 矩阵分类 | 数量 | 占比 |
| -------- | ---: | ---: |
| IDENTITY | 10893 | 23.55% |
| TRANSLATION_ONLY | 9453 | 20.44% |
| ROTSCALE_ONLY | 3 | 0.01% |
| TRANSLATION+ROTSCALE | 25901 | 56.00% |
| OTHER / INVALID | 0 | 0.00% |
| **合计** | **46250** | **100%** |

### 5.3 Visible × Matrix kind 交叉

| 组合 | 数量 | 占比 |
| ---- | ---: | ---: |
| Visible=True + Identity | 10399 | 22.49% |
| Visible=True + Non-Identity | 35159 | 75.94% |
| Visible=False + Identity | 494 | 1.07% |
| Visible=False + Non-Identity | 198 | 0.43% |

可见 Entity 中约 76% 含实际变换，仅 24% 是单位矩阵。

### 5.4 非单位矩阵平移分量分布

| 分量 | 最小值 | 最大值 | 均值 |
| ---- | -----: | -----: | ---: |
| Tx (m[12]) | -4750.00 | 14563.71 | 180.71 |
| Ty (m[13]) | -13426.61 | 8150.33 | 184.19 |
| Tz (m[14]) | -1300.00 | 7542.12 | 1515.38 |

平移范围 4750 mm 至 14563 mm（5–15 米），符合变电设备在 MOD 文件内的局部空间布置尺度。注意：这是 MOD 文件内部 Entity 之间的相对位置，**不等于工程全局位置**——工程全局位置需叠加装配矩阵（见 §10）。

### 5.5 非单位矩阵样本

```text
[Entity 931170] TRANSLATION+ROTSCALE
  T=(-241.625, -197.622, 1711.000)
  raw: 0,0,-1,0, -1,-1.22e-16,0,0, 1.22e-16,-1,0,0, -241.625,-197.622,1711,1
  特征：纯旋转（绕 X 轴 180°）+ 平移

[Entity 1211480] TRANSLATION+ROTSCALE
  T=(50.104, 253.524, 2097.797)
  raw: 1,0,0,0, 0,0,1,0, 0,-1,0,0, 50.104,253.524,2097.797,1
  特征：绕 Y 轴 90° 旋转 + 平移

[Entity 353727] TRANSLATION_ONLY
  T=(-317.952, 336.066, 1793.000)
  raw: 1,0,0,0, 0,1,0,0, 0,0,1,0, -317.952,336.066,1793,1
  特征：纯平移，无旋转
```

### 5.6 工程类型对比

```text
变电工程：
  MOD Entity.TransformMatrix 承担"本地"变换。
  76% 的 Entity 含实际变换（平移/旋转/缩放）。
  56% 同时含平移 + 旋转/缩放（典型设备组装场景）。
  20% 是纯平移（构件偏移）。
  仅 24% 是单位矩阵（无需变换的本地原点构件）。
  本地变换的平移量级 5–15 米，是 MOD 文件内部 Entity 之间的相对位置。

线路工程：
  MOD 完全无 TransformMatrix 字段（详见 §7）。
  本地变换模型不存在。
```

---

## 6. PHM × MOD 两级变换关系（PHM 层验证）

### 6.1 假设

```text
两级变换假设（初版，仅验证 PHM × MOD Entity 两层）：
  DEV/PHM placement（外层装配变换）
    ↓
  MOD Entity local transform（内层本地变换）

最终变换 = PHM_Matrix × MOD_Entity_Matrix
```

### 6.2 验证方法

从 `demo-substation` 抽样 20 对（PHM 矩阵 + 其引用 MOD 的第一个 Entity 矩阵），统计 PHM × MOD 矩阵组合分布。

### 6.3 抽样结果

| PHM 矩阵 | MOD Entity 矩阵 | 数量 | 占比 |
| -------- | --------------- | ---: | ---: |
| Identity | Identity | 12 | 60% |
| Identity | Non-Identity | 8 | 40% |
| Non-Identity | Identity | 0 | 0% |
| Non-Identity | Non-Identity | 0 | 0% |

### 6.4 抽样非 Identity MOD Entity 矩阵实例

```text
PHM[000f96d3...phm[0]] -> 818e6023...mod
  PHM kind=IDENTITY  T=(0, 0, 0)
  MOD kind=TRANSLATION_ONLY  T=(-317.952, 336.066, 1793.000)

PHM[0020f7f3...phm[0]] -> 64c47880...mod
  PHM kind=IDENTITY  T=(0, 0, 0)
  MOD kind=TRANSLATION+ROTSCALE  T=(0, 0, 4753.955)

PHM[0145f8d3...phm[0]] -> 677aa426...mod
  PHM kind=IDENTITY  T=(0, 0, 0)
  MOD kind=TRANSLATION+ROTSCALE  T=(1493.219, 3582.849, 293.936)
```

### 6.5 工程类型对比

```text
变电工程：
  PHM 矩阵恒为单位，PHM 层不贡献任何 placement。
  MOD Entity.TransformMatrix 承担 MOD 文件内的局部变换。
  PHM 仅起"装配容器"作用，把 MOD 文件与 COLOR 绑定。

线路工程：
  PHM 矩阵也恒为单位（详见 §4）。
  MOD 无 TransformMatrix 字段（详见 §7）。
  实际无任何矩阵变换层级，坐标直接以绝对值写入文本字段。
```

### 6.6 结论（修订）

```text
初版结论（错误）：
  "PHM placement + MOD local transform"的两级变换假设在三个样本中均不成立。
  实际为单级变换（变电）或无变换（线路）。

修订结论：
  PHM 层的"两级变换假设不成立"在 PHM 维度上依然成立：PHM 矩阵恒为单位，
  不贡献任何 placement。
  
  但不能据此推广为"实际为单级变换"。装配链路还包含 CBM/DEV/SUBDEVICE 层
  （§8/§9 证明 CBM 6.1% 非单位、DEV SUBDEVICES 87.8% 非单位），
  沿 CBM→DEV→SUBDEVICE→PHM→MOD 完整链路重建后，100% 实例的 placement 非 IDENTITY
  （§10 证明）。

  变电工程实际为两级变换：
    局部级：MOD Entity.TransformMatrix（MOD 文件内部 Entity 相对位置）
    装配级：CBM × DEV_SOLID × SUBDEVICE × PHM 累积矩阵
    最终变换 = 装配矩阵 × 局部矩阵

  初版遗漏了装配级分析，导致渲染管线缺失装配矩阵乘法，
  详见 §15 实现影响与 [16-substation-transform-matrix-bugs.md](./16-substation-transform-matrix-bugs.md)。
```

---

## 7. 线路 MOD 是否依赖 TransformMatrix

### 7.1 检测方法

对 `demo-line`（1807 个 MOD）和 `demo-line1`（508 个 MOD）的所有文件全文扫描以下矩阵字段模式：

```text
^TRANSFORMMATRIX
^TRANSFORMMATRIX0
^TransformMatrix
^Matrix
^MATRIX
^M00
^MATRIX0
<TransformMatrix   （XML 标签）
```

### 7.2 检测结果

| 样本 | MOD 总数 | 含矩阵字段文件数 | 含 `<TransformMatrix>` 标签文件数 |
| ---- | -------: | ---------------: | -------------------------------: |
| demo-line | 1807 | 0 | 0 |
| demo-line1 | 508 | 0 | 0 |

四个文本格式族（TEXT_SECTION_KV_RECORD / TEXT_POINT_LINE / TEXT_KEY_VALUE / TEXT_HNUM_COMMA_RECORD）均无任何 TransformMatrix 字段。

### 7.3 线路 MOD 坐标表达方式

线路 MOD 不通过矩阵变换定位坐标，而是将坐标以**绝对值**直接写入字段值：

#### TEXT_POINT_LINE 的 POINT 字段

```text
00512da5-91e0-4f65-8975-ab76de649380.mod:
  POINT1=1,26.57769030,112.62875108,81.959975,13
  POINT2=2,26.57775523,112.62872826,81.959975,13
  POINT3=3,26.57769941,112.62853199,81.959975,13
  POINT4=4,26.57763453,112.62855482,81.959975,13

格式：<序号>,<经度>,<纬度>,<高程>,<标识码>
```

#### TEXT_HNUM_COMMA_RECORD 的 P 字段

```text
013d9f8a-1065-489d-9d52-614a8d4a588c.mod:
  P1=7519.597693,-953.003542,56293.389910
  P2=13970.086400,-649.820596,54093.616930
  P3=-7519.595443,-953.003761,56293.390664

格式：<X>,<Y>,<Z>（笛卡尔坐标，单位推测为毫米）
```

### 7.4 工程类型对比

| 维度 | 变电工程（demo-substation） | 线路工程（demo-line / demo-line1） |
| ---- | ---------------------------- | ---------------------------------- |
| 变换模型 | XML Entity.TransformMatrix + 外部装配矩阵 | 无矩阵，坐标直接写入字段 |
| 坐标表达 | 相对坐标 + 矩阵变换 | 绝对坐标 |
| 坐标系 | 局部坐标系，需经矩阵变换到世界坐标 | 已是世界坐标（绝对值） |
| 几何复用 | 高复用：同 MOD 通过不同 placement 在多处放置 | 低复用：每个 MOD 文件已包含唯一坐标 |
| 单位 | 毫米（XML 中已确认） | 毫米（推测，未在 MOD 内确认） |

### 7.5 结论

```text
线路 MOD 完全不依赖 TransformMatrix 字段。
线路工程不采用"模型 + 矩阵"的装配模式，
而是把绝对坐标直接写入文本字段（POINTn / P）。
PHM 矩阵（恒为单位）对线路 MOD 也无影响。

变电工程采用"XML Entity + TransformMatrix + 外部装配矩阵"的两级装配模型，
线路工程采用"绝对坐标字段"的扁平模型，
两者在变换链结构上完全不同。
```

---

## 8. CBM TRANSFORMMATRIX 字段分布

> 本节为初版缺失内容，本次修订补充。CBM 节点的 `TRANSFORMMATRIX` 在初版中未分析，导致渲染管线忽略装配链路最上层的变换源。

### 8.1 字段语义

`cbmParser.ts` 把 `kv['TRANSFORMMATRIX']` 直接读入 `CbmNode.transformMatrix`（[cbmParser.ts:30](../../src/gim/cbmParser.ts#L30)）。CBM 树构建时通过三种键引用子节点（[cbmParser.ts:24-28](../../src/gim/cbmParser.ts#L24-L28)）：

```text
SUBSYSTEM                       project.cbm 单值形式
SUBSYSTEMS.NUM + SUBSYSTEMi     子 CBM 数组形式
SUBDEVICES.NUM + SUBDEVICEi     子 CBM（注意：CBM 中的 SUBDEVICES 仍指向 CBM/ 下文件）
```

DEV 文件引用通过 `OBJECTMODELPOINTER` 字段（[cbmParser.ts:30](../../src/gim/cbmParser.ts#L30)，`devPath = kv['OBJECTMODELPOINTER']`）。

### 8.2 数量统计

| 指标 | 数量 |
| ---- | ---: |
| CBM 文件总数 | 8701 |
| CBM 节点总数（递归遍历） | 8700 |
| 含 TRANSFORMMATRIX 字段的节点 | 4645（53.4%） |
| 不含 TRANSFORMMATRIX 字段的节点 | 4055（46.6%） |

### 8.3 矩阵分类

| 分类 | 数量 | 占比（含矩阵节点） |
| ---- | ---: | ---: |
| IDENTITY | 4360 | 93.9% |
| TRANSLATION_ONLY | 96 | 2.1% |
| ROTSCALE_ONLY | 0 | 0.0% |
| TRANSLATION+ROTSCALE | 189 | 4.1% |
| OTHER / INVALID | 0 | 0.0% |

### 8.4 非 IDENTITY 样本

```text
[4883d8d8-*.cbm] TRANSLATION+ROTSCALE
  T=(45758.924, 7382.144, 5750.000)
  raw: 0,1,0,0, -1,0,0,0, 0,0,1,0, 45758.924,7382.144,5750,1
  特征：绕 Z 轴 90° 旋转 + 平移

[3d243ce0-*.cbm] TRANSLATION+ROTSCALE
  T=(36808.924, 5582.144, 5750.000)
  raw: 0,-1,0,0, 1,0,0,0, 0,0,1,0, 36808.924,5582.144,5750,1
  特征：绕 Z 轴 -90° 旋转 + 平移
```

平移分量级数：Tx ≈ 36800–45700 mm（约 37–46 米），Ty ≈ 5500–7400 mm（约 5.5–7.4 米），Tz ≈ 5750 mm（约 5.75 米）。属于变电站内典型设备布置尺度。

### 8.5 结论

```text
1. CBM 层确实存在 TRANSFORMMATRIX 字段（4645 / 8700 = 53.4%），
   初版未覆盖此维度。
2. 含矩阵节点中 93.9% 为 IDENTITY，但仍有 6.1% 含实际变换
   （96 纯平移 + 189 平移+旋转），这些非单位矩阵在矩阵累乘时
   必须纳入链路，不能跳过。
3. 含矩阵节点与 OBJECTMODELPOINTER 引用 DEV 共存，
   表明 CBM 节点既是树形层级容器，也承载装配变换。
```

---

## 9. DEV TRANSFORMMATRIXn 字段分布

> 本节为初版缺失内容，本次修订补充。DEV 文件的 `SUBDEVICES` 块矩阵是整个变换链的"主变换源"。

### 9.1 字段语义

DEV 文件通过 `devParser.ts` 解析，两个块结构都会带 `TRANSFORMMATRIXi`：

- **SOLIDMODELS 块**：`SOLIDMODELS.NUM` + `SOLIDMODELi` + `TRANSFORMMATRIXi` —— 引用 PHM 或子 DEV 文件
- **SUBDEVICES 块**：`SUBDEVICES.NUM` + `SUBDEVICEi` + `TRANSFORMMATRIXi` —— 引用递归子 DEV 文件

[modGeometryDiscovery.ts](../../src/services/modGeometryDiscovery.ts) 沿这两个块累乘矩阵（`multiplyMatrices(parentTransform, devSolid.transformMatrix)` 与 `multiplyMatrices(parentTransform, sub.transformMatrix)`）。

### 9.2 SOLIDMODELS 块统计

| 指标 | 数量 |
| ---- | ---: |
| DEV 文件总数 | 4179 |
| 含 SOLIDMODELS 块的 DEV | 4179（100%） |
| SOLIDMODELS 总数 | 4179（每个 DEV 恰好 1 个） |

| 矩阵分类 | 数量 | 占比 |
| ---- | ---: | ---: |
| IDENTITY | 3993 | 95.5% |
| TRANSLATION_ONLY | 114 | 2.7% |
| ROTSCALE_ONLY | 0 | 0.0% |
| TRANSLATION+ROTSCALE | 72 | 1.7% |
| OTHER / INVALID / MISSING | 0 | 0.0% |

### 9.3 SUBDEVICES 块统计

| 指标 | 数量 |
| ---- | ---: |
| 含 SUBDEVICES 块的 DEV | 258（6.2%） |
| SUBDEVICES 总数 | 3894（平均每父 DEV 15.1 个子设备） |

| 矩阵分类 | 数量 | 占比 |
| ---- | ---: | ---: |
| IDENTITY | 476 | 12.2% |
| TRANSLATION_ONLY | 2577 | 66.2% |
| ROTSCALE_ONLY | 0 | 0.0% |
| TRANSLATION+ROTSCALE | 841 | 21.6% |
| OTHER / INVALID / MISSING | 0 | 0.0% |

### 9.4 非 IDENTITY 样本

```text
[00260eae-*.dev] SUBDEVICE 0  TRANSLATION_ONLY
  T=(129.452, -53.566, -7.000)
  subDevicePath = e5071d89-*.dev
  特征：纯平移，子设备在父设备装配体内偏移（129mm, -54mm, -7mm）

[00260eae-*.dev] SUBDEVICE 1..6  TRANSLATION_ONLY
  T=(129.452, -53.566, -70 / -133 / -196 / -259 / -322 / -385)
  subDevicePath = c5c9f5e1-.. / 85c02655-.. / be5d252b-.. / 4a145817-.. / 69256fa5-.. / 97290f6d-..
  特征：纯平移，Tz 以 63mm 间隔阶梯递减 —— 典型的同型设备间隔布置（绝缘子串/支柱）

[015b73a6-*.dev] SOLIDMODEL 0  TRANSLATION+ROTSCALE
  T=(230, -140.217, 1174.619)
  solidModelPath = 602e5540-*.phm
  特征：旋转 + 平移，PHM 在 DEV 装配体内的位置与方向
```

### 9.5 结论

```text
1. DEV SOLIDMODELS 块的矩阵 95.5% 为 IDENTITY，DEV → PHM 链路
   几乎不贡献变换 —— 与 §4 "PHM 不承担变换"结论一致：
   PHM 装配容器 + DEV 几乎不旋转，整个外部 placement 由更上层承担。

2. DEV SUBDEVICES 块的矩阵 87.8% 非 IDENTITY（66.2% 纯平移 +
   21.6% 平移+旋转），是整个变换链的"主变换源"。
   258 个含子设备的 DEV 父节点装配了 3894 个子设备实例，
   每个子设备带自己的 placement，构成了变电设备分层装配的核心。

3. SUBDEVICE 的平移量级（mm）：(129, -54, -7) 这类小幅平移
   表达子设备在父设备装配体内的相对位置，叠加多层后会累积到
   前述 CBM 层的数十米量级。

4. SUBDEVICE 旋转模式高度规律：同一 DEV 的多个 SUBDEVICE 共享
   旋转矩阵，仅平移不同（阶梯式间隔），表明同型设备
   （如支柱绝缘子、套管）通过矩阵复用而非几何复用实现。
```

---

## 10. CBM → DEV → SUBDEVICE → PHM → MOD 完整链路重建

> 本节为初版缺失内容，本次修订补充。完整链路重建是验证实例级 placement 多样性的关键。

### 10.1 链路重建算法

调研脚本 [transform-matrix-instance-analysis.ps1](./_generated/transform-matrix-instance-analysis.ps1) 实现完整链路重建：

```text
1. 从 CBM/project.cbm 递归遍历 CBM 树
   （支持 SUBSYSTEM / SUBSYSTEMS.NUM+SUBSYSTEMi / SUBDEVICES.NUM+SUBDEVICEi
    三种引用方式，与 cbmParser.ts 完全一致）
2. 每遇到 OBJECTMODELPOINTER，发起 Discover-From-Dev
3. Discover-From-Dev 递归处理：
   - DEV SOLIDMODELS：累乘 (parent × DEV_SOLID_MATRIX)
     - 若引用 .dev → 递归 Discover-From-Dev
     - 若引用 .phm → 进入 PHM 处理
   - DEV SUBDEVICES：累乘 (parent × SUBDEVICE_MATRIX) → 递归子 DEV
     （子 DEV 共享 visited 集合的拷贝，防止成环）
4. PHM 处理：累乘 (devTransform × PHM_MATRIX) → 收集 .mod/.stl 实例
5. 每个实例记录 (modPath, devPath, phmPath, placementTransform, kind)
```

### 10.2 实例级 placement 矩阵分类

| 矩阵分类 | 数量 | 占比 |
| ---- | ---: | ---: |
| IDENTITY | 0 | 0.00% |
| TRANSLATION_ONLY | 2206 | 22.36% |
| ROTSCALE_ONLY | 0 | 0.00% |
| TRANSLATION+ROTSCALE | 7660 | 77.64% |
| OTHER / INVALID / MISSING | 0 | 0.00% |
| **合计** | **9866** | **100%** |

```text
关键结论：
  链路重建后 0 个实例的 placement 为 IDENTITY。
  即：每个 MOD 实例都需要应用 placement matrix，没有"零变换"实例。
  这与 §6 PHM 层"PHM 矩阵恒为单位 → MOD Entity 直接承担最终变换"的单级
  假设完全不同：MOD Entity 承担的是局部变换，外部装配变换必须由
  CBM × DEV × SUBDEVICE × PHM 累乘得到。
```

### 10.3 非 IDENTITY 实例平移分量范围

| 分量 | 最小值（mm） | 最大值（mm） | 跨度（米） |
| ---- | -----------: | -----------: | ---------: |
| Tx | -58794.084 | 60753.114 | 119.5 |
| Ty | -50979.744 | 50828.816 | 101.8 |
| Tz | -31439.431 | 11241.984 | 42.7 |

平移跨度 100 米量级，符合变电站工程的整体空间尺度（典型 110kV/220kV 站区约 100m × 100m）。

### 10.4 矩阵存储约定复核

样本 `0,1,0,0, -1,0,0,0, 0,0,1,0, 45758.924,7382.144,5750,1`：

- 按 Three.js Matrix4.elements（列主序）解析：列 0 = (0,1,0,0)，列 1 = (-1,0,0,0)，列 2 = (0,0,1,0)，列 3 = (45758.924, 7382.144, 5750, 1) → 绕 Z 轴 90° 旋转 + 平移
- 平移位于 m[12..14]（最后一行，与 Three.js 一致）
- 与 §2 结论一致：列主序存储、平移在 m[12..14]

---

## 11. 实例多样性证据（关键）

> 本节为初版缺失内容，本次修订补充。这是解释"MOD 渲染覆盖 IFC"现象的核心证据。

### 11.1 总体统计

| 指标 | 数量 |
| ---- | ---: |
| 链路重建后总实例数 | 9866 |
| 唯一 MOD/STL 文件数 | 5938 |
| 平均每文件实例数 | 1.66 |
| 多实例文件数（instanceCount > 1） | 3928（66.2%） |
| 单实例文件数（instanceCount = 1） | 2010（33.8%） |

### 11.2 Top 10 多实例文件

| MOD 文件 | 实例数 | 不同矩阵数 |
| -------- | -----: | ---------: |
| 72c8865f-*.mod | 2 | 2 |
| aef262be-*.mod | 2 | 2 |
| 3259d7f8-*.mod | 2 | 2 |
| d252e7c2-*.mod | 2 | 2 |
| d6546d28-*.mod | 2 | 2 |
| a012669f-*.mod | 2 | 2 |
| f434d019-*.mod | 2 | 2 |
| 5fd9e52c-*.mod | 2 | 1 |
| 7220ab2b-*.mod | 2 | 2 |
| 7f004292-*.mod | 2 | 1 |

### 11.3 多实例样本

```text
[MOD/72c8865f-*.mod] 2 实例 / 2 不同矩阵
  实例 1: kind=TRANSLATION_ONLY  T=(31480.777, -43480.649, 6066.790)
          devPath=3e2511a0-*.dev  phmPath=72eeb90b-*.phm
  实例 2: kind=TRANSLATION_ONLY  T=(31480.777, -40930.797, 6216.768)
          devPath=3e2511a0-*.dev  phmPath=72eeb90b-*.phm
  特征：同 devPath+phmPath，但 placement 不同
        （Ty 差 2550mm，Tz 差 150mm → 同一 PHM 引用两次同 MOD，
         但因 SUBDEVICE 链路不同而 placement 不同）

[MOD/5fd9e52c-*.mod] 2 实例 / 1 不同矩阵
  实例 1: kind=TRANSLATION+ROTSCALE  T=(8198.601, -13109.948, -150)
  实例 2: kind=TRANSLATION+ROTSCALE  T=(8198.601, -13109.948, -150)
  特征：同 placement 但来自不同 CBM 节点 → CBM 树中两个节点
        引用同一 DEV 链路产生相同 placement（典型同型间隔布置）
```

### 11.4 关键结论

```text
1. 66.2% 的 MOD 文件被多个不同 placement 引用 —— 同 MOD 文件在
   工程中通过不同 CBM/DEV/SUBDEVICE 链路以不同位置放置多次。
   这是"几何复用 + 矩阵实例化"的装配模式，与 §7.4 所述
   变电工程的"高复用"特征一致，但初版未给出实例级量化证据。

2. 若以 modPath 为去重 key（即"文件唯一"假设），3928 个多实例文件
   会丢失额外 3928 个实例（9866 - 5938 = 3928，占实例总数 40%）。
   这正是"*.mod 渲染完全覆盖 IFC"的核心成因：
   丢失的实例本应通过 placement 出现在工程不同位置，但被去重逻辑
   静默丢弃，导致只有第一个实例的位置被填充，其余位置出现"空洞"
   或被错误位置的 MOD 图形占据。
   详见 [16-substation-transform-matrix-bugs.md](./16-substation-transform-matrix-bugs.md)。

3. 实例 placement 100% 非 IDENTITY（22% 纯平移 + 78% 平移+旋转），
   说明 placement 矩阵不可省略。
```

---

## 12. 单位处理与飘移分析

> 本节为初版缺失内容，本次修订补充。外部装配矩阵与 MOD Group 内部 0.001 缩放的交互是"叠加 DEV/PHM 矩阵后巨大飘移"的根因。
>
> **2026-07-11 更新**：方案 B（mergeGeometries 静态合并）实施后，生产路径已切换为顶点烘焙——mm→m 缩放与 placement matrix 都直接 applyMatrix4 到 BufferGeometry 顶点，绕过 `Object3D.applyMatrix4 + decompose` 链路，避免 placement 含缩放分量时 corrupt `group.scale`。本节同步更新。

### 12.1 MOD 内部 mm→m 缩放（顶点烘焙）

方案 B 实施后，mm→m 缩放通过 `collectBakedGeometriesByMaterial`（[xmlModGeometry.ts](../../src/viewer/xmlModGeometry.ts)）直接烘焙到每个 entity 的 cloned BufferGeometry 顶点：

```typescript
const mmToScene = new THREE.Matrix4().makeScale(0.001, 0.001, 0.001);
const baked = baseGeo.clone();
if (entity.transformMatrix.length === 16) {
  baked.applyMatrix4(gimMatrixToMatrix4(entity.transformMatrix));
}
baked.applyMatrix4(mmToScene);
```

`group.scale` 保持 1，merged geometry 顶点直接以场景单位（米）表达。STL 路径同样通过 `geometry.scale(0.001, 0.001, 0.001)` 烘焙到顶点（[stlLoader.ts](../../src/viewer/stlLoader.ts)）。

> 遗留：旧的 `xmlModDocumentToGroup` 仍保留 `group.scale.setScalar(0.001)`（方案 A 路径），仅被测试使用，生产不调用。

### 12.2 外部矩阵的应用路径

#### 12.2.1 路径 A：`applyPlacementTransformToSceneUnits`（顶点烘焙版，生产使用）

[xmlModLoader.ts](../../src/viewer/xmlModLoader.ts) 的实现（方案 B 后已改为顶点烘焙）：

```typescript
export function applyPlacementTransformToSceneUnits(
  group: THREE.Group,
  transformMatrix: number[] | null | undefined,
): void {
  if (!Array.isArray(transformMatrix) || transformMatrix.length !== 16) return;
  const matrix = rowMajorToMatrix4(transformMatrix);
  matrix.elements[12] *= GIM_MATRIX_TRANSLATION_TO_SCENE_UNIT;  // 0.001
  matrix.elements[13] *= GIM_MATRIX_TRANSLATION_TO_SCENE_UNIT;
  matrix.elements[14] *= GIM_MATRIX_TRANSLATION_TO_SCENE_UNIT;
  // 烘焙到顶点：避免 Object3D.applyMatrix4 + decompose 在 placement 含缩放时 corrupt group.scale
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.applyMatrix4(matrix);
    }
  });
}
```

**为何改为顶点烘焙**：`Object3D.applyMatrix4` 的实现是 `this.matrix.premultiply(matrix)` + `this.matrix.decompose(position, quaternion, scale)`。当 group 已有 `scale=0.001` 且 placement matrix 含缩放分量 `s` 时，`decompose` 会从 `matrix × Scale(0.001)` 提取 scale，导致 `group.scale` 被错误修改为 `0.001 × s`，几何被错误缩放。变压器 placement 通常纯旋转+平移（`s=1`）所以 OK；GIS 设备 placement 含缩放分量，触发 corrupt。改为顶点烘焙后，`BufferGeometry.applyMatrix4` 直接对 position attribute 操作，不经过 decompose，数学上精确。

平移分量先乘 0.001 再 applyMatrix4，得到米单位的平移。**生产代码全部走此路径**：

- [modAutoLoadService.ts](../../src/services/modAutoLoadService.ts)（自动加载）
- [nodeInteractionService.ts](../../src/services/nodeInteractionService.ts)（节点点击懒加载）

#### 12.2.2 路径 B：`applyExternalTransforms`（已删除）

`applyExternalTransforms` 函数**已从源码中删除**。此函数原先直接 `group.applyMatrix4` 不缩放平移，且输入参数不含 CBM/SUBDEVICE 累积，无法表达完整 placement。详见 [16-substation-transform-matrix-bugs.md](./16-substation-transform-matrix-bugs.md) §2.2。

### 12.3 飘移成因总结

```text
"叠加 DEV/PHM 矩阵会巨大飘移"的原因有三：
  1. 早期实现调用 applyExternalTransforms（已删除），平移未缩放
  2. 旧版 applyPlacementTransformToSceneUnits 使用 group.applyMatrix4，
     当 placement 含缩放分量时 decompose corrupt group.scale（已修复为顶点烘焙）
  3. DEV_SUBDEVICE 虚拟节点 transformMatrix 为空，丢失 SUBDEVICE 变换
     （已修复：虚拟节点携带 SUBDEVICE.transformMatrix，且不作为几何 seed）
```

---

## 13. 与基线对照总结

### 13.1 一致项

| 检查项 | 期望 | 实证 |
| ------ | ---- | ---- |
| PHM `SOLIDMODELn` 与 `TRANSFORMMATRIXn` 一一对应 | 严格对应 | 3 样本 0 例不匹配 |
| 变电 MOD Entity 全部含 `TransformMatrix` | 100% 含 | 46250 / 46250 = 100% |
| 变电 `Entity.TransformMatrix` 16 浮点数 | 16 个 | 全部 16 个 |
| `dev.md` 提到的整数矩阵形式（变电） | 整数 | 部分样本为整数 |
| `phm.md` 提到的浮点矩阵形式（线路） | 浮点 | 全部浮点 |
| PHM 矩阵 100% 单位矩阵 | 全部样本 | demo-line / demo-line1 / demo-substation 一致 |

### 13.2 差异项

| 检查项 | 文档描述 | 实证 |
| ------ | -------- | ---- |
| 矩阵存储约定 | 行优先，平移在最后一列 `m[3]/m[7]/m[11]` | 列主序，平移在最后一行 `m[12]/m[13]/m[14]` |
| PHM 矩阵作用 | 装配变换（与 SOLIDMODEL 对应） | 全部为单位，PHM 层无实际变换 |
| 变电 MOD Entity 矩阵作用 | 本地变换 | 承担"局部"变换（76% 非单位，MOD 文件内部 Entity 相对位置） |
| CBM 矩阵作用（初版未涉及） | - | 53.4% 节点含矩阵，6.1% 非单位（装配链路顶层） |
| DEV SUBDEVICES 矩阵作用（初版未涉及） | - | 87.8% 非单位（主变换源） |

### 13.3 异常项

无异常项。三个样本的矩阵结构均与可验证范围一致，未发现格式错乱或字段缺失。

### 13.4 初版结论修正

| 检查项 | 初版结论 | 修订结论 |
| ------ | -------- | -------- |
| PHM 矩阵作用 | 全部为单位，无实际变换 | **保留**：PHM 层 100% 单位，但仅是装配链路中的一环 |
| 变电两级变换假设 | 不成立，实际为单级变换 | **修正**：PHM × MOD Entity 两级假设不成立，但完整链路 CBM×DEV×SUBDEVICE×PHM × MOD Entity 是两级变换（装配级 + 局部级） |
| 渲染管线实现 | PHM 矩阵可跳过，直接用 MOD Entity | **修正**：PHM 矩阵可跳过，但必须应用 CBM×DEV×SUBDEVICE×PHM 累积矩阵，再乘 MOD Entity 局部矩阵 |

---

## 14. 当前结论

```text
1. PHM 的 TRANSFORMMATRIXn 在三个样本中 100% 是单位矩阵，
   与 SOLIDMODELn 一一对应但语义为空。PHM 层不承担几何变换。

2. PHM 不承担几何变换，仅起"装配容器"作用。但 PHM 仅是装配链路中的
   一环，不能据此推广为"整个外部装配链路无变换"。

3. 变电 MOD XML Entity.TransformMatrix 承担"局部"变换：
   - 23.55% 单位矩阵
   - 20.44% 纯平移
   - 56.00% 平移 + 旋转/缩放
   - 0.01% 仅旋转/缩放
   局部变换表达 MOD 文件内部 Entity 之间的相对位置（5–15 米尺度）。

4. CBM 层存在 TRANSFORMMATRIX 字段（53.4% 节点含矩阵），
   其中 6.1% 为非单位矩阵，平移量级达数十米，是装配链路不可忽略的一环。

5. DEV SOLIDMODELS 块的矩阵 95.5% 为 IDENTITY，
   DEV → PHM 链路几乎不贡献变换。

6. DEV SUBDEVICES 块的矩阵 87.8% 非 IDENTITY
   （66.2% 纯平移 + 21.6% 平移+旋转），
   是整个变换链的"主变换源"。
   258 个父 DEV 装配了 3894 个子设备实例。

7. 沿 CBM → DEV → SUBDEVICE → PHM → MOD 完整链路重建后：
   - 总实例数 9866（vs. 唯一 MOD 文件 5938）
   - 66.2% 的 MOD 文件被多个不同 placement 引用
   - 100% 实例的 placement 非 IDENTITY
   - 平移跨度：Tx/Ty ≈ 100m、Tz ≈ 43m（变电站工程典型尺度）

8. 变电工程实际为两级变换（修正初版"单级变换"结论）：
   - 局部级：MOD Entity.TransformMatrix（§5）
   - 装配级：CBM × DEV_SOLID × SUBDEVICE × PHM 累积矩阵（§8-§10）
   最终变换 = 装配矩阵 × 局部矩阵
   其中装配矩阵 100% 非 IDENTITY（22% 纯平移 + 78% 平移+旋转），不可省略。

9. 线路 MOD 完全不依赖 TransformMatrix 字段，
   坐标以绝对值写入 POINTn（经纬度高程）或 P（笛卡尔）字段。

10. GIM 矩阵 16 浮点数采用列主序存储（Three.js / OpenGL 风格），
    平移分量在 m[12]/m[13]/m[14]，
    与 dev.md / phm.md 中"行优先、平移在最后一列"的描述矛盾，需修正。

11. 单位处理：applyPlacementTransformToSceneUnits 已改为顶点烘焙
    （方案 B 后），mm→m 缩放在 collectBakedGeometriesByMaterial 中烘焙到顶点。
    applyExternalTransforms 已从源码删除。

12. 已知 bug：modAutoLoadService.ts 用 modPath 去重导致丢失实例。
    已修复：改用 instanceKey（含 placement）去重。
    详见 [16-substation-transform-matrix-bugs.md](./16-substation-transform-matrix-bugs.md)。
    （注：早期"9866 → 5938 丢失 40%"的数字已被 2026-07-10 更正撤销，
     正确基线为 4135 MOD + 1803 STL = 5938，详见 20 号文档。）

13. 变电与线路工程在变换链结构上完全不同：
    - 变电：两级变换 = 装配级（CBM×DEV×SUBDEVICE×PHM）+ 局部级（MOD Entity）
    - 线路：无矩阵变换，绝对坐标字段
```

---

## 15. 浏览器实现影响

```text
1. PHM 矩阵可跳过乘法运算：
   PHM 矩阵恒为单位，乘法无意义。
   （此条与初版一致。）

2. 装配级矩阵不可省略（修正初版）：
   渲染管线必须应用 CBM × DEV_SOLID × SUBDEVICE × PHM 累积矩阵，
   再乘 MOD Entity.TransformMatrix 作为最终变换。
   不可仅用 PHM 矩阵（恒为单位）也不可仅用 DEV SOLID 矩阵
   （95.5% 单位、贡献不足）。
   SUBDEVICE 是主变换源，必须递归处理。

3. 实例级去重必须使用 instanceKey（含 placement）：
   不可用 modPath 去重，否则丢失多实例。
   已修复：modAutoLoadService 使用 instanceKey 去重。
   详见 [16-substation-transform-matrix-bugs.md](./16-substation-transform-matrix-bugs.md)。

4. 变电 MOD 渲染 Entity.TransformMatrix 已在烘焙阶段应用：
   方案 B 后，collectBakedGeometriesByMaterial 把 Entity.TransformMatrix
   直接 applyMatrix4 到 cloned BufferGeometry 顶点，再叠加 mm→m 缩放。
   placement matrix 由 applyPlacementTransformToSceneUnits 顶点烘焙叠加。

5. 线路 MOD 渲染无需矩阵处理：
   直接读取 POINTn / P 字段的绝对坐标。
   POINT 字段为经纬度高程，需做地图投影；
   P 字段为笛卡尔坐标，单位推测毫米。

6. 单位处理（方案 B 后）：
   mm→m 缩放在 collectBakedGeometriesByMaterial 中烘焙到顶点。
   placement matrix 在 applyPlacementTransformToSceneUnits 中顶点烘焙。
   applyExternalTransforms 已删除。

7. 矩阵存储约定修正后：
   现有 dev.md / phm.md 中的"最后一列控制平移"描述需改为
   "最后一行 m[12]/m[13]/m[14] 控制平移"，
   与 Three.js Matrix4.elements 数组布局一致。
```

---

## 16. 当前不能得出的结论

```text
1. 不能确认 GIM 矩阵的数学约定是 OpenGL 列主序还是 D3D 行主序。
   实证只表明 16 浮点数组的存储位置：平移在 m[12..14]。
   要严格区分"行主序存储的列主序矩阵"还是"列主序存储的行主序矩阵"，
   需要至少一个含旋转的样本并验证 v' = M × v 还是 v' = v × M。

2. 不能确认线路 MOD 的 POINT 字段经纬度格式是否为 WGS84。
   仅从数值范围（26.xxx, 112.xxx）推测为中国境内经纬度，
   未与 IFC GlobalID 坐标系对照。

3. 不能确认 TEXT_HNUM_COMMA_RECORD 的 P 字段单位。
   推测为毫米（与变电 MOD XML 一致），但样本未含单位声明字段。

4. 不能确认是否所有 GIM 工程的 PHM 矩阵恒为单位。
   三个样本中 100% 是单位矩阵，但样本数有限，
   不能排除其他工程（如电缆隧道、地下管网）的 PHM 含非单位矩阵。

5. 不能确认变电 MOD Entity.TransformMatrix 的旋转是否为正交矩阵。
   抽样显示部分矩阵含 1e-16 量级小数（如 -1.22464679914735E-16），
   为浮点误差范围内的正交矩阵，但未做严格正交性校验。

6. 不能确认所有变电工程的 CBM TRANSFORMMATRIX 命中率均为 53%。
   本样本 4645/8700，但其他工程可能因 CBM 树深度不同而异。

7. 不能确认 DEV SUBDEVICES 嵌套深度对最终 placement 的贡献比例。
   本分析仅累乘矩阵，未按 SUBDEVICE 嵌套层数分组统计每层贡献。

8. 不能确认 instanceKey 与 placement 的一一对应关系。
   Top 10 中部分文件 2 实例但 1 矩阵（如同 CBM 节点重复引用），
   部分文件 2 实例 2 矩阵。需进一步分析 instanceKey 的构造规则。

9. 不能确认初版"两级变换假设不成立"的结论在修正后是否完全推翻。
   初版假设是 PHM × MOD Entity，本文档证明外部链路
   （CBM×DEV×SUBDEVICE×PHM）非 IDENTITY，
   但 PHM 本身仍为单位，初版在 PHM 层面的结论依然成立。
```

---

## 17. 后续建议

```text
1. ~~修复 modAutoLoadService.ts 去重 bug（高优先级）~~ ✅ 已完成
   diff: modMap.has(modGeo.modPath) → modMap.has(modGeo.instanceKey)
   同步修复 stlMap.has(geo.stlPath) → stlMap.has(geo.instanceKey)
   详见 [16-substation-transform-matrix-bugs.md](./16-substation-transform-matrix-bugs.md)。

2. ~~弃用 applyExternalTransforms（中优先级）~~ ✅ 已删除
   函数已从源码中删除。生产路径全部走 applyPlacementTransformToSceneUnits（顶点烘焙版）。
   详见 [16-substation-transform-matrix-bugs.md](./16-substation-transform-matrix-bugs.md)。

3. 修正 dev.md 与 phm.md 中"行优先、平移在最后一列"的描述，
   改为"16 浮点数列主序展开，平移在 m[12]/m[13]/m[14]"，
   并补充与 Three.js Matrix4.elements 的对应关系。

4. 修正 devParser.ts / phmParser.ts 注释的"行主序/列主序"矛盾，
   统一为"列主序、平移在 m[12..14]"。
   注：rowMajorToMatrix4 函数命名与实际语义存在歧义，需在 parser 层修正注释。

5. 未来渲染管线实现时，必须应用完整装配矩阵：
   placementTransform = CBM × DEV_SOLID × SUBDEVICE × PHM
   finalTransform = placementTransform × MOD_Entity_TransformMatrix
   不可跳过装配矩阵乘法（与初版建议相反）。

6. 后续若有新 GIM 样本，使用 gim-sample-verification skill 验证：
   - PHM 矩阵是否仍 100% 为单位
   - CBM TRANSFORMMATRIX 命中率
   - DEV SUBDEVICES 非单位矩阵占比
   - 多实例 MOD 文件比例
   - MOD Entity.TransformMatrix 分类分布是否在合理范围
   - 矩阵存储约定是否仍为列主序

7. 对线路工程 POINT 字段的经纬度格式做坐标系确认，
   与 IFC GlobalID 坐标系或 OSM 底图做对照。

8. 对 TEXT_HNUM_COMMA_RECORD 的 P 字段单位做确认，
   与杆塔 H 字段（如 H,27000）做量纲一致性检查。

9. 撰写实例级 instanceKey 构造规则文档
   现有 instanceKey 由 modGeometryDiscovery.ts 生成，
   需明确其与 (modPath, placementTransform) 的对应关系，
   指导去重逻辑与缓存键设计。
```

---

## 附录 A：分析脚本

### A.1 主分析脚本（PHM × MOD Entity）

文件：`docs/schema/_generated/transform-chain-analysis.ps1`

功能：扫描三 demo 的 PHM 与 MOD 文件，分析变换矩阵的存储约定、分类分布、PHM × MOD 两级变换关系、线路 MOD 矩阵依赖。

入口命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  "D:\vibe-coding\gim_viewer\docs\schema\_generated\transform-chain-analysis.ps1"
```

输出（写入 `transform-chain-output.txt`）：

```text
- 三 demo PHM 矩阵计数与分类
- 三 demo SOLIDMODELn / TRANSFORMMATRIXn 对应关系
- demo-substation MOD XML Entity 矩阵分类与平移分量分布
- 抽样 20 对 PHM × MOD Entity 矩阵组合
- 线路 MOD 矩阵字段检测（包括 XML 标签）
- 线路 MOD POINT / P 字段坐标抽样
```

### A.2 实例级链路分析脚本（CBM × DEV × SUBDEVICE × PHM × MOD）

文件：`docs/schema/_generated/transform-matrix-instance-analysis.ps1`

功能：补充主分析脚本未覆盖的维度，沿完整链路重建实例级 placement 矩阵。

入口命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  "D:\vibe-coding\gim_viewer\docs\schema\_generated\transform-matrix-instance-analysis.ps1"
```

输出（写入 `transform-matrix-instance-analysis-demo-substation.json`）：

```text
- CBM 节点 TRANSFORMMATRIX 字段分布（§8）
- DEV 文件 SOLIDMODELS / SUBDEVICES 块的 TRANSFORMMATRIXn 分布（§9）
- PHM 文件 TRANSFORMMATRIXn 分布（复核 §4）
- CBM → DEV → SUBDEVICE → PHM → MOD 链路重建（§10）
- 实例多样性统计（§11）
- 单位处理分析所需的代码路径证据（§12）
```

### A.3 脚本关键函数

| 函数 | 功能 |
| ---- | ---- |
| `Read-TextFileLoose` | 读取文件并自动去除 UTF-8 BOM |
| `Parse-KeyValue` | 解析 KEY=VALUE 键值对（支持 # ; 注释） |
| `Parse-Matrix` | 解析 16 个浮点数为 double 数组 |
| `Classify-Matrix` | 按 IDENTITY / TRANSLATION_ONLY / ROTSCALE_ONLY / TRANSLATION+ROTSCALE / OTHER 分类 |
| `Extract-Translation` | 提取平移分量 (m[12], m[13], m[14]) |
| `Multiply-Matrix` | 行主序 4x4 矩阵乘法（仅用于实例统计，运行时由 Three.js 处理） |
| `Parse-CbmNode` | 递归遍历 CBM 树（支持 SUBSYSTEM / SUBSYSTEMS / SUBDEVICES 三种引用） |
| `Discover-From-Dev` | 沿 DEV SOLIDMODELS / SUBDEVICES 递归发现 MOD/STL 实例 |
| `Walk-CbmTree-For-Discovery` | 从 CBM 根发起链路重建 |
| `Analyze-PhmMatrices` | 扫描 PHM 文件，统计 SOLIDMODELn / TRANSFORMMATRIXn / COLORn 一一对应与矩阵分类 |
| `Analyze-SubstationModXmlMatrices` | 解析变电 MOD XML Entity.TransformMatrix |
| `Analyze-TwoLevelTransform` | 抽样 PHM × MOD Entity 矩阵对，验证 PHM 层两级变换假设 |
| `Analyze-LineModMatrixField` | 检测线路 MOD 是否含 TransformMatrix 字段或 XML 标签 |

### A.4 矩阵分类规则

```text
IDENTITY
  16 个值严格等于 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1
  容差：1e-6

TRANSLATION_ONLY
  3x3 旋转/缩放部分（m[0..2], m[4..6], m[8..10]）为单位矩阵
  且平移分量（m[12], m[13], m[14]）至少有一个非零

ROTSCALE_ONLY
  3x3 旋转/缩放部分非单位
  且平移分量全为零

TRANSLATION+ROTSCALE
  3x3 旋转/缩放部分非单位
  且平移分量至少有一个非零

OTHER
  其他（不应出现的异常情况）

INVALID
  无法解析为 16 个浮点数

MISSING
  字段缺失（仅 DEV/PHM 块统计用）
```

### A.5 输出产物

| 文件 | 内容 |
| ---- | ---- |
| `transform-chain-analysis.ps1` | 主分析脚本（PHM × MOD Entity） |
| `transform-chain-output.txt` | 主脚本输出（Start-Transcript 捕获） |
| `transform-matrix-instance-analysis.ps1` | 实例级链路分析脚本（CBM × DEV × SUBDEVICE × PHM × MOD） |
| `transform-matrix-instance-analysis-demo-substation.json` | 实例级分析 JSON 输出 |

> 主脚本使用 `Start-Transcript` 捕获所有 `Write-Host` 输出，避免 PowerShell 管道 CLIXML 编码问题。
> 实例级脚本兼容 PowerShell 5.1：不使用 pwsh、§ 字符、scriptblock 调用语法；空数组使用 `@(...)` 强制数组化避免 `.Count` 报错；`[int]::TryParse` 替代 `[int]::Parse` 容错。
