# MOD 静态分型与可解析性边界分析

> 本文档为 GIM 工程 `.mod` 文件的静态分型分析报告。基于三个 demo 样本（`demo-line`、`demo-line1`、`demo-substation`）对 MOD 文件的表层格式、字段形态、上游引用关系、孤儿资源与浏览器解析边界进行系统性梳理。每个分析维度下对比变电工程与线路工程的异同。
>
> 本报告不进入几何渲染实现，也不解释坐标系、矩阵行列主序或具体三维构件语义。所有分析脚本集中放在文末附录 A。

## 1. 分析目标与范围

### 1.1 目标

确认 MOD 文件具体属于哪些格式族，并梳理不同工程类型下 MOD 的表层格式、字段形态、上游引用关系和浏览器侧解析边界。

### 1.2 分析对象

```text
demo-line        线路工程样本 A
demo-line1       线路工程样本 B
demo-substation  变电工程样本
```

### 1.3 分析范围

```text
MOD 文件静态分类
线路 MOD 文本格式族分析
变电 MOD XML 结构分析
MOD 与 PHM 引用关系
MOD 与 CBM entityName 的上游映射
EMPTY_DEVICE_XML / orphan MOD 分析
XML Entity / primitive / TransformMatrix / Color / Visible 字段形态分析
```


### 1.5 核心判断

```text
MOD 不是单一格式。
两个线路样本（demo-line / demo-line1）MOD 是相同的 4 种文本格式族。
变电样本（demo-substation）MOD 是 XML Device / Entities / Entity / primitive 格式族，另有 44 个未引用的 EMPTY_DEVICE_XML。
demo-line1 存在 148 个 CBM 链不可达的 TEXT_POINT_LINE 孤儿 MOD（PHM 引用、DEV 孤儿）。
```

---

## 2. MOD 静态分类方法

使用只读 PowerShell 脚本扫描 `.mod` 文件，按文件内容做静态分类。分类规则如下：

```text
EMPTY
  文件内容为空。

EMPTY_DEVICE_XML
  XML root 为 Device，Entities 为空：
  <Device>
    <Entities />
  </Device>

XML_WITH_ENTITIES
  XML root 为 Device，且 /Device/Entities 下存在 Entity。

TEXT_POINT_LINE
  文本中存在 CODE / POINTNUM / LINENUM / POINTn / LINEn 等点线字段。

TEXT_SECTION_KV_RECORD
  第一行是 section header，后续是 key=value 记录。
  当前线路样本中该类 header 全部为 Bolt。

TEXT_KEY_VALUE
  主要由 key=value 行构成，没有独立 section header。

TEXT_HNUM_COMMA_RECORD
  第一行为 HNum,n，后续为逗号分隔记录。
  当前样本中包含 H / Body / HBody / HLeg / HSubLeg / P / R / G 等 token。
```

入口命令与脚本实现见附录 A.1。

---

## 3. MOD 静态分型总览

### 3.1 三样本分类结果对比

| MOD kind                 |   demo-line |   demo-line1 |   demo-substation | 工程类型 |
| ------------------------ | ----------: | -----------: | ----------------: | -------- |
| XML_WITH_ENTITIES        |           0 |            0 |              4135 | 变电     |
| EMPTY_DEVICE_XML         |           0 |            0 |                44 | 变电     |
| TEXT_SECTION_KV_RECORD   |        1300 |          156 |                 0 | 线路     |
| TEXT_POINT_LINE          |         315 |          300 |                 0 | 线路     |
| TEXT_KEY_VALUE           |         161 |           34 |                 0 | 线路     |
| TEXT_HNUM_COMMA_RECORD   |          31 |           18 |                 0 | 线路     |
| **合计**                 |      **1807** |  **508** |            **4179** |          |

### 3.2 工程类型对比

| 维度         | 变电工程（demo-substation）                    | 线路工程（demo-line / demo-line1）                       |
| ------------ | ---------------------------------------------- | -------------------------------------------------------- |
| 格式族数量   | 2 类（均为 XML）                               | 4 类（均为文本）                                          |
| 格式族构成   | XML_WITH_ENTITIES 4135 + EMPTY_DEVICE_XML 44   | TEXT_SECTION_KV_RECORD + TEXT_POINT_LINE + TEXT_KEY_VALUE + TEXT_HNUM_COMMA_RECORD |
| 是否含 XML   | 全部为 XML                                    | 全部为纯文本                                              |
| 是否含文本   | 无                                            | 全部为文本                                                |
| 主导格式     | XML_WITH_ENTITIES（99%）                       | TEXT_SECTION_KV_RECORD 与 TEXT_POINT_LINE（两个线路样本均占主导）|
| 样本规模差异 | 单样本 4179                                   | demo-line 1807、demo-line1 508（demo-line 约为 demo-line1 的 3.5 倍）|
| 格式族稳定性 | 单样本无法判断跨样本稳定性                     | 两个线路样本格式族集合完全一致，证实线路 MOD 格式族稳定    |

### 3.3 结论

```text
MOD 在变电与线路工程中表现出截然不同的表层格式：
- 变电：XML 格式族（Device/Entities/Entity/primitive）
- 线路：4 类文本格式族（section / point-line / key-value / HNum-comma）

两个线路样本（demo-line / demo-line1）的格式族集合完全一致，
说明线路 MOD 的文本格式族构成在跨工程样本中保持稳定。

后续 MOD parser 必须按工程类型分流，不能写成单一 schema。
```

---

## 4. 线路文本格式族详解

> 线路工程的 MOD 全部为文本格式族，无任何 XML。本节按 4 类文本格式族分别分析，并在每类末尾给出 demo-line 与 demo-line1 的对比。

### 4.1 TEXT_SECTION_KV_RECORD

