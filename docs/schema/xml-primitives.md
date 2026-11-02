# 变电 XML primitive 参考

本文只回答一个问题：当前 parser 认到的 primitive，在浏览视图中变成了什么。字段解释来自
[xmlModParser](../../desktop/src/gim/geometry/xmlModParser.ts)，几何生成来自
[xmlModGeometry](../../desktop/src/viewer/xmlModGeometry.ts)，类型契约见
[ir.ts](../../packages/powerline-core/src/geometry/ir.ts)。它不是 GIM/IFC 格式标准；解析成功不等于精确重建，也不等于源形状、尺寸或安装关系已被验证。

文件 grammar、Entity 字段回退、Boolean 求值规则和状态计数的完整说明见 [substation-mod](substation-mod.md)；矩阵、单位与颜色契约见 [geometry-model](geometry-model.md)。本文只补充 primitive 粒度的字段映射、LOD 与上限。

## 公共约定

| 主题 | 当前实现 |
|---|---|
| 单位 | MOD 尺寸、Array/Normal 点与 Entity 平移按毫米；场景按 ×0.001 转米。Group 路径在 Group 上缩放，烘焙路径把 Scale(0.001) 写进顶点并保持 group.scale=1。 |
| 轴 | 源为 Z-up 局部坐标：圆柱/锥/球沿 +Z，底面在 Z=0；Y-up 转换与 IFC 对齐不在本层完成。 |
| 变换 | TransformMatrix 为 16 项列主序，平移在 m[12..14]；Matrix4.fromArray 直载，缺失、非 16 项或含 NaN 时回退单位阵。每个 Entity 的矩阵只在其父坐标系应用一次。 |
| 颜色/透明度 | RGB 0–255（/255）；A 按文件级 max(A)>100 判字节制（/255），否则百分制（/100）；A≤0 为不透明哨兵；非法或缺失 Color 用灰色不透明。材质按 (hex, opacity, transparent) 共享。 |
| LOD | 0 远景 / 1 中景 / 2 近景；几何入口函数的默认参数为 2，但产品自动策略只请求 L0/L1，L2 由属性面板显式请求。分段、Boolean 策略与小构件过滤随档位变化，见后文。 |
| 失败表示 | 无几何的 Entity 不进入可见几何；可见根的失败在下钻依赖中记录 reason：`missing-reference`、`cycle`、`operand-unavailable`、`csg-failed:<error>`、`unsupported-or-invalid:<type>`。 |

## Primitive 总表

“状态/限制”描述当前实现，不是验收结论；表中类型均已有 parser 分支与几何分支（Unsupported 除外）。

