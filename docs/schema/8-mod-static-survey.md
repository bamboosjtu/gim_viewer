# MOD 静态分型与可解析性边界分析

目标：确认 MOD 文件具体属于哪些文本格式族。

## 1. Round 4 定位

Round 4 的目标是对当前两个 demo 中的 `.mod` 文件做静态分型，确认 MOD 的表层格式、结构特征、上游引用关系和浏览器侧解析边界。

Round 4 不进入几何渲染实现，也不解释坐标系、矩阵行列主序或具体三维构件语义。

当前分析对象：

```text
demo-line
demo-substation
```

当前分析范围：

```text
MOD 文件静态分类
线路 MOD 文本格式族分析
变电 MOD XML 结构分析
MOD 与 PHM 引用关系
MOD 与 CBM entityName 的上游映射
EMPTY_DEVICE_XML / orphan MOD 分析
XML Entity / primitive / TransformMatrix / Color / Visible 字段形态分析
```

当前不做：

```text
不改 src
不改 SQLite schema
不新增 UI
不实现 MOD 解析
不实现 STL 解析
不做 3D 渲染
不做悬链线
不应用 TRANSFORMMATRIX
不确认 TransformMatrix 行列主序
不确认坐标系方向
不改变当前 MVP 行为
```

Round 4 的核心判断是：

```text
MOD 不是单一格式。
当前 demo-line MOD 是多种文本格式族。
当前 demo-substation MOD 是 XML Device / Entities / Entity / primitive 格式族，另有 44 个未引用的 EMPTY_DEVICE_XML。
```

---

## 2. Round 4 总体计划

| 阶段        | 目标               | 产出                                              |
| --------- | ---------------- | ----------------------------------------------- |
| Round 4.1 | MOD 文件静态画像       | MOD 初步分类                                        |
| Round 4.2 | 线路 MOD 文本格式细分    | line MOD 格式族                                    |
| Round 4.3 | 线路 MOD 词汇表分析     | key / token / code 分布                           |
| Round 4.4 | 变电 MOD XML 结构分析  | XML root / Entity / primitive 结构                |
| Round 4.5 | XML Entity 一致性检查 | Entity / primitive / TransformMatrix / Color 规则 |
| Round 4.6 | Visible 与矩阵字段分析  | Visible 分布与矩阵维度                                 |
| Round 4.7 | MOD 与上游 CBM 映射   | MOD kind 与 entityName 对应关系                      |
| Round 4.8 | 浏览器实现边界总结        | 解析策略与不能得出的结论                                    |

---

## 3. MOD 静态分类方法

Round 4 使用只读 PowerShell 脚本扫描 `.mod` 文件，按文件内容做静态分类。

分类规则如下：

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
  当前 demo-line 中该类 header 全部为 Bolt。

TEXT_KEY_VALUE
  主要由 key=value 行构成，没有独立 section header。

TEXT_HNUM_COMMA_RECORD
  第一行为 HNum,n，后续为逗号分隔记录。
  当前样本中包含 H / Body / HBody / HLeg / HSubLeg / P / R / G 等 token。