#### 4.1.1 数量

| 样本        |    数量 |
| ----------- | ------: |
| demo-line   |    1300 |
| demo-line1  |     156 |

#### 4.1.2 Header 与 key family

| header |   demo-line |   demo-line1 |
| ------ | ----------: | -----------: |
| Bolt   |        1300 |          156 |

| key family |   demo-line |   demo-line1 |
| ---------- | ----------: | -----------: |
| Boltn      |        5616 |          624 |
| BoltNum    |        1300 |          156 |

> demo-line 的 `Boltn` 计数为所有 `Bolt1`~`BoltN` 字段累加；demo-line1 中每文件固定含 `Bolt1`~`Bolt4` 共 4 个键，所以 `Boltn` = 156 × 4 = 624。

#### 4.1.3 典型形态

```text
Bolt
BoltNum=4
Bolt1=...
Bolt2=...
Bolt3=...
Bolt4=...
```

#### 4.1.4 工程类型对比

```text
变电工程：无该格式族。
线路工程：两个样本的 header 全部为 Bolt，key family 全部为 Boltn + BoltNum。
         业务映射全部为 Tower_Device 的螺栓 / 杆塔附属部件参数记录。
```

### 4.2 TEXT_POINT_LINE

#### 4.2.1 数量

| 样本        |    数量 |
| ----------- | ------: |
| demo-line   |     315 |
| demo-line1  |     300 |

#### 4.2.2 稳定 key

```text
CODE
POINTNUM
LINENUM
POINTn
LINEn
```

#### 4.2.3 key 分布对比（仅列出与 demo-line 可对齐的索引）

| key      |   demo-line |   demo-line1 |
| -------- | ----------: | -----------: |
| CODE     |        315 |        300 |
| POINTNUM |        315 |        300 |
| LINENUM  |        315 |        300 |
| POINT1   |        315 |        300 |
| POINT2   |        315 |        300 |
| POINT3   |        315 |        298 |
| POINT4   |        315 |        298 |
| LINE1    |        315 |        300 |
| LINE2    |        315 |        298 |
| LINE3    |        315 |        298 |
| LINE4    |        171 |         94 |
| POINT5   |         51 |         42 |
| POINT6   |         51 |         42 |
| LINE5    |         51 |         42 |
| LINE6    |         12 |         12 |
| POINT7   |          9 |          8 |
| POINT8   |          9 |          8 |
| LINE7    |          9 |          8 |
| LINE8    |          6 |          4 |
| POINT9   |          5 |          2 |
| POINT10  |          5 |          2 |
| LINE9    |          5 |          2 |
| LINE10   |          5 |          2 |

> demo-line1 还存在 POINT11~POINT45、LINE11~LINE44 等高位索引（各出现 2 次），说明部分样本包含较长点线序列；此处仅列出与 demo-line 可对齐的索引。

#### 4.2.4 CODE 分布对比

| CODE |   demo-line |   demo-line1 |
| ---: | ----------: | -----------: |
|  201 |         128 |           58 |
|   31 |          74 |           94 |
|   32 |          63 |           56 |
|   34 |          19 |           26 |
|   35 |          13 |           40 |
|   33 |          10 |            2 |
|   30 |           8 |           20 |
|   81 |           - |            2 |
|   82 |           - |            2 |

> demo-line1 出现 demo-line 未观察到的 CODE=81 / CODE=82。

#### 4.2.5 工程类型对比

```text
变电工程：无该格式族。
线路工程：两个样本均全部映射到 CROSS entityName。
         稳定 key 集合一致，CODE 集合存在差异（demo-line1 多出 CODE=81/82）。
         具备明显的点线几何记录特征，但当前不能直接确认坐标系、单位、线段拓扑语义或渲染规则。
```

### 4.3 TEXT_KEY_VALUE

#### 4.3.1 数量

| 样本        |    数量 |
| ----------- | ------: |
| demo-line   |     161 |
| demo-line1  |      34 |

#### 4.3.2 主要 key

```text
type
d
e1
e2
H1
H2
H3
H4
```

少量导线参数 key：

```text
COEFFICIENTOFELASTICITY
EXPANSIONCOEFFICIENTOFWIRE
RATEDSTRENGTH
SECTIONALAREA
OUTSIDEDIAMETER
WIREWEIGHT
```

#### 4.3.3 key 分布对比

| key                        |   demo-line |   demo-line1 |
| -------------------------- | ----------: | -----------: |
| d                          |         304 |           56 |
| type                       |         161 |           34 |
| e2                         |         152 |           28 |
| e1                         |         152 |           28 |
| H1                         |         152 |           28 |
| H2                         |         152 |           28 |
| H3                         |         152 |           28 |
| H4                         |         152 |           28 |
| COEFFICIENTOFELASTICITY    |           9 |            6 |
| EXPANSIONCOEFFICIENTOFWIRE |           9 |            6 |
| RATEDSTRENGTH              |           9 |            6 |
| SECTIONALAREA              |           9 |            6 |
| OUTSIDEDIAMETER            |           9 |            6 |
| WIREWEIGHT                 |           9 |            6 |

#### 4.3.4 工程类型对比

```text
变电工程：无该格式族。
线路工程：两个样本均包含两类业务含义：
  - Tower_Device 参数型 MOD：type / d / e1 / e2 / H1-H4
  - WIRE 参数型 MOD：COEFFICIENTOFELASTICITY 等 6 个导线物理参数

两个样本的导线参数模板数与杆塔参数模板数均与各自工程规模成比例：
  demo-line   : WIRE 9 个、Tower_Device 152 个
  demo-line1  : WIRE 6 个、Tower_Device 28 个
说明导线参数 MOD 与杆塔参数 MOD 在两个样本中都存在高复用模板特征。
```

