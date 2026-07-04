# PHM 与 MOD 变换链分析

> 本文档基于三个 demo 样本（`demo-line`、`demo-line1`、`demo-substation`）对 GIM 工程中 PHM 与 MOD 的变换矩阵组合关系进行系统性梳理。每个分析维度下对比变电工程与线路工程的异同。
>
> 本报告不进入几何渲染实现，也不解释坐标系语义、单位换算、轴方向约定或三维构件拓扑。所有分析脚本集中放在文末附录 A。

## 1. 分析目标与范围

### 1.1 目标

确认 PHM 的 `TRANSFORMMATRIXn` 与 MOD 内部变换字段（变电 XML `Entity.TransformMatrix`）是否构成两级变换，以及线路 MOD 是否依赖 PHM 矩阵。

### 1.2 分析对象

```text
demo-line        线路工程样本 A
demo-line1       线路工程样本 B
demo-substation  变电工程样本
```

### 1.3 分析范围

```text
PHM 中 TRANSFORMMATRIXn 的数量、维度、值分布
PHM 中 SOLIDMODELn 与 TRANSFORMMATRIXn 的一一对应关系
PHM TRANSFORMMATRIX 的矩阵分类（单位 / 平移 / 旋转+缩放 / 组合）
变电 MOD XML Entity.TransformMatrix 的矩阵分类
PHM 矩阵 × MOD Entity 矩阵的组合分布
线路 MOD 是否依赖 TransformMatrix 字段
矩阵存储约定（行优先 / 列优先 / 平移分量位置）
```

### 1.4 核心判断

```text
PHM 在三个样本中 100% 是单位矩阵，不承担任何几何变换。
PHM 的 TRANSFORMMATRIXn 仅起"占位"作用，与 SOLIDMODELn 一一对应但语义为空。
变电 MOD XML Entity.TransformMatrix 承担全部本地变换（76% 非单位）。
"PHM placement + MOD local transform"的两级变换假设不成立，实际是单级变换。
线路 MOD 完全不依赖 TransformMatrix 字段，坐标以绝对值写在 POINTn / P 行中。
GIM 矩阵 16 浮点数采用列主序存储（Three.js / OpenGL 风格），平移在 m[12..14]，
与 dev.md / phm.md 中"行优先、平移在最后一列"的描述存在矛盾，需修正。
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

平移范围跨越 1 万至 1.4 万毫米（10-14 米），符合变电设备的空间布置尺度。

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
  MOD Entity.TransformMatrix 承担全部本地变换。
  76% 的 Entity 含实际变换（平移/旋转/缩放）。
  56% 同时含平移 + 旋转/缩放（典型设备组装场景）。
  20% 是纯平移（构件偏移）。
  仅 24% 是单位矩阵（无需变换的本地原点构件）。

线路工程：
  MOD 完全无 TransformMatrix 字段（详见 Section 7）。
  本地变换模型不存在。
```

---

## 6. PHM × MOD 两级变换关系

### 6.1 假设

```text
两级变换假设：
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
  两级变换假设不成立。
  PHM 矩阵恒为单位，不贡献任何 placement。
  实际为单级变换：MOD Entity.TransformMatrix 即最终变换。
  PHM 仅起"装配容器"作用，把 MOD 文件与 COLOR 绑定。

线路工程：
  PHM 矩阵也恒为单位（详见 Section 4）。
  MOD 无 TransformMatrix 字段（详见 Section 7）。
  实际无任何矩阵变换层级，坐标直接以绝对值写入文本字段。
```

### 6.6 结论

