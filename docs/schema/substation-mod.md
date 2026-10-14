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
`<Device><Entities /></Device>` 是合法空内容；有 Entity 但全都 malformed 或 unsupported 不能记成 empty。缺少 Entities 时当前 parser 也返回空文档。

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
| Cuboid | L,W,H | 强类型；XY 居中，底面 Z=0，顶面 Z=H |
| Cylinder | R,H | 强类型；底面圆心为原点，局部 +Z 轴，含端盖 |
| Sphere | R | 强类型；中心为原点 |
| TruncatedCone | BR,TR,H | 强类型；0≤TR≤1 时顶半径为 TR×BR，TR>1 保留样本中的绝对半径兼容解释并记录诊断 |
| Ring | R,DR,Rad | 强类型；DR 为管半径，Rad 为弧度扫掠 |
| CircularGasket | H,Rad,OR,IR | 强类型；垫圈几何 |
| StretchedBody | L,Array,Normal | 保留 L 原值，沿完整有符号 Normal 向量拉伸，支持凹截面三角剖分 |
| PorcelainBushing | R,R1,R2,N,H | 强类型；锥柱与均布伞裙组合，伞裙为浏览近似；远景保留主体 |
| TerminalBlock | L,W,H?,T,R,BL,CL,CS,RS,CN,RN,Phase | 强类型；基板与 CN×RN 栅格端子组合，远景保留基板 |
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

Insulator、ConePorcelainBushing、SquareGasket、CircularFixedPlate、BendingCylindrical 等未进入强类型分支的来源不能因为名字看似熟悉就宣称支持。
全部覆盖以 [parser](../../desktop/src/gim/geometry/xmlModParser.ts) 与[geometry renderer](../../desktop/src/viewer/xmlModGeometry.ts) 的实际分支为准。

## StretchedBody

Array 是分号分隔点序列，每点为逗号三元组，二维点兼容为 z=0；Normal 是完整拉伸位移，不能归一化后再用 L 当长度。L 原值保留在 IR，不参与当前长度求值。
渲染去掉重复截面点，投影用于凹多边形端盖三角剖分，最终顶点使用原始三维点与加上 Normal 的顶层点。
闭合、退化、非平面截面和任意法向不能仅凭记录数量认定完整支持。
Normal 与 Entity 矩阵分别生效，不能将 Normal 当整个装配的绝对朝向。

核心类型按 LOD 使用不同圆周分段，孔阵、伞裙和端子为浏览细节。几何与颜色独立处理，继续消费 MOD/PHM 的继承颜色，不强制瓷套颜色。参数组合近似、未支持类型与来源异常保留诊断，不宣称全类型精确重建。

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