| Primitive | 来源标签与别名 | 关键字段 | 当前几何 | LOD/简化 | 状态/限制 |
|---|---|---|---|---|---|
| Cuboid | Cuboid（大小写不敏感） | L,W,H | Box(L,W,H)，XY 居中，底面 Z=0、顶面 Z=H | 固定 12 三角形 | 数值缺失保留 NaN，可能得到零尺寸或 NaN 顶点几何，不返回 null；不校验正负 |
| Cylinder | Cylinder | R,H | 沿 +Z 圆柱，底面圆心为原点，含端盖 | 径向 6 / 12 / 16 | R 或 H 非正不拒绝，可能退化 |
| Sphere | Sphere | R | 球心在原点 | 6×4 / 12×6 / 16×8 | 同 Cylinder |
| TruncatedCone | TruncatedCone | BR,TR,H | 底半径 BR；顶半径在 TR∈[0,1] 时取 BR×TR，否则按绝对半径 | 径向 6 / 12 / 16 | 两种 TR 方言无法从字段本身区分 |
| Ring | Ring | R,DR,Rad | Torus(R, abs(DR), 弧 Rad)；DR 为管半径、Rad 为弧度 | 4×8 / 8×16 / 8×16 | Rad 缺失为 NaN→0，扫掠退化但不返回 null |
| CircularGasket | CircularGasket | OR,IR,Rad（H 解析但未使用） | Torus(OR, max(0,(OR−IR)/2), 弧 Rad) | 固定 8×16 | IR≥OR 时管半径为 0；H 被忽略 |
| StretchedBody | StretchedBody | L,Array,Normal | 截面多边形端盖（Earcut）+ 侧面，沿解释后的 Normal 位移 | 无分段 | 见专节；少于 3 点或非法 Normal 返回 null |
| PorcelainBushing | PorcelainBushing；Insulator、VTypeInsulator、ConePorcelainBushing 映射而来 | R,R1,R2,N,H | 锥柱主体 Cylinder(R2,R,H) + N 组伞裙片 | L0 仅主体，L1/L2 加伞裙；N 上限 512 | 伞裙为浏览近似，不还原真实伞形、伞间距与瓷色 |
| TerminalBlock | TerminalBlock | L,W,H?,T,R,BL,CL,CS,RS,CN,RN,Phase | 基板 Box(L,W,T) + CN×RN 圆柱端子 | L0 仅基板，L1/L2 加端子 | 栅格>4096 不生成几何并记诊断；H、Phase 不参与几何 |
| ChannelSteel | ChannelSteel；DoubleChannelSteel | L,Model,D?,H?,B?,T? | 外廓盒 Box(B 或 D 或 100, L, H 或 T 或 50)，长度沿 +Y | 无 LOD 变化 | 无截面型号表；L 或宽高非正返回 null；Model 仅保留 |
| Table | Table | H,LL1,LL2,TL1,TL2 | 外廓盒 Box(LL1,LL2,H)，居中 | 无 LOD 变化 | LL1、LL2、H 非正返回 null；TL1/TL2 未使用，忽略孔洞与栏栅 |
| RectangularFixedPlate | RectangularFixedPlate（含 Rectangularfixedplate） | raw：L 或 L1、W 或 W1、T 或 H | Box(l,w,t)，底面 Z=0 | 无 | 缺字段按 1 mm 兜底，不跳过；螺栓孔忽略 |
| OffsetRectangularTable | OffsetRectangularTable | raw 七字段：LL,LW,TL,TW,H,XOFF,YOFF | 8 顶点棱台：下矩形 XY 居中 Z=0，上矩形在 Z=H 并施加 XOFF/YOFF | 12 三角形 | 缺任一字段、非有限或非正尺寸返回 null；其他编码不支持 |
| RectangularRing | RectangularRing；SquareGasket、TableGasket | raw：L1,W1,L2,W2,H 或 T | 四块板拼成的矩形框 | 无 | 内框钳制到不超过外框，缺省 0.8×；退化返回 null |
| Boolean | Boolean | Type,Entity1,Entity2 | 引用同文件 Entity ID 求值 | L0/L1 轮廓，L2 CSG | 操作数缺失、成环或异常不伪造结果；见专节 |
| Wire | Wire | D,FitCoordArray | 拟合点 CatmullRom 样条管，半径 D/2 | 管段 8–256，径向 6 | 有效点少于 2 个返回 null；另叠 1px 中心线 |
| Cable | Cable | D,StartCoord,InflectionCoordArray,EndCoord | 首末点与拐点拼合后的同样条管 | 同 Wire | 非法首末点被静默丢弃 |
| RotationalEllipsoid | RotationalEllipsoid | H,LR,WR | 半径 0.5 的单位球按 LR、WR、H 三轴缩放（当全长） | 固定 16×8 | 每轴下限 1 mm；不是精确椭球参数化 |
| BeamChannelLike | BeamChannel、LightBeamChannel、H、H-beam、BeamChannelLike | Length,Model | 固定盒 Box(100,Length,50)，居中 | 无 | 无型号表；Length 缺失按 1 mm 兜底 |
| Unsupported | 其余任意标签（含非法 Boolean Type） | raw | 无 | 无 | 跳过并计入 unsupported 统计；sourceType 保留原标签，不记 empty |

## 标签归一与导出器别名

归一化在 parser 内完成：`trim().toLowerCase()` 查表，命中后以 canonical 名进入 switch；未命中保留原标签进 Unsupported。大小写变体自动等价，但错拼不会被猜测，也不会退回弱 schema。

| 原始标签（大小写不敏感） | 归一/结果 | 字段去向 |
|---|---|---|
| Rectangularfixedplate | RectangularFixedPlate | 弱 schema 矩形板 |
| H-beam | H → BeamChannelLike | Length,Model → 盒体 |
| DoubleChannelSteel | ChannelSteel | L,D,H,B,T → 外廓盒体 |
| Insulator、VTypeInsulator | PorcelainBushing | n=max(1,N1 或 N)；h=(H1 或 H)×n；r=r1=R1 或 R；r2=R2 或 R1 或 R；D、FL、AL、LN 忽略 |
| ConePorcelainBushing | PorcelainBushing | r=BR2 或 BR；r1=TR2 或 TR；r2=TR1 或 TR；n=N；h=H |
| EccentricTruncatedCone | TruncatedCone | br=BR；tr=TR；h=H；偏心量忽略 |
| SquareGasket、TableGasket | RectangularRing | 原 attrs 进 raw |
| EllipticRing | Ring | r=(LR+WR)/2；dr=DR；rad 取 Rad>0 时的 Rad，否则 2π |
| BendingCylindrical | Cylinder | r=R；h=L；弯曲半径与弧长忽略 |
| CircularFixedPlate | Cylinder | r=(L 或 D)/2；h=T；W、CS、N、MH 忽略 |
| 其他标签 | Unsupported | 原 attrs 进 raw |