```text
"PHM placement + MOD Entity local transform"的两级变换假设在三个样本中均不成立。

实际变换模型：
  变电工程：单级变换 = MOD Entity.TransformMatrix
  线路工程：无矩阵变换，坐标以绝对值写入 POINTn / P 字段

PHM 的 TRANSFORMMATRIXn 字段在三个样本中均为冗余占位，
未来渲染实现可忽略 PHM 矩阵乘法，直接使用 MOD Entity 矩阵。
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
| 变换模型 | XML Entity.TransformMatrix | 无矩阵，坐标直接写入字段 |
| 坐标表达 | 相对坐标 + 矩阵变换 | 绝对坐标 |
| 坐标系 | 局部坐标系，需经矩阵变换到世界坐标 | 已是世界坐标（绝对值） |
| 几何复用 | 高复用：同 MOD 通过不同 Entity 矩阵放置在不同位置 | 低复用：每个 MOD 文件已包含唯一坐标 |
| 单位 | 毫米（XML 中已确认） | 毫米（推测，未在 MOD 内确认） |

### 7.5 结论

```text
线路 MOD 完全不依赖 TransformMatrix 字段。
线路工程不采用"模型 + 矩阵"的装配模式，
而是把绝对坐标直接写入文本字段（POINTn / P）。
PHM 矩阵（恒为单位）对线路 MOD 也无影响。

变电工程采用"XML Entity + TransformMatrix"的本地变换模型，
线路工程采用"绝对坐标字段"的扁平模型，
两者在变换链结构上完全不同。
```

---

## 8. 与基线对照总结

### 8.1 一致项

| 检查项 | 期望 | 实证 |
| ------ | ---- | ---- |
| PHM `SOLIDMODELn` 与 `TRANSFORMMATRIXn` 一一对应 | 严格对应 | 3 样本 0 例不匹配 |
| 变电 MOD Entity 全部含 `TransformMatrix` | 100% 含 | 46250 / 46250 = 100% |
| 变电 `Entity.TransformMatrix` 16 浮点数 | 16 个 | 全部 16 个 |
| `dev.md` 提到的整数矩阵形式（变电） | 整数 | 部分样本为整数 |
| `phm.md` 提到的浮点矩阵形式（线路） | 浮点 | 全部浮点 |

### 8.2 差异项

| 检查项 | 文档描述 | 实证 |
| ------ | -------- | ---- |
| 矩阵存储约定 | 行优先，平移在最后一列 `m[3]/m[7]/m[11]` | 列主序，平移在最后一行 `m[12]/m[13]/m[14]` |
| PHM 矩阵作用 | 装配变换（与 SOLIDMODEL 对应） | 全部为单位，无实际变换 |
| 变电 MOD Entity 矩阵作用 | 本地变换 | 承担全部变换（76% 非单位） |

### 8.3 异常项

无异常项。三个样本的矩阵结构均与 Round 5 假设可验证范围一致，未发现格式错乱或字段缺失。

---

## 9. 当前结论

```text
1. PHM 的 TRANSFORMMATRIXn 在三个样本中 100% 是单位矩阵，
   与 SOLIDMODELn 一一对应但语义为空。
2. PHM 不承担几何变换，仅起"装配容器"作用。
3. 变电 MOD XML Entity.TransformMatrix 承担全部本地变换：
   - 23.55% 单位矩阵
   - 20.44% 纯平移
   - 56.00% 平移 + 旋转/缩放
   - 0.01% 仅旋转/缩放
4. "PHM placement + MOD local transform"的两级变换假设不成立，
   实际为单级变换（变电）或无变换（线路）。
5. 线路 MOD 完全不依赖 TransformMatrix 字段，
   坐标以绝对值写入 POINTn（经纬度高程）或 P（笛卡尔）字段。
6. GIM 矩阵 16 浮点数采用列主序存储（Three.js / OpenGL 风格），
   平移分量在 m[12]/m[13]/m[14]，
   与 dev.md / phm.md 中"行优先、平移在最后一列"的描述矛盾，需修正。
7. 三个样本的 PHM 矩阵分类结果完全一致（100% 单位），
   跨样本稳定性高。
8. 变电与线路工程在变换链结构上完全不同：
   - 变电：单级变换 = MOD Entity.TransformMatrix
   - 线路：无矩阵变换，绝对坐标字段