### 4.4 TEXT_HNUM_COMMA_RECORD

#### 4.4.1 数量

| 样本        |    数量 |
| ----------- | ------: |
| demo-line   |      31 |
| demo-line1  |      18 |

#### 4.4.2 文件首行

```text
HNum,n
```

#### 4.4.3 HNum 分布对比

| HNum    |   demo-line |   demo-line1 |
| ------- | ----------: | -----------: |
| HNum,1  |           1 |            3 |
| HNum,3  |           3 |           10 |
| HNum,4  |           2 |            - |
| HNum,5  |           4 |            2 |
| HNum,6  |           3 |            - |
| HNum,7  |           2 |            2 |
| HNum,8  |           8 |            1 |
| HNum,9  |           1 |            - |
| HNum,10 |           7 |            - |

#### 4.4.4 最大文件规模

| 样本        | 文件大小 | 行数   |
| ----------- | --------: | ------: |
| demo-line   | 2.6 MB   | 44876   |
| demo-line1  | 2.0 MB   | 35633   |

> demo-line 最大文件：`faad2496-75ae-4ad2-bdf1-1522ec5f3df2.mod`（length=2624664，firstLine=HNum,8）
> demo-line1 最大文件：`1a0757a7-ce0a-41ea-a6e1-3ef8623dc9aa.mod`（length=2077060）

#### 4.4.5 token 分布对比（节选）

| token          |     demo-line | demo-line1 |
| -------------- | ------------: | ---------: |
| P              |        597854 |     239202 |
| R              |        299399 |     120073 |
| SECTION_HEADER |          1813 |          - |
| G              |           646 |        649 |
| H              |           213 |         65 |
| HSubLeg3       |           212 |          - |
| HSubLeg1       |           212 |          - |
| HSubLeg4       |           212 |          - |
| HSubLeg2       |           212 |          - |
| HSubLeg5       |           152 |          - |
| HSubLeg6       |           138 |          - |
| HSubLeg7       |           133 |          - |
| HSubLeg8       |           81  |          - |
| HSubLeg9       |           60  |          - |
| HSubLeg10      |           51  |          - |
| HSubLeg11      |           32  |          - |
| HNum           |           31  |         18 |
| HBody1         |           31  |         18 |
| HLeg1          |           30  |         17 |
| HLeg2          |           30  |         15 |
| HLeg3          |           30  |         15 |
| HLeg4          |           27  |          5 |
| HLeg5          |           25  |          5 |
| HBody2         |           25  |          9 |
| HLeg6          |           21  |          3 |
| HLeg7          |           18  |          3 |
| HLeg8          |           16  |          1 |
| HSubLeg12      |           15  |          3 |
| HBody3         |           13  |          1 |
| HSubLeg13      |           13  |          3 |
| HLeg9          |           8   |          - |
| HLeg10         |           7   |          - |
| HBody4         |           6   |          1 |
| HBody5         |           2   |          - |
| HSubLeg14      |           1   |          1 |

> demo-line1 中 HSubLeg 类 token 的总和较小（与样本数 18 一致），且 HSubLeg 总计约 603 次（含 SubLeg1~SubLeg14），与 demo-line 同量级结构一致；上表对 demo-line1 仅列出与 demo-line 可对齐的关键 token。

#### 4.4.6 典型内容片段

```text
HNum,10
H,27000,Body1,Leg1
H,30000,Body1,Leg2
H,33000,Body1,Leg3
Body1
HBody1,26720.401
P,1,7519.597693,-953.003542,56293.389910
P,2,13970.086400,-649.820596,54093.616930
R,...
G,...
```

#### 4.4.7 工程类型对比

```text
变电工程：无该格式族。
线路工程：两个样本均完全映射到 Tower_Device。
         具备明显的杆塔主体 / 分段构件文本记录特征（HNum / H / Body / HBody / HLeg / HSubLeg / P / R / G）。
         最大样本都在 MB 级别、数万行规模。
         更稳妥的归类：杆塔主体 / 分段构件文本记录，不应与 TEXT_POINT_LINE 或 TEXT_KEY_VALUE 混用 parser。
```

### 4.5 线路文本格式族汇总

| MOD kind                 | demo-line | demo-line1 | 业务映射             | 说明                                         |
| ------------------------ | --------: | ---------: | -------------------- | -------------------------------------------- |
| TEXT_SECTION_KV_RECORD   |      1300 |        156 | Tower_Device         | Bolt / BoltNum / Boltn                       |
| TEXT_POINT_LINE          |       315 |        300 | CROSS                | CODE / POINTNUM / LINENUM / POINTn / LINEn   |
| TEXT_KEY_VALUE           |       161 |         34 | Tower_Device / WIRE  | 参数型 MOD；WIRE 参数高度复用                 |
| TEXT_HNUM_COMMA_RECORD   |        31 |         18 | Tower_Device         | HNum / H / Body / P / R / G 等文本记录        |

---

## 5. 变电 XML 格式族详解

> 变电工程的 MOD 全部为 XML 格式族，无任何文本格式。本节分析 XML 内部结构，并在末尾给出与线路工程的对比。

### 5.1 XML_WITH_ENTITIES

#### 5.1.1 数量

| 样本            |     数量 |
| --------------- | -------: |
| demo-substation |     4135 |

#### 5.1.2 XML 结构

```text
Device
  Entities
    Entity
      TransformMatrix
      Color
      primitive
```

#### 5.1.3 Entity 总数与基础属性

```text
Entity 总数                 : 46250
Entity.Type 全部为 simple
每个 Entity 恰好有 1 个 primitive 子节点
每个 Entity 都有 TransformMatrix.Value（16 个数）
每个 Entity 都有 Color（A/R/G/B）
```

#### 5.1.4 Entity.Type 与 primitive 的关键修正