```

入口命令：

```powershell
Show-ModStaticProfileV2 ".\demo\demo-line\Mod"
Show-ModStaticProfileV2 ".\demo\demo-substation\MOD"
```

---

## 4. demo-line MOD 静态分型

### 4.1 目的

确认线路样本中的 MOD 是否为单一格式，以及各类文本 MOD 的数量和基本形态。

### 4.2 当前结果

demo-line MOD 总数：

```text
1807
```

分类结果：

| MOD kind               |   数量 |
| ---------------------- | ---: |
| TEXT_SECTION_KV_RECORD | 1300 |
| TEXT_POINT_LINE        |  315 |
| TEXT_KEY_VALUE         |  161 |
| TEXT_HNUM_COMMA_RECORD |   31 |

### 4.3 分析结论

demo-line MOD 不是 XML 格式，而是多种文本格式族：

```text
TEXT_SECTION_KV_RECORD
TEXT_POINT_LINE
TEXT_KEY_VALUE
TEXT_HNUM_COMMA_RECORD
```

这些文本格式不能用同一个 parser 直接处理。后续如果实现 MOD 解析，线路侧需要先做文本格式分流。

---

## 5. demo-line：TEXT_SECTION_KV_RECORD

### 5.1 目的

确认 section + key-value 型 MOD 的字段形态和业务映射。

### 5.2 当前结果

TEXT_SECTION_KV_RECORD 数量：

```text
1300
```

header 分布：

|   数量 | header |
| ---: | ------ |
| 1300 | Bolt   |

key family 分布：

|   数量 | key family |
| ---: | ---------- |
| 5616 | Boltn      |
| 1300 | BoltNum    |

该类 MOD 的典型形态：

```text
Bolt
BoltNum=4
Bolt1=...
Bolt2=...
Bolt3=...
Bolt4=...
```

### 5.3 上游映射

| entityName   | MOD kind               | 引用次数 | 唯一 MOD 数 |
| ------------ | ---------------------- | ---: | -------: |
| Tower_Device | TEXT_SECTION_KV_RECORD | 1300 |     1300 |

### 5.4 分析结论

TEXT_SECTION_KV_RECORD 在当前 demo-line 中全部是 Bolt 结构，全部映射到 Tower_Device。

该类文件更适合暂时归类为：

```text
螺栓类参数记录 / 杆塔附属部件参数记录
```

后续不能直接按几何网格解析，应先作为结构化文本参数处理。

---

## 6. demo-line：TEXT_POINT_LINE

### 6.1 目的

确认点线型 MOD 的 key 分布、CODE 分布和上游对象类型。

### 6.2 当前结果

TEXT_POINT_LINE 数量：

```text
315
```

稳定 key：

```text
CODE
POINTNUM
LINENUM
POINTn
LINEn
```

key 分布摘要：

| key      |  数量 |
| -------- | --: |
| CODE     | 315 |
| POINTNUM | 315 |
| LINENUM  | 315 |
| POINT1   | 315 |
| POINT2   | 315 |
| POINT3   | 315 |
| POINT4   | 315 |
| LINE1    | 315 |
| LINE2    | 315 |
| LINE3    | 315 |
| LINE4    | 171 |
| POINT5   |  51 |
| POINT6   |  51 |
| LINE5    |  51 |
| LINE6    |  12 |
| POINT7   |   9 |
| POINT8   |   9 |
| LINE7    |   9 |
| LINE8    |   6 |
| POINT9   |   5 |
| POINT10  |   5 |
| LINE9    |   5 |
| LINE10   |   5 |

CODE 分布：

| CODE |  数量 |
| ---: | --: |
|  201 | 128 |
|   31 |  74 |
|   32 |  63 |
|   34 |  19 |
|   35 |  13 |
|   33 |  10 |
|   30 |   8 |

### 6.3 上游映射

| entityName | MOD kind        | 引用次数 | 唯一 MOD 数 |
| ---------- | --------------- | ---: | -------: |
| CROSS      | TEXT_POINT_LINE |  315 |      315 |

### 6.4 分析结论

TEXT_POINT_LINE 在当前 demo-line 中全部映射到 CROSS。

该类文件具备明显的点线几何记录特征：

```text
CODE
POINTNUM
LINENUM
POINTn
LINEn
```

但当前只能确认其为文件级点线记录，不能直接确认其坐标系、单位、线段拓扑语义或渲染规则。

---

## 7. demo-line：TEXT_KEY_VALUE

### 7.1 目的

确认纯 key-value 型 MOD 的字段集合和复用关系。

### 7.2 当前结果

TEXT_KEY_VALUE 数量：

```text
161
```

主要 key：

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

key 分布：

| key                        |  数量 |
| -------------------------- | --: |
| d                          | 304 |
| type                       | 161 |
| e2                         | 152 |
| e1                         | 152 |
| H1                         | 152 |
| H2                         | 152 |
| H3                         | 152 |
| H4                         | 152 |
| COEFFICIENTOFELASTICITY    |   9 |
| EXPANSIONCOEFFICIENTOFWIRE |   9 |
| RATEDSTRENGTH              |   9 |
| SECTIONALAREA              |   9 |
| OUTSIDEDIAMETER            |   9 |
| WIREWEIGHT                 |   9 |

### 7.3 上游映射

| entityName   | MOD kind       | 引用次数 | 唯一 MOD 数 |
| ------------ | -------------- | ---: | -------: |
| Tower_Device | TEXT_KEY_VALUE | 1300 |      152 |
| WIRE         | TEXT_KEY_VALUE | 5460 |        9 |

### 7.4 分析结论

TEXT_KEY_VALUE 不是单一业务含义。

当前至少包含两类：

```text
Tower_Device 参数型 MOD：
- type
- d
- e1 / e2
- H1-H4

