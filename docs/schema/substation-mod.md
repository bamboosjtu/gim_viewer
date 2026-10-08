# 变电 XML MOD

变电 MOD 的主要内容为 Device XML，包含 Entity、局部矩阵、颜色和 primitive。
当前 parser 能解析的类型多于实际几何覆盖，解析成功不能等同完整渲染。

## 文件 grammar

```xml
<Device>
  <Entities>
    <Entity ID="1" Type="simple" Visible="true">
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
      <Color R="128" G="128" B="128" A="0" />
      <Cuboid L="1000" W="500" H="300" />
    </Entity>
  </Entities>
</Device>
```

合成示例不含工程来源标识。Device 与 primitive 标签大小写敏感。
`<Device><Entities /></Device>` 是合法空内容；有 Entity 但全都 malformed 或 unsupported
不能记成 empty。缺少 Entities 时当前 parser 也返回空文档。

| 元素/字段 | 当前解析行为 |
|---|---|
| Entity.ID | 整数 ID；不可解析则该 Entity 不进入实体集合 |
| Entity.Type | 不作为 primitive 名称；非 simple 值诊断并按当前 simple IR 处理 |
| Entity.Visible | 缺失默认为 true；false 不进入可见几何 |
| TransformMatrix.Value | 16 项数组；缺失/词法异常按单位阵回退 |
| Color | 可选；通道与刻度规则见几何模型 |
| primitive | 跳过 TransformMatrix/Color 后取首个子元素；未知保留 Unsupported/raw |

当前数值读取通常使用 parseFloat，缺字段可能为 NaN，不是隐式合法零值。
矩阵有限性与数值词法的严格覆盖仍需按源码与测试边界评估，不能由 XML 合法推定几何合法。

## primitive 字段及实际覆盖

尺寸按照当前 MOD 消费以毫米处理。表中“渲染”描述当前实现，不能替代设计级形状验证。

| 来源类型 | 关键属性 | 当前解析/渲染 |
|---|---|---|
| Cuboid | L,W,H | 强类型；长方体 |
| Cylinder | R,H | 强类型；圆柱 |
| Sphere | R | 强类型；球体 |
| TruncatedCone | BR,TR,H | 强类型；截锥 |
| Ring | R,DR,Rad | 强类型；环体，依源码参数约定 |
| CircularGasket | H,Rad,OR,IR | 强类型；垫圈几何 |
| StretchedBody | L,Array,Normal | 保留字符串；截面三角化与拉伸 |
| PorcelainBushing | R,R1,R2,N,H | 强类型；当前无直接几何生成 |
| TerminalBlock | L,W,H?,T,R,BL,CL,CS,RS,CN,RN,Phase | 强类型；当前无直接几何生成 |
| ChannelSteel | L,Model,D?,H?,B?,T? | 强类型；当前无直接几何生成 |
| Table | H,LL1,LL2,TL1,TL2 | 强类型；当前无直接几何生成 |
| RectangularFixedPlate | raw attrs | 弱结构保留；当前无直接几何生成 |
| OffsetRectangularTable | raw attrs | 弱结构保留；当前无直接几何生成 |
| RectangularRing | raw attrs | 弱结构保留；当前无直接几何生成 |
| Boolean | Type,Entity1,Entity2 | Union/Intersection/Difference；按引用构造 CSG |
| Wire | D,FitCoordArray | 有效三元点；样条管近似 |
| Cable | D,StartCoord,InflectionCoordArray,EndCoord | 拼合有效点；样条管近似 |
| RotationalEllipsoid | H,LR,WR | 强类型；缩放球体近似 |
| BeamChannel / LightBeamChannel / H | Length,Model | BeamChannelLike；盒体近似 |
| 其他标签 | raw attrs | Unsupported，局部降级并保留来源类型 |

Insulator、ConePorcelainBushing、SquareGasket、CircularFixedPlate、BendingCylindrical 等
未进入强类型分支的来源不能因为名字看似熟悉就宣称支持。
全部覆盖以 [parser](../../desktop/src/gim/geometry/xmlModParser.ts) 与
[geometry renderer](../../desktop/src/viewer/xmlModGeometry.ts) 的实际分支为准。

## StretchedBody

Array 是分号分隔点序列，每点为逗号三元组；Normal 是源向量字符串，L 为长度来源。
当前渲染去掉重复截面点并按支持的二维截面路径三角化/拉伸。
闭合、退化、非平面截面和任意法向不能仅凭记录数量认定完整支持。
Normal 与 Entity 矩阵分别生效，不能将 Normal 当整个装配的绝对朝向。

## Boolean 与实体引用

Boolean 的 Type 归一化后只接受 union/intersection/difference，其他操作 Unsupported。
Entity1/Entity2 通过本文件实体 ID 引用，操作数缺失、环与异常几何不能得到伪造结果。
CSG 的局部实体变换在统一 MOD 空间处理，再应用单位和外部装配变换。
合并相同材质只改变场景资源组织，不改变源实体 ID 和支持度记录。

## 状态与计数

XmlModDocument 保留 declaredEntityCount、malformedEntityCount、entities、isEmpty 与 colorMaxA。
运行时单独统计实际可见几何和 unsupported 类型。合并后的 mesh 数量不等于源 Entity 数量。
空文件、解析异常、有内容但不支持、部分可渲染和完整可渲染不能混成一个布尔值。
颜色和变换的统一契约见 [几何模型](geometry-model.md)，行动见 [未决事项](../open-issues.md)。