```text
Entity.Type 不等于 primitive 名称。
Entity.Type 全部是 simple。
primitive 类型由 Entity 子节点名称决定，不由 Entity.Type 决定。
```

因此，XML MOD 的几何类型应读取：

```text
/Device/Entities/Entity/<primitiveName>
```

而不是读取：

```text
/Device/Entities/Entity[@Type]
```

### 5.2 primitive 分布与属性签名

#### 5.2.1 primitive 分布

| primitive              |    数量 |
| ---------------------- | ------: |
| Cylinder               |   20421 |
| Cuboid                 |   12401 |
| StretchedBody          |   10263 |
| PorcelainBushing       |    1506 |
| TruncatedCone          |     730 |
| Ring                   |     235 |
| TerminalBlock          |     201 |
| Sphere                 |     141 |
| ChannelSteel           |     129 |
| Table                  |     109 |
| CircularGasket         |      80 |
| RectangularFixedPlate  |      18 |
| OffsetRectangularTable |      15 |
| RectangularRing        |       1 |

合计 46250，等于 Entity 总数。

#### 5.2.2 primitive 属性签名

| primitive              | 属性签名                            |
| ---------------------- | ----------------------------------- |
| Cylinder               | R,H                                 |
| Cuboid                 | L,W,H                               |
| StretchedBody          | Array,Normal,L                      |
| PorcelainBushing       | R,R1,R2,N,H                         |
| TruncatedCone          | TR,BR,H                             |
| Ring                   | DR,R,Rad                            |
| TerminalBlock          | L,W,T,CL,CS,RS,R,CN,RN,BL,Phase     |
| Sphere                 | R                                   |
| ChannelSteel           | Model,L                             |
| ChannelSteel           | Model,L,B,H,D,T                     |
| Table                  | TL1,TL2,LL1,LL2,H                  |
| CircularGasket         | OR,IR,Rad,H                         |
| RectangularFixedPlate  | L,W,T,CS,RS,CN,RN,MH,D              |
| OffsetRectangularTable | TL,TW,LL,LW,XOFF,YOFF,H             |
| RectangularRing        | DR,R,W,L                            |

> ChannelSteel 存在两种属性签名：`Model,L`（72 个）与 `Model,L,B,H,D,T`（57 个）。XML primitive 的属性签名整体稳定，但个别 primitive 存在多签名情况。后续实现 parser 时不能只按 primitive 名称确定固定字段集合，还需要按属性存在性做兼容处理。

### 5.3 TransformMatrix 与 Visible

#### 5.3.1 TransformMatrix.Value 维度

| Value 元素数量 | Entity 数量 |
| -------------: | ----------: |
|             16 |       46250 |

所有 primitive 的 TransformMatrix.Value 均为 16 个数。

#### 5.3.2 Visible 分布

| Visible |    数量 |
| ------- | ------: |
| True    |   45558 |
| False   |     692 |

Visible=False 分布：

| primitive     | Visible=False 数量 |
| -------------- | ----------------: |
| StretchedBody  |              494 |
| Cylinder       |              144 |
| Cuboid         |               54 |
| 合计           |              692 |

Visible=True 分布摘要：

| primitive              | Visible=True 数量 |
| ---------------------- | ---------------: |
| Cylinder               |            20277 |
| Cuboid                 |            12347 |
| StretchedBody          |             9769 |
| PorcelainBushing       |             1506 |
| TruncatedCone          |              730 |
| Ring                   |              235 |
| TerminalBlock          |              201 |
| Sphere                 |              141 |
| ChannelSteel           |              129 |
| Table                  |              109 |
| CircularGasket         |               80 |
| RectangularFixedPlate  |               18 |
| OffsetRectangularTable |               15 |
| RectangularRing        |                1 |

#### 5.3.3 结论

```text
TransformMatrix.Value 全部是 16 个数。
Visible 是 Entity 级显示控制字段。
Visible=False 主要出现在 StretchedBody、Cylinder、Cuboid。
```

但当前不能直接决定：

```text
Visible=False 一定应该跳过渲染。
```

更稳妥的浏览器策略是：

```text
解析阶段保留 Visible。
渲染策略阶段再决定是否默认跳过 Visible=False。
诊断中记录 Visible=False 数量与 primitive 分布。
```

### 5.4 EMPTY_DEVICE_XML

#### 5.4.1 数量与形态

| 样本            |    数量 |
| --------------- | ------: |
| demo-substation |      44 |

```xml
<?xml version="1.0" encoding="utf-8"?>
<Device>
  <Entities />
</Device>
```

```text
全部 .mod
全部 78 bytes
SHA256 完全一致
内容均为 <Device><Entities /></Device>
全部未被 PHM 引用
全部未被 DEV-linked CBM 到达
```

#### 5.4.2 分类

更准确的分类是：

```text
UNREFERENCED_EMPTY_MOD
```

### 5.5 变电 XML 与线路文本格式对比

| 维度         | 变电 XML 格式族                                | 线路文本格式族                                          |
| ------------ | ---------------------------------------------- | ------------------------------------------------------- |
| 几何表达     | Entity + primitive（Cylinder/Cuboid/...）     | 点线记录 / 螺栓参数 / 杆塔分段 / 导线参数                |
| 几何字段     | `<TransformMatrix Value>` + `<Color>` + 图元  | `CODE`/`POINTn`/`LINEn`、`HNum`/`P`/`R`/`G` 等           |
| 结构稳定性   | XML 结构稳定，每个 Entity 恰好 1 个 primitive  | 4 类文本格式族结构各自独立                              |
| 字段歧义     | `Entity.Type` 不等于 primitive 名（关键陷阱） | 不同 kind 的 key 集合完全不同，分流后无歧义             |
| 渲染可直接性 | primitive 是结构化几何参数，最易解析           | 多为参数记录或点线拓扑，不能直接渲染                    |
| 是否含变换矩阵 | Entity 内 TransformMatrix.Value（16 元）     | 无 TransformMatrix 字段（变换矩阵在 PHM/DEV 层）         |
| 是否含颜色   | Entity 内 Color（A/R/G/B）                    | 无 Color 字段（颜色在 PHM 层）                           |