WIRE 参数型 MOD：
- COEFFICIENTOFELASTICITY
- EXPANSIONCOEFFICIENTOFWIRE
- RATEDSTRENGTH
- SECTIONALAREA
- OUTSIDEDIAMETER
- WIREWEIGHT
```

其中 WIRE 对 9 个 TEXT_KEY_VALUE MOD 形成 5460 次引用，说明线路导线参数 MOD 存在高复用模板特征。

---

## 8. demo-line：TEXT_HNUM_COMMA_RECORD

### 8.1 目的

确认原先 TEXT_OR_UNKNOWN 类型是否可以进一步归类。

### 8.2 当前结果

TEXT_HNUM_COMMA_RECORD 数量：

```text
31
```

这些文件第一行均为：

```text
HNum,n
```

HNum 分布：

| HNum    | 文件数 |
| ------- | --: |
| HNum,8  |   8 |
| HNum,10 |   7 |
| HNum,5  |   4 |
| HNum,3  |   3 |
| HNum,6  |   3 |
| HNum,4  |   2 |
| HNum,7  |   2 |
| HNum,1  |   1 |
| HNum,9  |   1 |

最大文件约：

```text
2.6 MB
```

最大样本：

```text
faad2496-75ae-4ad2-bdf1-1522ec5f3df2.mod
length = 2624664
lineCount = 44876
firstLine = HNum,8
```

token 分布摘要：

| token          |     数量 |
| -------------- | -----: |
| P              | 597854 |
| R              | 299399 |
| SECTION_HEADER |   1813 |
| G              |    646 |
| H              |    213 |
| HSubLeg3       |    212 |
| HSubLeg1       |    212 |
| HSubLeg4       |    212 |
| HSubLeg2       |    212 |
| HSubLeg5       |    152 |
| HSubLeg6       |    138 |
| HSubLeg7       |    133 |
| HSubLeg8       |     81 |
| HSubLeg9       |     60 |
| HSubLeg10      |     51 |
| HSubLeg11      |     32 |
| HNum           |     31 |
| HBody1         |     31 |
| HLeg1          |     30 |
| HLeg2          |     30 |
| HLeg3          |     30 |
| HLeg4          |     27 |
| HLeg5          |     25 |
| HBody2         |     25 |
| HLeg6          |     21 |
| HLeg7          |     18 |
| HLeg8          |     16 |
| HSubLeg12      |     15 |
| HBody3         |     13 |
| HSubLeg13      |     13 |
| HLeg9          |      8 |
| HLeg10         |      7 |
| HBody4         |      6 |
| HBody5         |      2 |
| HSubLeg14      |      1 |

典型内容片段：

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

### 8.3 上游映射

| entityName   | MOD kind               | 引用次数 | 唯一 MOD 数 |
| ------------ | ---------------------- | ---: | -------: |
| Tower_Device | TEXT_HNUM_COMMA_RECORD |  327 |       31 |

### 8.4 分析结论

TEXT_HNUM_COMMA_RECORD 可以从 TEXT_OR_UNKNOWN 中独立出来。

它具备明显的杆塔主体 / 分段构件文本记录特征：

```text
HNum
H
Body
HBody
HLeg
HSubLeg
P
R
G
```

但当前不能写成“已经解析塔模型”。更稳妥的结论是：

```text
TEXT_HNUM_COMMA_RECORD 暂归类为杆塔主体 / 分段构件文本记录。
```

后续如果进入解析实现，应单独设计 parser，不应与 TEXT_POINT_LINE 或 TEXT_KEY_VALUE 混用。

---

## 9. demo-line MOD 总结

demo-line MOD 静态分型结果：

| MOD kind               |   数量 | 上游对象                | 说明                                         |
| ---------------------- | ---: | ------------------- | ------------------------------------------ |
| TEXT_SECTION_KV_RECORD | 1300 | Tower_Device        | Bolt / BoltNum / Boltn                     |
| TEXT_POINT_LINE        |  315 | CROSS               | CODE / POINTNUM / LINENUM / POINTn / LINEn |
| TEXT_KEY_VALUE         |  161 | Tower_Device / WIRE | 参数型 MOD；WIRE 参数高度复用                        |
| TEXT_HNUM_COMMA_RECORD |   31 | Tower_Device        | HNum / H / Body / P / R / G 等文本记录          |

demo-line 中：

```text
所有 MOD 均被 PHM 引用。
没有 orphan MOD。
没有 EMPTY_DEVICE_XML。
```

---

## 10. demo-substation MOD 静态分型

### 10.1 目的

确认变电样本中的 MOD 是否为 XML，以及 XML 内部结构是否稳定。

### 10.2 当前结果

demo-substation MOD 总数：

```text
4179
```

分类结果：

| MOD kind          |   数量 |
| ----------------- | ---: |
| XML_WITH_ENTITIES | 4135 |
| EMPTY_DEVICE_XML  |   44 |

root 分布：

| root   |   数量 |
| ------ | ---: |
| Device | 4179 |

### 10.3 分析结论

demo-substation MOD 与 demo-line 完全不同。

当前 demo-substation 的 MOD 是 XML 格式族：

```text
Device
  Entities
    Entity
      TransformMatrix
      Color
      primitive