别名只把来源字段塞进既有槽位，不扩大支持范围；映射后的几何仍是目标类型的浏览近似。

## StretchedBody：Array、Normal 与位移语义

| 项 | 当前实现 |
|---|---|
| Array | 分号分隔点序列，逗号三元组；二维点补 z=0；连续重复点与闭合尾点删除；有效点少于 3 个返回 null |
| Normal≈1（±1e-6）或≈304.8（±1e-5） | 视为方向基矢：归一化后 ×L。304.8 mm 是一英尺的方向表达，不是固定 304.8 mm 位移 |
| Normal 其他非零有限值 | 视为完整位移向量，原样使用，不再乘 L |
| 无效输入 | 分量数不是 3、存在空分量、非有限、模长≈0，或方向模式下 L 非有限/为 0 → 不生成几何 |
| 截面 | 投影到与 Normal 正交的基做 Earcut（支持凹多边形），顶点仍用原始三维点；端盖与侧面按期望法向校正绕序 |
| 单位 | Array 与 L 均为毫米；Normal 只表达方向或位移，不单独换算单位 |

位移解释由 [stretchedBody](../../desktop/src/gim/geometry/stretchedBody.ts) 单点维护，几何与设备范围计算共用，避免两处各算一套。

## Boolean：引用、轮廓与 CSG

| 运算 | L0/L1 轮廓近似 | L2 精确求值 |
|---|---|---|
| Union | 合并 Entity1 与 Entity2 的表面 | three-bvh-csg ADDITION |
| Intersection | 保留 Entity1，交集不参与轮廓 | INTERSECTION |
| Difference | 保留 Entity1，孔洞不挖 | SUBTRACTION |

| 边界 | 行为 |
|---|---|
| Entity1/Entity2 | 同 MOD 内的 Entity.ID；缺失记 missing-reference，成环记 cycle，操作数无可用几何记 operand-unavailable |
| 隐藏操作数 | 仍参与引用校验与轮廓遍历；跳过的切割分支只校验引用、不生成网格 |
| 空操作数 | Union 取非空一侧，Difference 取 Entity1，Intersection 为空结果（合法空） |
| CSG 失败 | 记 csg-failed，L2 回退轮廓并标 partial，不标记完整 |
| 镜像 | 矩阵行列式为负时翻转索引绕序，保持法向与内外分类一致 |
| 诊断计数 | simplifiedBooleans、approximatedBooleans（按运算计数）、representationPolicy |

## Wire 与 Cable：点序列与真实管径

| 项 | Wire | Cable |
|---|---|---|
| 点来源 | FitCoordArray | StartCoord + InflectionCoordArray + EndCoord |
| 解析 | 分号点序列，非法 token 跳过 | 单点解析失败返回空数组，拼合后过滤非有限值 |
| 几何 | CatmullRom 样条 + TubeGeometry，半径 max(D/2, 1e-6) | 同 Wire |
| 管段 | clamp(点数/3, 8, 256)，径向 6，不闭合 | 同 Wire |
| 失败 | 有效点少于 2 个 → null | 同 Wire |

loader 另叠一条 1px 中心线：每 Entity 一条 Line，超过 1000 条时按颜色合并为 LineSegments。它只保证低档位可见，不参与拾取、量测或电气连接判断；管径始终取源 D，不用放大管径换可见性。实现见 [xmlModLoader](../../desktop/src/viewer/xmlModLoader.ts)。

## 弱 schema 与 Unsupported

| 类型 | raw 字段 | 回退与判定 |
|---|---|---|
| RectangularFixedPlate | L 或 L1、W 或 W1、T 或 H | 逐字段取第一个有限正值，缺失或非正一律 1 mm；只忽略孔洞类字段 |
| OffsetRectangularTable | LL,LW,TL,TW,H,XOFF,YOFF | 七字段必须齐全、非空、有限，且前五项均大于 0，否则返回 null；XOFF/YOFF 可为负 |
| RectangularRing | L1,W1,L2,W2,H 或 T | 外框缺省 1 mm；内框缺省 0.8× 外框并钳制不超过外框；两侧厚度都为 0 或厚度非正时返回 null |
| Unsupported | 全部 attrs | 不生成几何，保留 sourceType 与 raw；计入 unsupportedPrimitiveTypeCounts |

未知标签必须记 Unsupported，不能记 empty：有 Entity 但全部不可解析时，文件状态是 unsupported，否则缓存会把“解析器不会”写成空模型。三个弱 schema 类型相反——字段不可解释时仍可能产出 1 mm 兜底几何，因此“有网格”也不代表字段被正确理解。