---

## 6. 上游 CBM → MOD 映射

### 6.1 线路工程映射

#### 6.1.1 demo-line

CBM resolved MOD references by entityName + modKind：

| 引用次数 | entityName + modKind                 |
| -------: | ------------------------------------ |
|     5460 | WIRE, TEXT_KEY_VALUE                 |
|     1300 | Tower_Device, TEXT_SECTION_KV_RECORD |
|     1300 | Tower_Device, TEXT_KEY_VALUE         |
|      327 | Tower_Device, TEXT_HNUM_COMMA_RECORD  |
|      315 | CROSS, TEXT_POINT_LINE               |

Unique MOD files reached by CBM entityName + modKind：

| 唯一 MOD 数 | entityName + modKind                 |
| ----------: | ------------------------------------ |
|       1300 | Tower_Device, TEXT_SECTION_KV_RECORD |
|        315 | CROSS, TEXT_POINT_LINE               |
|        152 | Tower_Device, TEXT_KEY_VALUE         |
|         31 | Tower_Device, TEXT_HNUM_COMMA_RECORD |
|          9 | WIRE, TEXT_KEY_VALUE                 |

demo-line 中没有未被 DEV-linked CBM 到达的 MOD kind。

#### 6.1.2 demo-line1

CBM 中所有 entityName 分布（含未到达几何的 entityName）：

| entityName   |   出现次数 |
| ------------ | ---------: |
| Wire_Device  |       1953 |
| WIRE         |       1013 |
| Tower_Device |        782 |
| CROSS        |        152 |

CBM resolved MOD references by entityName + modKind：

| 引用次数 | entityName + modKind                 |
| -------: | ------------------------------------ |
|     1013 | WIRE, TEXT_KEY_VALUE                 |
|      157 | Tower_Device, TEXT_KEY_VALUE         |
|      156 | Tower_Device, TEXT_SECTION_KV_RECORD |
|      152 | CROSS, TEXT_POINT_LINE               |
|       40 | Tower_Device, TEXT_HNUM_COMMA_RECORD |

Unique MOD files reached by CBM entityName + modKind：

| 唯一 MOD 数 | entityName + modKind                 |
| ----------: | ------------------------------------ |
|        156 | Tower_Device, TEXT_SECTION_KV_RECORD |
|        152 | CROSS, TEXT_POINT_LINE               |
|         28 | Tower_Device, TEXT_KEY_VALUE         |
|         18 | Tower_Device, TEXT_HNUM_COMMA_RECORD |
|          6 | WIRE, TEXT_KEY_VALUE                 |

未被 DEV-linked CBM 到达的 MOD：

| 数量 | kind + PHM referenced        |
| ---: | ---------------------------- |
|  148 | TEXT_POINT_LINE, True（孤儿） |

CBM 链可达性：

```text
CBM 可达 DEV : 1000 / 1148（148 个 orphan DEV）
CBM 可达 PHM :  415 /  563（148 个 orphan PHM）
CBM 可达 MOD :  360 /  508（148 个 orphan MOD）
```

#### 6.1.3 线路工程复用模式

两个线路样本均存在明显复用模式：

| 样本        | WIRE → TEXT_KEY_VALUE 复用            | Tower_Device → TEXT_HNUM_COMMA_RECORD 复用 |
| ----------- | ------------------------------------ | ----------------------------------------- |
| demo-line   | 9 个唯一 MOD × 5460 次引用           | 31 个唯一 MOD × 327 次引用                |
| demo-line1  | 6 个唯一 MOD × 1013 次引用           | 18 个唯一 MOD × 40 次引用                 |

### 6.2 变电工程映射

#### 6.2.1 demo-substation

MOD inventory by kind + PHM referenced：

|   数量 | kind + PHM referenced   |
| -----: | ----------------------- |
|   4135 | XML_WITH_ENTITIES, True |
|     44 | EMPTY_DEVICE_XML, False |

CBM resolved MOD references by entityName + modKind：

| 引用次数 | entityName + modKind         |
| -------: | ---------------------------- |
|     4135 | F4System, XML_WITH_ENTITIES  |
|     3894 | PARTINDEX, XML_WITH_ENTITIES |

Unique MOD files reached by CBM entityName + modKind：

| 唯一 MOD 数 | entityName + modKind         |
| ----------: | ---------------------------- |
|       4135 | F4System, XML_WITH_ENTITIES  |
|       3894 | PARTINDEX, XML_WITH_ENTITIES |

未被 DEV-linked CBM 到达的 MOD：

| 数量 | kind + PHM referenced   |
| ---: | ----------------------- |
|   44 | EMPTY_DEVICE_XML, False |

#### 6.2.2 F4System 与 PARTINDEX 的重叠

F4System 与 PARTINDEX 的可达 XML_WITH_ENTITIES 存在重叠：

```text
F4System 可到达 4135 个 XML_WITH_ENTITIES。
PARTINDEX 可到达 3894 个 XML_WITH_ENTITIES。
```

这不是重复文件错误。更合理的解释是：

```text
F4System 是设备级 / 装配级入口。
PARTINDEX 是部件级入口。
同一个下游 MOD 可以从设备级路径和部件级路径同时到达。
```

### 6.3 工程类型对比

