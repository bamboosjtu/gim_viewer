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

| 项 | Wire | Cable |
|---|---|---|
| 点来源 | FitCoordArray | StartCoord + InflectionCoordArray + EndCoord |
| 解析 | 分号点序列，非法 token 跳过 | 单点解析失败返回空数组，拼合后过滤非有限值 |
| 几何 | CatmullRom 样条 + TubeGeometry，半径 max(D/2, 1e-6) | 同 Wire |
| 管段 | clamp(点数/3, 8, 256)，径向 6，不闭合 | 同 Wire |
| 失败 | 有效点少于 2 个 → null | 同 Wire |

loader 另叠一条 1px 中心线：每 Entity 一条 Line，超过 1000 条时按颜色合并为 LineSegments。它只保证低档位可见，不参与拾取、量测或电气连接判断；管径始终取源 D，不用放大管径换可见性。实现见 [xmlModLoader](../../desktop/src/viewer/xmlModLoader.ts)。

## 弱 schema 与 Unsupported

标准字段不足、引用歧义、几何退化、容量超限分别保留诊断。合法空交集与未能编译的可见根在文档和缓存中分别计数。Model-only 型钢和未核证的构造细节在 SDK 结果中有估算或预览标记。

## 近似类型与明确忽略的字段

B.7 的接缝、B.11 的表注边界及未给出型材系列的公称截面不能用作精确设计依据。参数单位、来源实例和端口位置随其证据质量输出。覆盖范围用于视域和巡视初筛。

## 分段、上限与超限行为

球和圆柱的径向分段为 6/12/16，圆环的路径分段为 8/16/16。弯管保留真实管径。编译按顶点、轮廓、孔和曲线段数预算预检。L0/L1 对 Difference/Intersection 保留第一操作数，对 Union 组合轮廓；L2 按需执行 CSG。小件按完整放置后的外接尺寸过滤，整 DEV 全小时保留最大轮廓。

## 源码入口与验证边界

字段、编译和范围查询见 [Geometry SDK](../../packages/gim-sdk/src/geometry/geometry.ts)。[Desktop 适配](../../desktop/src/gim/geometry/xmlModDocument.ts) 负责来源路由，[Viewer](../../desktop/src/viewer/xmlModGeometry.ts) 负责渲染对象和组合求值。真实样本、合成不变量及尚待核证的标准分支分别验收。

## 相关文档

- [变电 XML MOD](substation-mod.md)
- [几何模型](geometry-model.md)
- [DEV 几何运行时](../architecture/dev-geometry.md)
- [GIM 格式与样本复核](README.md)
- [样本台账](sample-corpus.md)