```

其中 44 个 EMPTY_DEVICE_XML 是空 XML 文件：

```xml
<?xml version="1.0" encoding="utf-8"?>
<Device>
  <Entities />
</Device>
```

---

## 11. demo-substation XML Entity 结构

### 11.1 目的

确认 XML MOD 中 Entity 的结构是否稳定。

### 11.2 当前结果

Entity 总数：

```text
46250
```

整体一致性结果：

```text
totalEntities               : 46250
missingTransformMatrix      : 0
missingTransformMatrixValue : 0
missingColor                : 0
missingColorArgb            : 0
primitiveCountNotOne        : 0
typeNotMatchPrimitive       : 46250
```

Entity 基础属性：

```text
ID
Type
Visible
```

Entity.Type 分布：

| Entity.Type |    数量 |
| ----------- | ----: |
| simple      | 46250 |

Visible 分布：

| Visible |    数量 |
| ------- | ----: |
| True    | 45558 |
| False   |   692 |

每个 Entity 都有：

```text
TransformMatrix
TransformMatrix.Value
Color
Color.A
Color.R
Color.G
Color.B
```

每个 Entity 恰好有 1 个 primitive 子节点。

### 11.3 关键修正

`Entity.Type` 不等于 primitive 名称。

当前结果中：

```text
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

### 11.4 分析结论

demo-substation XML MOD 的结构可以描述为：

```text
Device
  Entities
    Entity(ID, Type=simple, Visible)
      TransformMatrix(Value)
      Color(A, R, G, B)
      Primitive(...)
```

其中 Primitive 是 Entity 的唯一几何子节点。

---

## 12. demo-substation XML primitive 分布

### 12.1 当前结果

| primitive              |    数量 |
| ---------------------- | ----: |
| Cylinder               | 20421 |
| Cuboid                 | 12401 |
| StretchedBody          | 10263 |
| PorcelainBushing       |  1506 |
| TruncatedCone          |   730 |
| Ring                   |   235 |
| TerminalBlock          |   201 |
| Sphere                 |   141 |
| ChannelSteel           |   129 |
| Table                  |   109 |
| CircularGasket         |    80 |
| RectangularFixedPlate  |    18 |
| OffsetRectangularTable |    15 |
| RectangularRing        |     1 |