| 维度         | 变电工程（demo-substation）                  | 线路工程（demo-line / demo-line1）                       |
| ------------ | -------------------------------------------- | -------------------------------------------------------- |
| entityName 集合 | F4System / PARTINDEX                       | Tower_Device / CROSS / WIRE（demo-line1 另含 Wire_Device） |
| entityName 与 kind 关系 | 1 个 kind（XML_WITH_ENTITIES）       | 多个 kind（4 类文本格式族）                                |
| 上游入口冗余 | F4System + PARTINDEX 双入口可达同一 MOD     | 单一 entityName 对应单一 kind                             |
| 高复用模板   | 不显著                                       | WIRE 对 TEXT_KEY_VALUE 存在高复用（5460 / 1013 次引用）   |
| 孤儿/未引用 MOD | 44 个 EMPTY_DEVICE_XML（未被 PHM 引用）   | demo-line 0；demo-line1 148 个 TEXT_POINT_LINE 孤儿       |

### 6.4 demo-line1 与 demo-line 的核心差异

```text
1. demo-line1 出现 Wire_Device entityName（demo-line 未观察到），但 Wire_Device 不参与几何链。
2. demo-line1 存在 148 个 CBM 链不可达的 TEXT_POINT_LINE 孤儿 MOD，全部为 PHM 引用、DEV 孤儿（详见第 7 节）。
3. demo-line1 中 Wire_Device 与 WIRE 是两个独立的 entityName，前者无几何，后者承载导线参数模板。
```

---

## 7. 孤儿 / 未引用 MOD 分析

### 7.1 demo-substation：EMPTY_DEVICE_XML

#### 7.1.1 形态

```text
44 个 EMPTY_DEVICE_XML
全部 .mod
全部 78 bytes
SHA256 完全一致
内容均为 <Device><Entities /></Device>
全部未被 PHM 引用
全部未被 DEV-linked CBM 到达
```

#### 7.1.2 分类

更准确的分类是：

```text
UNREFERENCED_EMPTY_MOD
```

#### 7.1.3 处理策略

```text
不参与主链解析
不参与渲染
不作为 missing reference
仅进入诊断报告
```

### 7.2 demo-line1：TEXT_POINT_LINE 孤儿

#### 7.2.1 形态

```text
148 个 CBM 链不可达的 TEXT_POINT_LINE MOD
全部为 TEXT_POINT_LINE
全部被 PHM 引用
全部由 PHM → DEV 链路引用，但引用它们的 DEV 不被任何 CBM 引用，也不被任何其他 DEV 引用（orphan DEV）
```

#### 7.2.2 孤儿链规模

```text
orphan DEV   : 148（1000 / 1148 DEV 可达）
orphan PHM   : 148（415 / 563 PHM 可达）
orphan MOD   : 148（360 / 508 MOD 可达）
```

每个孤儿 DEV 恰好引用 1 个孤儿 PHM，每个孤儿 PHM 恰好引用 1 个孤儿 MOD，形成 1:1:1 的孤立链。

#### 7.2.3 处理策略

```text
不参与主链解析
不参与渲染
不作为 missing reference
进入诊断报告
```

> demo-line 中未观察到同类孤儿，说明这不是线路 GIM 的必备特征，可能是 demo-line1 工程的额外资源或导出残留。

### 7.3 工程类型对比

| 维度         | 变电工程（demo-substation）                  | 线路工程（demo-line / demo-line1）                       |
| ------------ | -------------------------------------------- | -------------------------------------------------------- |
| 孤儿类型     | EMPTY_DEVICE_XML（空 XML）                   | TEXT_POINT_LINE（PHM 引用但 CBM 不可达）                  |
| 孤儿数量     | 44                                           | demo-line 0；demo-line1 148                              |
| PHM 引用状态 | 未被 PHM 引用                                | 全部被 PHM 引用                                          |
| DEV 引用状态 | 未被 DEV 引用                                | 被 PHM 引用，但引用它们的 DEV 是 orphan DEV              |
| CBM 可达性   | 不可达                                       | 不可达                                                   |
| 孤儿链形态   | 单点孤儿（孤立空文件）                       | DEV→PHM→MOD 1:1:1 孤立链                                 |
| 是否可推广   | 单样本，不能推广为所有变电 GIM 规则          | demo-line 未观察到，不能推广为所有线路 GIM 规则          |

---

## 8. 当前结论

```text
1. MOD 不是单一格式。
2. 两个线路样本（demo-line / demo-line1）MOD 是相同的 4 种文本格式族。
3. 变电样本（demo-substation）MOD 是 XML Device / Entities / Entity / primitive 格式族。
4. demo-line 没有 orphan MOD（CBM 链全部可达）。
5. demo-line1 存在 148 个 CBM 链不可达的 TEXT_POINT_LINE 孤儿 MOD（PHM 引用、DEV 孤儿）。
6. demo-substation 有 44 个 UNREFERENCED_EMPTY_MOD（未被 PHM 引用，未被 CBM 到达）。
7. demo-substation 的 EMPTY_DEVICE_XML 未被 PHM 引用，也未被 DEV-linked CBM 到达。
8. XML MOD 中 Entity.Type 全部为 simple。
9. XML MOD 的 primitive 类型由 Entity 子节点名称决定，不由 Entity.Type 决定。
10. XML MOD 每个 Entity 恰好有 1 个 primitive 子节点。
11. XML MOD 每个 Entity 都有 TransformMatrix.Value。
12. TransformMatrix.Value 全部是 16 个数。
13. XML MOD 每个 Entity 都有 Color A/R/G/B。
14. XML MOD 中 Visible 是 Entity 级字段。
15. 线路 MOD 需要按文本格式族分支解析（两个样本格式族集合一致）。
16. 变电 XML MOD 可以优先按 Device / Entities / Entity / primitive 结构解析。
17. demo-line1 出现 Wire_Device entityName，但 Wire_Device 不参与几何链；demo-line 未观察到 Wire_Device。
18. 两个线路样本的 WIRE entityName 都承载导线参数模板（TEXT_KEY_VALUE），存在高复用模式。
```

