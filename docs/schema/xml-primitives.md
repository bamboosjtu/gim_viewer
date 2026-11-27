# 变电 XML primitive 参考

本文只回答一个问题：当前 parser 认到的 primitive，在浏览视图中变成了什么。字段解释来自
[xmlModParser](../../desktop/src/gim/geometry/xmlModParser.ts)，几何生成来自
[xmlModGeometry](../../desktop/src/viewer/xmlModGeometry.ts)，类型契约见
[ir.ts](../../packages/gim-primitives/src/geometry/ir.ts)。它不是 GIM/IFC 格式标准；解析成功不等于精确重建，也不等于源形状、尺寸或安装关系已被验证。

文件 grammar、Entity 字段回退、Boolean 求值规则和状态计数的完整说明见 [substation-mod](substation-mod.md)；矩阵、单位与颜色契约见 [geometry-model](geometry-model.md)。本文只补充 primitive 粒度的字段映射、LOD 与上限。

## 目录

- [公共约定](#公共约定)
- [Primitive 总表](#primitive-总表)
- [标签归一与导出器别名](#标签归一与导出器别名)
- [StretchedBody：Array、Normal 与位移语义](#stretchedbodyarraynormal-与位移语义)
- [Boolean：引用、轮廓与 CSG](#boolean引用轮廓与-csg)
- [Wire 与 Cable：点序列与真实管径](#wire-与-cable点序列与真实管径)
- [弱 schema 与 Unsupported](#弱-schema-与-unsupported)
- [近似类型与明确忽略的字段](#近似类型与明确忽略的字段)
- [分段、上限与超限行为](#分段上限与超限行为)
- [源码入口与验证边界](#源码入口与验证边界)
- [相关文档](#相关文档)

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

Geometry Core 在图元局部毫米坐标中解释和编译下列来源。文档保留原始拼写、字段和诊断。可见根、放置、材质与 Boolean 求值由宿主处理。

| 条款 | 标签 | 当前表示与证据 |
|---|---|---|
| B.1、B.3、B.6 | Sphere、Cuboid、Cylinder | 球心或底面中心为原点。L/W/H、R 为正尺寸，缺失或非法时报告字段诊断。 |
| B.4、B.5 | Table、OffsetRectangularTable | 按顶底双对角线放样相似菱形，或按顶底长宽与有符号偏移放样矩形。工程入口将四个对角线完整但比例不等的来源标为兼容预览。 |
| B.7–B.9 | BendingCylindrical、TruncatedCone、EccentricTruncatedCone | 弯折件的两端分别沿 +X 和 Rad 指定方向，斜接工法为浏览近似。圆台按真实顶底半径生成，偏心圆台同时保留顶心偏移。 |
| B.10–B.12 | Ring、RectangularRing、EllipticRing | 中心线分别为圆弧、圆角矩形或椭圆，截面位于路径法平面。部分角度带端盖。B.11 的 W=2R 边界标为待核证。 |
| B.13–B.15 | CircularGasket、TableGasket、SquareGasket | 内外环、上下盖及内孔壁均由尺寸构造。B.14 两外半径各自大于内半径即可。B.15 按 CT 选择直角、圆角或切角。 |
| B.16 | StretchedBody | 三维轮廓沿单位方向乘长度拉伸，详见下节。 |
| B.17–B.20 | AngleSteel、I-shapedsteel、ChannelSteel、T-Steels | 显式截面沿 +X 拉伸，图示横向为 −Y，竖向为 +Z。各自以外角、底边中点、槽背中点或顶边中点定位。Model-only 槽钢保留既有浏览坐标和估算尺寸。 |
| B.25–B.27 | TerminalBlock、RectangularFixedPlate、CircularFixedPlate | 端子板 L 沿 Z、T 沿 Y，有上角切边和贯通孔。另两种板的孔沿 Z，MH 单独控制中心孔。圆板 L≠W 的外形待核证。 |

B.2、B.21–B.24 和 B.28/B.29 的分支状态见下方逐项表。

## 标签归一与导出器别名

Desktop 按登记的标签映射到 SDK 类型，SDK 严格入口支持表内拼写和标准示例的大写拼写。H-beam、BeamChannel、LightBeamChannel、DoubleChannelSteel 和旧 Cable 的浏览映射仍由宿主兼容层提供。未知标签保留来源属性。

## StretchedBody：Array、Normal 与位移语义

SDK 严格路径读取以分号分隔的三维底面顶点和非零方向向量，位移为 `normalize(Normal) × L`。底面在自身平面中裁分，可以斜向拉伸；非共面、自交、零高度或退化截面返回局部诊断。连续重复点及重复闭合端点在建模时归一化，输入预算按原点数计。显式 `stretch-displacement-v1` 可按已确认来源把 Normal 用作完整位移。Desktop 工程入口使用标准解释。

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

B.28 分别保留起终坐标、出线方向、拟合点、Sag 和 D。浏览曲线采用端切向约束的分段 Hermite 插值，完整包围范围由 Bézier 控制包及管半径给出。分析结果分列源 Sag、拟合点距端点弦线的最大距离和参考方向待核证状态。工程入口对缺少部分约束的 FitCoordArray 记录显式选择兼容预览。

B.29 按 CurveTypeArray 的 0/1/2 对应控制组。直线读取两个端点；圆弧第三组为切线虚交点，已知端点无法形成相切圆时返回局部诊断；样条前两组为端方向，后续才是控制点。样条基函数、选弧和折点接头保留浏览预览等级。允许末尾分隔符，内部空段、段数不符、零方向和不连续端点形成来源诊断。管径始终为 D，Desktop 的 1px 中心线沿实际路径显示并排除出拾取与测量。旧标签 Cable 按原提供方拐点语法处理。

## 弱 schema 与 Unsupported

标准字段不足、引用歧义、几何退化、容量超限分别保留诊断。合法空交集与未能编译的可见根在文档和缓存中分别计数。Model-only 型钢和未核证的构造细节在 SDK 结果中有估算或预览标记。

## 近似类型与明确忽略的字段

B.7 的接缝、B.11 的表注边界及未给出型材系列的公称截面不能用作精确设计依据。参数单位、来源实例和端口位置随其证据质量输出。覆盖范围用于视域和巡视初筛。

## 分段、上限与超限行为

球和圆柱的径向分段为 6/12/16，圆环的路径分段为 8/16/16。弯管保留真实管径。编译按顶点、轮廓、孔和曲线段数预算预检。L0/L1 对 Difference/Intersection 保留第一操作数，对 Union 组合轮廓；L2 按需执行 CSG。小件按完整放置后的外接尺寸过滤，整 DEV 全小时保留最大轮廓。

## 源码入口与验证边界

字段、编译和范围查询见 [Geometry SDK](../../packages/gim-sdk/src/geometry/geometry.ts)。[Desktop 适配](../../desktop/src/gim/geometry/xmlModDocument.ts) 负责来源路由，[Viewer](../../desktop/src/viewer/xmlModGeometry.ts) 负责渲染对象和组合求值。真实样本、合成不变量及尚待核证的标准分支分别验收。

## 逐项能力与证据

以下各项均有独立 Canonical 类型、Node 文本入口和合成网格用例。范围、端口和网格分别查询。最后一列记录匿名样本 substation01 的 MOD 声明数，含隐藏操作数。该样本有 14 类、46,250 条附录 B 声明，按源参数复用局部编译后均可生成三档网格。其余 15 类保留待样本状态。工程回归另外检查代表设备、间隔与放置。几何状态以具体分支的诊断为准。

| 条款 | 源标签 | 分支及复核边界 | 样本声明 |
|---|---|---|---:|
| B.1 | Sphere | 参数球面 | 141 |
| B.2 | RotationalEllipsoid | 完整非球椭球参数派生；截切与 LR=WR 表注分支保留图 B.2 的预览约定 | 待样本 |
| B.3 | Cuboid | 参数平面 | 12401 |
| B.4 | Table | 相似双菱形参数派生；非相似工程输入仅预览 | 109 |
| B.5 | OffsetRectangularTable | 偏移与双截面参数派生 | 15 |
| B.6 | Cylinder | 参数圆柱及端盖 | 20421 |
| B.7 | BendingCylindrical | 轴线和端点按图 B.7，斜接缝仅预览 | 待样本 |
| B.8 | TruncatedCone | 真半径；比例需显式来源规则 | 730 |
| B.9 | EccentricTruncatedCone | 顶心有符号偏移 | 待样本 |
| B.10 | Ring | 弧长、管径与端切向 | 235 |
| B.11 | RectangularRing | 圆角扫掠；W=2R 表注分支仅预览 | 1 |
| B.12 | EllipticRing | 椭圆路径及恒定管径 | 待样本 |
| B.13 | CircularGasket | 完整或部分实体垫片 | 80 |
| B.14 | TableGasket | 独立上下外半径、贯通孔 | 待样本 |
| B.15 | SquareGasket | CT 分支与内孔 | 待样本 |
| B.16 | StretchedBody | 平面轮廓与方向×长度 | 10263 |
| B.17 | AngleSteel | 显式 L 截面 | 待样本 |
| B.18 | I-shapedsteel | 显式 I 截面 | 待样本 |
| B.19 | ChannelSteel | 显式 C 截面；仅有型号时单列估算 | 129 |
| B.20 | T-Steels | 显式 T 截面 | 待样本 |
| B.21 | PorcelainBushing | 双族裙边尺寸和片数；中间轮廓仅预览 | 1506 |
| B.22 | ConePorcelainBushing | 双族顶底半径独立插值；细部仅预览 | 待样本 |
| B.23 | Insulator | 一／双联端口及重复节距；更多联数的布局待核证 | 待样本 |
| B.24 | VTypeInsulator | 双支端距、节距和对称布局；连接件、分裂挂点仅预览 | 待样本 |
| B.25 | TerminalBlock | XZ 倒角外廓及 Y 向贯通孔 | 201 |
| B.26 | RectangularFixedPlate | 奇偶阵列及 MH 中心孔 | 18 |
| B.27 | CircularFixedPlate | 圆形等分、孔径和 MH；L≠W 外廓待核证 | 待样本 |
| B.28 | Wire | 端点、切向、管径和 Sag 独立；曲线族待核证 | 待样本 |
| B.29 | CurveCable | 单直线可按参数生成；圆弧、样条或混合接头仅预览，无法确定的弧返回无网格 | 待样本 |

**待核证依据。** Q/GDW 11809—2023 附录 B，印刷页 34–35（图 B.2）、38（图 B.7）、41（图 B.11）、47–51（图 B.21–B.24）及 53–54（表 B.28、B.29，图 B.28）。这些图表约定的尺寸与接口可独立断言。裙片厚度、未示出的多联／分裂端布局、Sag 参考方向、弧选向和样条基函数保留上述状态，L2 也使用相同证据等级。

## 相关文档

- [变电 XML MOD](substation-mod.md)
- [几何模型](geometry-model.md)
- [DEV 几何运行时](../architecture/dev-geometry.md)
- [GIM 格式与样本复核](README.md)
- [样本台账](sample-corpus.md)