这些 primitive 数量合计：

```text
46250
```

等于 Entity 总数。

### 12.2 分析结论

当前 demo-substation 中：

```text
一个 Entity 恰好对应一个 primitive。
primitive 子节点名就是具体几何原语类型。
```

XML MOD 是后续最适合优先结构化解析的 MOD 类型。

---

## 13. demo-substation XML primitive 属性签名

### 13.1 当前结果

| primitive              | 属性签名                            |
| ---------------------- | ------------------------------- |
| Cylinder               | R,H                             |
| Cuboid                 | L,W,H                           |
| StretchedBody          | Array,Normal,L                  |
| PorcelainBushing       | R,R1,R2,N,H                     |
| TruncatedCone          | TR,BR,H                         |
| Ring                   | DR,R,Rad                        |
| TerminalBlock          | L,W,T,CL,CS,RS,R,CN,RN,BL,Phase |
| Sphere                 | R                               |
| ChannelSteel           | Model,L                         |
| ChannelSteel           | Model,L,B,H,D,T                 |
| Table                  | TL1,TL2,LL1,LL2,H               |
| CircularGasket         | OR,IR,Rad,H                     |
| RectangularFixedPlate  | L,W,T,CS,RS,CN,RN,MH,D          |
| OffsetRectangularTable | TL,TW,LL,LW,XOFF,YOFF,H         |
| RectangularRing        | DR,R,W,L                        |

ChannelSteel 存在两种属性签名：

| 属性签名            | 数量 |
| --------------- | -: |
| Model,L         | 72 |
| Model,L,B,H,D,T | 57 |

### 13.2 分析结论

XML primitive 的属性签名整体稳定，但个别 primitive 存在多签名情况。

后续实现 parser 时不能只按 primitive 名称确定固定字段集合，还需要按属性存在性做兼容处理。

---

## 14. demo-substation TransformMatrix 与 Visible

### 14.1 目的

确认 TransformMatrix.Value 的维度是否稳定，以及 Visible=False 的实体分布。

### 14.2 当前结果

TransformMatrix.Value 数量分布：

| Value 元素数量 | Entity 数量 |
| ---------: | --------: |
|         16 |     46250 |

按 primitive 分布：

| primitive              | matrixValueCount |
| ---------------------- | ---------------: |
| Cylinder               |               16 |
| Cuboid                 |               16 |
| StretchedBody          |               16 |
| PorcelainBushing       |               16 |
| TruncatedCone          |               16 |
| Ring                   |               16 |
| TerminalBlock          |               16 |
| Sphere                 |               16 |
| ChannelSteel           |               16 |
| Table                  |               16 |
| CircularGasket         |               16 |
| RectangularFixedPlate  |               16 |
| OffsetRectangularTable |               16 |
| RectangularRing        |               16 |

Visible=False 分布：

| primitive     | Visible=False 数量 |
| ------------- | ---------------: |
| StretchedBody |              494 |
| Cylinder      |              144 |
| Cuboid        |               54 |
| 合计            |              692 |

Visible=True 分布摘要：

| primitive              | Visible=True 数量 |
| ---------------------- | --------------: |
| Cylinder               |           20277 |
| Cuboid                 |           12347 |
| StretchedBody          |            9769 |
| PorcelainBushing       |            1506 |
| TruncatedCone          |             730 |
| Ring                   |             235 |
| TerminalBlock          |             201 |
| Sphere                 |             141 |
| ChannelSteel           |             129 |
| Table                  |             109 |
| CircularGasket         |              80 |
| RectangularFixedPlate  |              18 |
| OffsetRectangularTable |              15 |
| RectangularRing        |               1 |

### 14.3 分析结论

当前 demo-substation 中：

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

---

## 15. demo-substation EMPTY_DEVICE_XML / orphan MOD

### 15.1 当前结果