## 近似类型与明确忽略的字段

| 类型 | 近似方式 | 明确忽略 |
|---|---|---|
| PorcelainBushing（含 Insulator/VTypeInsulator、ConePorcelainBushing） | 锥柱 + 均布伞裙片 | 真实伞形曲线、伞间距、瓷色、V 串双串几何 |
| TerminalBlock | 基板 + 规则栅格端子 | 高度 H、Phase、螺孔与接线细节 |
| ChannelSteel、Table、BeamChannelLike | 外廓盒体 | 截面型号、腹板/翼缘、孔洞、栏栅 |
| RectangularRing（SquareGasket、TableGasket） | 四块板拼合 | 圆角、密封槽、螺栓分布 |
| RectangularFixedPlate | 矩形板 | 螺栓孔、倒角、开槽 |
| EllipticRing | 平均半径圆环 | 椭圆长短轴差异 |
| BendingCylindrical | 直圆柱 | 弯曲半径、弧长与路径 |
| CircularFixedPlate | 圆盘 | 螺栓孔（CS/N/MH）、W |
| EccentricTruncatedCone | 同心截锥 | 偏心量 |
| RotationalEllipsoid | 缩放球 | 精确椭球参数化 |
| OffsetRectangularTable | 八顶点棱台 | 其他字段编码、孔洞 |
| Wire、Cable | 样条管 | 真实弧垂、张力、接头与敷设细节 |

## 分段、上限与超限行为

| 对象 | LOD0 | LOD1 | LOD2 | 超限/缺失行为 |
|---|---|---|---|---|
| 圆柱、锥（径向段） | 6 | 12 | 16 | 固定，无截断 |
| 球（宽×高） | 6×4 | 12×6 | 16×8 | 固定，无截断 |
| Ring（径向×管向） | 4×8 | 8×16 | 8×16 | 固定 |
| CircularGasket | 8×16 | 8×16 | 8×16 | 不随 LOD 变化 |
| RotationalEllipsoid | 16×8 | 16×8 | 16×8 | 不随 LOD 变化 |
| PorcelainBushing 伞裙 | 0 | N | N | N 取 min(512, floor(N))，超出静默截断 |
| TerminalBlock 端子 | 0 | CN×RN | CN×RN | CN/RN 各限 256；乘积>4096 返回 null 并记 unsupported-or-invalid 诊断 |
| Wire/Cable 管段 | 8–256 | 8–256 | 8–256 | clamp(点数/3, 8, 256)，径向固定 6 |
| 小构件过滤（仅烘焙/LOD 路径） | Cylinder/Sphere/Ring/CircularGasket 的最大外接尺寸≤100 mm、Cuboid≤50 mm 时丢弃 | 同 LOD0 | 不过滤 | 整文件无可渲染时回填最大的一件；计数进 omittedSmallParts |

“无截断”只表示本层没有硬性上限，不代表任意参数组合都可靠。

## 源码入口与验证边界

- parser：[xmlModParser](../../desktop/src/gim/geometry/xmlModParser.ts)；几何与 LOD：[xmlModGeometry](../../desktop/src/viewer/xmlModGeometry.ts)
- 语义单点：[stretchedBody](../../desktop/src/gim/geometry/stretchedBody.ts)、[offsetRectangularTable](../../desktop/src/gim/geometry/offsetRectangularTable.ts)
- 类型契约：[ir.ts](../../packages/powerline-core/src/geometry/ir.ts)；加载、中心线与状态汇总：[xmlModLoader](../../desktop/src/viewer/xmlModLoader.ts)
- 格式与 Entity 契约：[substation-mod](substation-mod.md)、[geometry-model](geometry-model.md)

- parser 接受不等于几何支持：19 个 canonical 类型都有分支，但字段缺失、NaN、非正尺寸、退化轮廓、栅格超限会得到 null 或零尺寸几何；renderableTypes 只是诊断分类，不保证该 Entity 出图。
- 尺寸与安装测量不可用：伞裙、端子栅格、盒体、样条管、圆环只保证浏览轮廓与位置量级，不能反推设计尺寸、装配间隙或电气参数。
- 新增类型必须同时补字段映射（含别名）、浏览几何与 LOD/近似说明、上限与失败 reason，并同步本文与 [substation-mod](substation-mod.md) 的分工；只加 parser 分支会让文件被记成 unsupported 或 partial。
- 已知偏差：当前实现已为 ChannelSteel、Table 生成外廓盒体（早期文字说明曾记为“无直接几何”）；以本文与源码为准，其它文档与源码不一致时应同步。
- 颜色、可见性与材质共享只影响显示，不能据此推断设备类别、带电状态或工程归属。
