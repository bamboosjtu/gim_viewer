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
| StretchedBody | L,Array,Normal | 单位 Normal 使用方向×L，非单位 Normal 使用完整位移；支持凹截面三角剖分 |
| PorcelainBushing | R,R1,R2,N,H | 强类型；锥柱与均布伞裙组合，伞裙为浏览近似；远景保留主体 |
| TerminalBlock | L,W,H?,T,R,BL,CL,CS,RS,CN,RN,Phase | 强类型；基板与 CN×RN 栅格端子组合，远景保留基板 |
| ChannelSteel | L,Model,D?,H?,B?,T? | 强类型；当前无直接几何生成 |
| Table | H,LL1,LL2,TL1,TL2 | 强类型；当前无直接几何生成 |
| RectangularFixedPlate | L,W,T | 矩形板浏览近似；螺栓孔等字段忽略 |
| OffsetRectangularTable | TL,TW,LL,LW,H,XOFF,YOFF | 仅接受显式七字段编码；下矩形 XY 居中且 Z=0，上矩形位于 Z=H 并施加偏移；其他编码保留不支持诊断 |
| RectangularRing | L1,W1,L2,W2,H | 矩形框浏览近似（四块板）；字段缺失回退为退化的外框 |
| Boolean | Type,Entity1,Entity2 | Union/Intersection/Difference；按引用构造 CSG |
| Wire | D,FitCoordArray | 有效三元点；样条管近似 |
| Cable | D,StartCoord,InflectionCoordArray,EndCoord | 拼合有效点；样条管近似 |
| RotationalEllipsoid | H,LR,WR | 强类型；缩放球体近似 |
| BeamChannel / LightBeamChannel / H / H-beam | Length,Model | BeamChannelLike；盒体近似；`H-beam` 为导出器别名 |
| DoubleChannelSteel | raw attrs | 归一为 ChannelSteel；当前无直接几何生成 |
| Insulator / VTypeInsulator | N,D,N1,H1,R,R1,R2,FL,AL,LN | 映射 PorcelainBushing（高度 H1×N1），浏览近似；V 串按单串处理 |
| ConePorcelainBushing | H,BR,TR,BR1,BR2,TR1,TR2,N | 映射 PorcelainBushing（BR2/TR2/TR1），浏览近似 |
| EccentricTruncatedCone | BR,TR,H（偏心字段忽略） | 映射 TruncatedCone，浏览近似 |
| SquareGasket / TableGasket | L1,W1,L2,W2,H | 矩形框近似（四块板） |
| EllipticRing | LR,WR,DR,Rad | 映射 Ring（LR/WR 平均半径），浏览近似 |
| BendingCylindrical | R,L,Rad | 映射 Cylinder（忽略弯曲），浏览近似 |
| CircularFixedPlate | L,W,T,CS,N,MH,D | 映射 Cylinder 圆盘，忽略螺栓孔 |
| 其他标签 | raw attrs | Unsupported，局部降级并保留来源类型 |

标签匹配按小写规范化，`Rectangularfixedplate`、`RectangularFixedPlate` 等大小写变体进入同一分支。

六组样本实测（substation01–04 与 500-A3-1/B1-1/B1-3/B1-4；B1-2 未取得 pack）已覆盖此前未支持的 `Insulator`、`VTypeInsulator`、`ConePorcelainBushing`、`EccentricTruncatedCone`、`SquareGasket`、`TableGasket`、`EllipticRing`、`BendingCylindrical`、`CircularFixedPlate`、`RectangularFixedPlate`。这些分支只承诺浏览近似，忽略的字段（偏心量、螺栓孔、V 串几何、弯曲半径）在代码注释与本节中列明，不能据此做尺寸或安装测量。

仍未生成直接几何的类型为 `ChannelSteel`、`Table`（解析保留、渲染暂停）以及任何未知标签；它们继续走显式诊断，不伪装成 empty。补充新类型时须提供参数映射并标记 simplified。
全部覆盖以 [parser](../../desktop/src/gim/geometry/xmlModParser.ts) 与[geometry renderer](../../desktop/src/viewer/xmlModGeometry.ts) 的实际分支为准。

## StretchedBody

Array 是分号分隔点序列，每点为逗号三元组，二维点兼容为 z=0。已观察到两种编码：Normal 模长与 1 的差不超过 10⁻⁶ 时按方向向量解释，位移为归一化 Normal×L；其他非零有限 Normal 按完整位移解释，不使用 L 替换模长。单位方向缺少有效非零 L、非法或零 Normal 均不生成几何。该兼容约定依据字段结构，不依赖厂商或工程名；原值与解释模式保留在解析数据和设备范围诊断中。
渲染去掉重复截面点，投影用于凹多边形端盖三角剖分，最终顶点使用原始三维点与加上统一解释位移的顶层点；范围索引使用同一解释函数。
闭合、退化、非平面截面和任意法向不能仅凭记录数量认定完整支持。
Normal 与 Entity 矩阵分别生效，不能将 Normal 当整个装配的绝对朝向。

圆周与扫掠分段随浏览档位变化：远景使用最低分段，中景提高一档，近景使用当前固定分段；LOD0 的环体使用更低的双向分段。Wire/Cable 的管道段数、PorcelainBushing 的伞裙片数与 TerminalBlock 的端子栅格数各有上限，超限的对象不生成几何并保留诊断。BeamChannel 类无截面型号查表，按固定盒体近似，不能据此做截面量测。几何与颜色独立处理，继续消费 MOD/PHM 的继承颜色，不强制瓷套颜色。参数组合近似、未支持类型与来源异常保留诊断，不宣称全类型精确重建。

## Boolean 与实体引用

Boolean 的 Type 归一化后只接受 union/intersection/difference，其他操作 Unsupported。
Entity1/Entity2 通过本文件实体 ID 引用，操作数缺失、环与异常几何不能得到伪造结果。
每个求值节点包含自身 Entity 变换，中间节点和可见根各应用一次，再应用单位和外部装配变换；镜像同步翻转三角面绕序。隐藏操作数可参与求值。LOD1/2 使用递归 CSG；LOD0 将 Union 保留为实体表面组合，将 Difference/Intersection 分配至操作数实体对，只对包围盒相交的组合求值。Difference 切除体的包围盒两个较短边均不大于 50 mm 时可跳过，影响主要轮廓的大切口保留；Intersection 不用单一操作数冒充结果。此策略保留内部重叠面且简化小切口，属于浏览表示。
可见根诊断记录依赖 ID 与缺失、环、不支持或 CSG 异常；合法空交集是空结果。精细求值失败时可保留可支持的浏览表面并标记 partial，不计作完整几何。合并相同材质只改变场景资源组织，不改变源实体 ID 和支持度记录。

## 状态与计数

XmlModDocument 保留 declaredEntityCount、malformedEntityCount、entities、isEmpty 与 colorMaxA。
运行时单独统计实际可见几何和 unsupported 类型。合并后的 mesh 数量不等于源 Entity 数量。
空文件、解析异常、有内容但不支持、部分可渲染和完整可渲染不能混成一个布尔值。
颜色和变换的统一契约见 [几何模型](geometry-model.md)，行动见 [未决事项](../open-issues.md)。