demo-substation 中存在 44 个 EMPTY_DEVICE_XML。

这些文件：

```text
全部 .mod
全部 78 bytes
SHA256 完全一致
内容均为 <Device><Entities /></Device>
全部未被 PHM 引用
全部未被 DEV-linked CBM 到达
```

MOD inventory by kind + PHM referenced：

|   数量 | kind + PHM referenced   |
| ---: | ----------------------- |
| 4135 | XML_WITH_ENTITIES, True |
|   44 | EMPTY_DEVICE_XML, False |

MOD kinds not reached from DEV-linked CBM：

| 数量 | kind + PHM referenced   |
| -: | ----------------------- |
| 44 | EMPTY_DEVICE_XML, False |

### 15.2 分析结论

这 44 个文件不是 missing reference。

更准确的分类是：

```text
UNREFERENCED_EMPTY_MOD
```

处理策略：

```text
不参与主链解析
不参与渲染
不作为 missing reference
仅进入诊断报告
```

---

## 16. MOD 与上游 CBM entityName 映射

### 16.1 目的

确认不同 MOD kind 与上游业务对象类型之间的关系。

### 16.2 demo-line 映射结果

CBM resolved MOD references by entityName + modKind：

| 引用次数 | entityName + modKind                 |
| ---: | ------------------------------------ |
| 5460 | WIRE, TEXT_KEY_VALUE                 |
| 1300 | Tower_Device, TEXT_SECTION_KV_RECORD |
| 1300 | Tower_Device, TEXT_KEY_VALUE         |
|  327 | Tower_Device, TEXT_HNUM_COMMA_RECORD |
|  315 | CROSS, TEXT_POINT_LINE               |

Unique MOD files reached by CBM entityName + modKind：

| 唯一 MOD 数 | entityName + modKind                 |
| -------: | ------------------------------------ |
|     1300 | Tower_Device, TEXT_SECTION_KV_RECORD |
|      315 | CROSS, TEXT_POINT_LINE               |
|      152 | Tower_Device, TEXT_KEY_VALUE         |
|       31 | Tower_Device, TEXT_HNUM_COMMA_RECORD |
|        9 | WIRE, TEXT_KEY_VALUE                 |

demo-line 中没有未被 DEV-linked CBM 到达的 MOD kind。

### 16.3 demo-line 映射结论

demo-line 中：

```text
Tower_Device 使用：
- TEXT_SECTION_KV_RECORD
- TEXT_KEY_VALUE
- TEXT_HNUM_COMMA_RECORD

CROSS 使用：
- TEXT_POINT_LINE

WIRE 使用：
- TEXT_KEY_VALUE
```

其中：

```text
WIRE 对 9 个 TEXT_KEY_VALUE MOD 形成 5460 次引用。
Tower_Device 对 31 个 TEXT_HNUM_COMMA_RECORD MOD 形成 327 次引用。
```

这说明线路 MOD 存在明显的复用模式。

### 16.4 demo-substation 映射结果

MOD inventory by kind + PHM referenced：

|   数量 | kind + PHM referenced   |
| ---: | ----------------------- |
| 4135 | XML_WITH_ENTITIES, True |
|   44 | EMPTY_DEVICE_XML, False |

CBM resolved MOD references by entityName + modKind：

| 引用次数 | entityName + modKind         |
| ---: | ---------------------------- |
| 4135 | F4System, XML_WITH_ENTITIES  |
| 3894 | PARTINDEX, XML_WITH_ENTITIES |

Unique MOD files reached by CBM entityName + modKind：

| 唯一 MOD 数 | entityName + modKind         |
| -------: | ---------------------------- |
|     4135 | F4System, XML_WITH_ENTITIES  |
|     3894 | PARTINDEX, XML_WITH_ENTITIES |

未被 DEV-linked CBM 到达的 MOD：

| 数量 | kind + PHM referenced   |
| -: | ----------------------- |
| 44 | EMPTY_DEVICE_XML, False |

### 16.5 demo-substation 映射结论

demo-substation 中：