```

---

## 10. 浏览器实现影响

```text
1. 渲染管线可忽略 PHM 矩阵乘法：
   PHM 矩阵恒为单位，乘法无意义。

2. 变电 MOD 渲染只需应用 Entity.TransformMatrix：
   不需要从 PHM 累积变换。
   Three.js 可直接使用 m[0..15] 作为 Matrix4.elements（布局一致）。

3. 线路 MOD 渲染无需矩阵处理：
   直接读取 POINTn / P 字段的绝对坐标。
   POINT 字段为经纬度高程，需做地图投影；
   P 字段为笛卡尔坐标，单位推测毫米。

4. 矩阵存储约定修正后：
   现有 dev.md / phm.md 中的"最后一列控制平移"描述需改为
   "最后一行 m[12]/m[13]/m[14] 控制平移"，
   与 Three.js Matrix4.elements 数组布局一致。
```

---

## 11. 当前不能得出的结论

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
```

---

## 12. 后续建议

```text
1. 修正 dev.md 与 phm.md 中"行优先、平移在最后一列"的描述，
   改为"16 浮点数列主序展开，平移在 m[12]/m[13]/m[14]"，
   并补充与 Three.js Matrix4.elements 的对应关系。

2. 未来渲染管线实现时，PHM 矩阵可跳过乘法运算，
   直接使用 MOD Entity.TransformMatrix 作为最终变换矩阵。

3. 后续若有新 GIM 样本，使用 gim-sample-verification skill 验证：
   - PHM 矩阵是否仍 100% 为单位
   - MOD Entity.TransformMatrix 分类分布是否在合理范围
   - 矩阵存储约定是否仍为列主序

4. 对线路工程 POINT 字段的经纬度格式做坐标系确认，
   与 IFC GlobalID 坐标系或 OSM 底图做对照。

5. 对 TEXT_HNUM_COMMA_RECORD 的 P 字段单位做确认，
   与杆塔 H 字段（如 H,27000）做量纲一致性检查。
```

---

## 附录 A：分析脚本

### A.1 主分析脚本

文件：`docs/schema/_generated/transform-chain-analysis.ps1`

功能：扫描三 demo 的 PHM 与 MOD 文件，分析变换矩阵的存储约定、分类分布、两级变换关系、线路 MOD 矩阵依赖。

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

### A.2 脚本关键函数

| 函数 | 功能 |
| ---- | ---- |
| `Read-TextFileLoose` | 读取文件并自动去除 UTF-8 BOM |
| `Parse-Matrix` | 解析 16 个浮点数为 double 数组 |
| `Classify-Matrix` | 按 IDENTITY / TRANSLATION_ONLY / ROTSCALE_ONLY / TRANSLATION+ROTSCALE / OTHER 分类 |
| `Extract-Translation` | 提取平移分量 (m[12], m[13], m[14]) |
| `Analyze-PhmMatrices` | 扫描 PHM 文件，统计 SOLIDMODELn / TRANSFORMMATRIXn / COLORn 一一对应与矩阵分类 |
| `Analyze-SubstationModXmlMatrices` | 解析变电 MOD XML Entity.TransformMatrix |
| `Analyze-TwoLevelTransform` | 抽样 PHM × MOD Entity 矩阵对，验证两级变换假设 |
| `Analyze-LineModMatrixField` | 检测线路 MOD 是否含 TransformMatrix 字段或 XML 标签 |

### A.3 矩阵分类规则

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
```

### A.4 输出产物

| 文件 | 内容 |
| ---- | ---- |
| `transform-chain-analysis.ps1` | 主分析脚本 |
| `transform-chain-output.txt` | 脚本输出（Start-Transcript 捕获） |

> 脚本使用 `Start-Transcript` 捕获所有 `Write-Host` 输出，避免 PowerShell 管道 CLIXML 编码问题。