---

## 9. 浏览器实现影响

### 9.1 MOD parser 不能按单一格式实现

当前三个样本已经证明：

```text
demo-line   MOD：文本格式族（4 类）
demo-line1  MOD：文本格式族（4 类，与 demo-line 一致）
demo-substation MOD：XML 格式族
```

因此后续实现不应写成单一路径：

```text
parseMod(file) -> one schema
```

而应先做格式分流：

```text
classifyMod(file)
  -> XML_WITH_ENTITIES
  -> EMPTY_DEVICE_XML
  -> TEXT_SECTION_KV_RECORD
  -> TEXT_POINT_LINE
  -> TEXT_KEY_VALUE
  -> TEXT_HNUM_COMMA_RECORD
```

### 9.2 线路 MOD 需要文本多分支解析

demo-line 与 demo-line1 至少需要以下分支：

```text
TEXT_SECTION_KV_RECORD
TEXT_POINT_LINE
TEXT_KEY_VALUE
TEXT_HNUM_COMMA_RECORD
```

不同分支的字段结构完全不同，不能强行映射为统一 DTO。两个线路样本的格式族集合一致，可以共享同一套 parser 分支。

### 9.3 变电 MOD 可优先解析 XML 结构

demo-substation 的 XML MOD 结构稳定：

```text
Device
  Entities
    Entity
      TransformMatrix
      Color
      primitive
```

可以优先作为结构化解析候选。但解析时需要注意：

```text
Entity.Type 不是 primitive 类型。
primitive 类型要从 Entity 子节点名读取。
```

### 9.4 EMPTY_DEVICE_XML 与孤儿 MOD 不进入主链渲染

demo-substation 的 44 个 EMPTY_DEVICE_XML：

```text
未被 PHM 引用
未被 DEV-linked CBM 到达
```

demo-line1 的 148 个孤儿 TEXT_POINT_LINE MOD：

```text
被 PHM 引用
引用它们的 DEV 不被任何 CBM 引用（orphan DEV）
属于 CBM 树外的孤立几何资源
```

因此浏览器策略应为：

```text
不参与主链解析
不参与渲染
不作为 missing reference
进入诊断报告
```

### 9.5 Visible 应作为实体级字段保留

当前观察到：

```text
Visible=True 45558
Visible=False 692
```

后续解析模型中应保留 Visible 字段。但当前还不能直接确定：

```text
Visible=False 一定应跳过渲染。
```

更稳妥的策略是解析保留、渲染层再决策。

### 9.6 TransformMatrix.Value 可作为 16 元矩阵字段进入后续设计

当前所有 XML Entity 的 TransformMatrix.Value 都是 16 个数。但当前不能确认：

```text
矩阵行主序 / 列主序
坐标系方向
单位
与 PHM TRANSFORMMATRIX 的组合顺序
```

这些需要后续专门分析。

---

## 10. 当前不能得出的结论

当前不能得出：

```text
所有 GIM 的 MOD 都只有这些格式。
TEXT_HNUM_COMMA_RECORD 已经完成杆塔模型解析。
TEXT_POINT_LINE 已经可以直接渲染。
XML primitive 已经可以直接渲染。
TransformMatrix 的行列主序已经确认。
坐标系方向已经确认。
单位已经确认。
Visible=False 一定应该跳过渲染。
EMPTY_DEVICE_XML 在所有样本中都必然未引用。
F4System / PARTINDEX 的关系可以推广为所有变电 GIM 规则。
demo-line1 的孤儿 MOD 模式可以推广为所有线路 GIM 规则。
Wire_Device entityName 在所有线路 GIM 中都不参与几何链。
```

当前只能确认：

```text
在当前三个样本中，MOD 存在显著格式分型。
两个线路样本（demo-line / demo-line1）MOD 是相同的 4 种文本格式族。
变电样本（demo-substation）MOD 是 XML primitive 格式族。
DEV-linked CBM 能到达的 MOD 均属于可静态识别格式。
demo-line1 的孤儿 MOD 与 demo-substation 的 EMPTY_DEVICE_XML 都不应进入主链渲染。
```

---

## 11. 后续建议

后续可以继续做：

```text
1. PHM TRANSFORMMATRIX 与 XML Entity TransformMatrix 的关系分析。
2. XML primitive 参数值范围分析。
3. TEXT_POINT_LINE 坐标字段形态分析。
4. TEXT_HNUM_COMMA_RECORD P/R/G 记录结构分析。
5. STL 文件大小、引用对象和用途分析。
6. MOD parser 草案设计，但仍不进入渲染实现。
```

建议下一轮优先分析：

```text
PHM TRANSFORMMATRIX 与 MOD 内部 TransformMatrix 的层级关系
```

原因：

```text
DEV -> PHM -> MOD/STL 可达 已确认
MOD 内部存在几何 primitive 和 TransformMatrix 已确认
下一步应确认 PHM.TRANSFORMMATRIX 与 MOD.Entity.TransformMatrix 如何共同构成最终局部 / 全局变换链。
```

---

## 附录 A：分析脚本

> 所有分析脚本集中在本附录。脚本均位于 `docs/schema/_generated/` 目录下，使用只读 PowerShell 实现，不修改 src、不修改 SQLite schema、不新增 UI。

### A.1 MOD 静态分型（kind / key / CODE / primitive）

**脚本路径**：`_generated/mod-static-profile-v2.ps1`

**入口命令**：

```powershell
powershell -ExecutionPolicy Bypass -File `
  "docs\schema\_generated\mod-static-profile-v2.ps1" -SampleId "demo-line1"