```text
XML_WITH_ENTITIES 均被 PHM 引用。
EMPTY_DEVICE_XML 均未被 PHM 引用。
EMPTY_DEVICE_XML 均未被 DEV-linked CBM 到达。
```

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

---

## 17. Round 4 当前结论

当前可以形成以下结论：

```text
1. MOD 不是单一格式。
2. demo-line MOD 是多种文本格式族。
3. demo-substation MOD 是 XML Device / Entities / Entity / primitive 格式族。
4. demo-line 没有 orphan MOD。
5. demo-substation 有 44 个 UNREFERENCED_EMPTY_MOD。
6. demo-substation 的 EMPTY_DEVICE_XML 未被 PHM 引用，也未被 DEV-linked CBM 到达。
7. XML MOD 中 Entity.Type 全部为 simple。
8. XML MOD 的 primitive 类型由 Entity 子节点名称决定，不由 Entity.Type 决定。
9. XML MOD 每个 Entity 恰好有 1 个 primitive 子节点。
10. XML MOD 每个 Entity 都有 TransformMatrix.Value。
11. TransformMatrix.Value 全部是 16 个数。
12. XML MOD 每个 Entity 都有 Color A/R/G/B。
13. XML MOD 中 Visible 是 Entity 级字段。
14. 线路 MOD 需要按文本格式族分支解析。
15. 变电 XML MOD 可以优先按 Device / Entities / Entity / primitive 结构解析。
```

---

## 18. 浏览器实现影响

### 18.1 MOD parser 不能按单一格式实现

当前两个 demo 已经证明：

```text
demo-line MOD：文本格式族
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

### 18.2 线路 MOD 需要文本多分支解析

demo-line 至少需要以下分支：

```text
TEXT_SECTION_KV_RECORD
TEXT_POINT_LINE
TEXT_KEY_VALUE
TEXT_HNUM_COMMA_RECORD
```

不同分支的字段结构完全不同，不能强行映射为统一 DTO。

### 18.3 变电 MOD 可优先解析 XML 结构

demo-substation 的 XML MOD 结构稳定：

```text
Device
  Entities
    Entity
      TransformMatrix
      Color
      primitive
```

可以优先作为结构化解析候选。

但解析时需要注意：

```text
Entity.Type 不是 primitive 类型。
primitive 类型要从 Entity 子节点名读取。
```

### 18.4 EMPTY_DEVICE_XML 不进入主链渲染

44 个 EMPTY_DEVICE_XML：

```text
未被 PHM 引用
未被 DEV-linked CBM 到达
```

因此浏览器策略应为：

```text
不参与主链解析
不参与渲染
不作为 missing reference
进入诊断报告
```

### 18.5 Visible 应作为实体级字段保留

当前观察到：

```text
Visible=True 45558
Visible=False 692
```

后续解析模型中应保留 Visible 字段。

但当前还不能直接确定：

```text
Visible=False 一定应跳过渲染。
```

更稳妥的策略是解析保留、渲染层再决策。

### 18.6 TransformMatrix.Value 可作为 16 元矩阵字段进入后续设计

当前所有 XML Entity 的 TransformMatrix.Value 都是 16 个数。

但当前不能确认：

```text
矩阵行主序 / 列主序
坐标系方向
单位
与 PHM TRANSFORMMATRIX 的组合顺序
```

这些需要后续专门分析。

---

## 19. 当前不能得出的结论

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
```

当前只能确认：

```text
在当前两个 demo 中，MOD 存在显著格式分型。
demo-line MOD 是多种文本格式族。
demo-substation MOD 是 XML primitive 格式族。
DEV-linked CBM 能到达的 MOD 均属于可静态识别格式。
```

---

## 20. Round 4 后续建议

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

原因是 Round 3 已经确认：

```text
DEV -> PHM -> MOD/STL 可达
```

Round 4 已经确认：

```text
MOD 内部存在几何 primitive 和 TransformMatrix
```

下一步应确认：

```text
PHM.TRANSFORMMATRIX 与 MOD.Entity.TransformMatrix 如何共同构成最终局部 / 全局变换链。
```