powershell -ExecutionPolicy Bypass -File `
  "docs\schema\_generated\mod-static-profile-v2.ps1" -SampleId "demo-line"

powershell -ExecutionPolicy Bypass -File `
  "docs\schema\_generated\mod-static-profile-v2.ps1" -SampleId "demo-substation"
```

**用途**：对单个样本的所有 `.mod` 文件做静态分类，输出 kind 分布、key Top、CODE 分布、header 分布、XML Entity 总数、Visible 分布、primitive 分布。

**核心分类函数**：

```powershell
function Classify-ModText($text) {
  if ($null -eq $text -or $text.Trim().Length -eq 0) { return "EMPTY" }
  $trimmed = $text.TrimStart()
  if ($trimmed -match "^<\?xml" -or $trimmed -match "^<Device") {
    if ($trimmed -match "<Entities\s*/>") { return "XML_EMPTY_DEVICE" }
    if ($trimmed -match "<Entity") { return "XML_WITH_ENTITIES" }
    return "XML_OTHER"
  }
  if ($text -match "(?m)^CODE\s*=" -and $text -match "(?m)^POINTNUM\s*=" -and $text -match "(?m)^LINENUM\s*=") {
    return "TEXT_POINT_LINE"
  }
  if ($text -match "(?m)^HNum\s*,") { return "TEXT_HNUM_COMMA_RECORD" }
  $lines = $text -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
  if ($lines.Count -eq 0) { return "EMPTY" }
  $firstLine = $lines[0]
  $kvLineCount = ($lines | Where-Object { $_ -match "^[A-Za-z0-9_.-]+\s*=" }).Count
  if ($firstLine -notmatch "=" -and $kvLineCount -gt 0) { return "TEXT_SECTION_KV_RECORD" }
  if ($kvLineCount -gt 0) { return "TEXT_KEY_VALUE" }
  if ($text -match "," -and $text -match "[0-9]") { return "TEXT_COMMA_NUMERIC" }
  return "TEXT_UNKNOWN"
}
```

### A.2 MOD 各 kind 详细字段统计

**脚本路径**：`_generated/mod-per-kind-stats.ps1`

**入口命令**：

```powershell
powershell -ExecutionPolicy Bypass -File `
  "docs\schema\_generated\mod-per-kind-stats.ps1" -SampleId "demo-line1"
```

**用途**：对单个样本的每个 kind 输出详细字段统计，包括文件数、key 分布、CODE 分布、HNum 分布、token 分布、最大文件 / 行数。

### A.3 上游 CBM → DEV → PHM → MOD 映射

**脚本路径**：`_generated/mod-upstream-mapping-v2.ps1`

**入口命令**：

```powershell
powershell -ExecutionPolicy Bypass -File `
  "docs\schema\_generated\mod-upstream-mapping-v2.ps1" -SampleId "demo-line1"
```

**用途**：构造 CBM→DEV→PHM→MOD 完整可达链，输出每个 `entityName + modKind` 组合的引用次数与唯一 MOD 数，以及 MOD 是否被 PHM 引用、是否被 CBM 链到达。

**核心逻辑**：直接遍历所有 CBM 文件，提取 `ENTITYNAME` + `OBJECTMODELPOINTER` 字段，构造 `cbmDevEntries`（devName → entityName 列表），再通过 DEV → DEV → PHM → MOD 的递归链路解析可达 MOD 集合。

**关键修正点**：

```text
1. CBM 字段顺序不固定：部分 CBM 中 OBJECTMODELPOINTER 出现在 ENTITYNAME 之前。
   原脚本顺序处理后 entityName 为空，已改为两阶段收集（先扫描全部字段，再使用 collected 值）。
2. 不依赖 project.cbm 树遍历：树遍历会漏掉通过 BACKSTRING/FRONTSTRING 到达的叶子 CBM。
   v2 改为直接扫描所有 CBM 文件，覆盖全部 OBJECTMODELPOINTER 指向的 DEV。
```

### A.4 孤儿 MOD 诊断（CBM 链可达性）

**脚本路径**：`_generated/mod-upstream-diagnostic.ps1`

**入口命令**：

```powershell
powershell -ExecutionPolicy Bypass -File `
  "docs\schema\_generated\mod-upstream-diagnostic.ps1" -SampleId "demo-line1"
```

**用途**：定位 CBM 链不可达的孤儿 MOD。输出：

```text
- 所有 entityName 在 CBM 中的出现次数（含未到达几何的 entityName）
- CBM 可达 DEV / PHM / MOD 数量 vs 总数
- 未到达 MOD 按 kind 分组的数量
- 未到达 MOD 的样本（含 PHM、parent DEV、是否被 CBM 直接引用、是否有 parent DEV）
```

该脚本用于定位 demo-line1 中 148 个 CBM 链不可达的 TEXT_POINT_LINE 孤儿 MOD。

### A.5 脚本一览

| 脚本                                       | 用途                                          | 输出                                |
| ------------------------------------------ | --------------------------------------------- | ----------------------------------- |
| `_generated/mod-static-profile-v2.ps1`     | MOD 静态分型（kind / key / CODE / primitive） | kind 分布、key Top、CODE/header 分布 |
| `_generated/mod-per-kind-stats.ps1`        | 各 kind 详细字段统计                          | key/CODE/HNum/token 分布、最大文件    |
| `_generated/mod-upstream-mapping-v2.ps1`   | 上游 CBM → DEV → PHM → MOD 映射               | entityName+modKind 引用矩阵、孤儿统计 |
| `_generated/mod-upstream-diagnostic.ps1`   | 孤儿 MOD 诊断（CBM 链可达性）                  | 可达性统计、孤儿样本详细信息          |
