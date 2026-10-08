# DEV、PHM 与几何实例

物理主链通常为 CBM→DEV→PHM→MOD/STL，PHM 可以继续指向 PHM，
DEV 可包含子 DEV。文件清单、几何可达性、模板和场景实例必须分别统计。

## DEV 结构

| 字段 | 含义/当前处理 |
|---|---|
| TYPE / DEVICETYPE | 设备类型原字段 |
| SYMBOLNAME 等 | 来源名称，不代替身份 |
| BASEFAMILY / BASEFAMILYPOINTER | FAM 来源，按实际引用解析 |
| SOLIDMODELS.NUM / SOLIDMODELn | 自有固体模板引用 |
| SUBDEVICES.NUM / SUBDEVICEn | 子 DEV 引用 |
| TRANSFORMMATRIXn | 对应块、对应索引的局部变换 |

DEV 是有序块文本。固体块和子设备块都可能出现 `TRANSFORMMATRIX0`，
简单全文件 Map 会覆盖块内信息。当前 parser 先读标量，再按源顺序识别 solid/sub 块，
保留稀疏下标，不把缺失引用后的矩阵移到前一个目标。
空目标/哨兵不生成有效引用，声明数量受资源上限约束。

合成结构：

```text
SOLIDMODELS.NUM=1
SOLIDMODEL0=assembly.phm
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
SUBDEVICES.NUM=1
SUBDEVICE0=child.dev
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,1000,0,0,1
```

两条矩阵分别属于 solid:0 和 sub:0。DEV 名称、PHM 名称和 MOD 名称不要求一致。

## PHM 结构

| 字段 | 含义 |
|---|---|
| SOLIDMODELS.NUM | 源清单声明数量 |
| SOLIDMODELn | MOD、STL、PHM 等目标 |
| TRANSFORMMATRIXn | 当前引用边的局部矩阵 |
| COLORn | 可选 R,G,B,A 覆盖 |

解析实际扩展名，不预设所有目标都是 MOD。递归时累积父矩阵与子矩阵，
防环只针对当前分支，重复模板在不同路径的出现合法。
没有自有 SOLIDMODEL 的节点仍可能有子设备或被其他路径装配，不能直接推定整个子树为空。

原始源的引用可达性与软件支持度分别记录：缺文件、循环截断、不支持图元、真正空内容和编译失败。

## 模板与 occurrence

模板键为规范化 DEV 路径，资源可共享；occurrence 键由源工程、物理 CBM 根及装配引用路径组成。
两次相同 DEV 的出现可以具有不同矩阵、颜色与语义归属。
不能用“去重 DEV 文件”删除 occurrence，也不能让 PARTINDEX 再生成一套几何。

身份 alias 只在所属根的物理子树查候选。候选不唯一保留 ambiguity，
不能全局搜索并拿第一个同 UUID 对象替代。对应当前契约见 [语义模型](semantic-model.md)。

## 矩阵约定

当前 Matrix4 数组按列主序解释，点为列向量：`p_parent = M_edge × p_child`。

```text
array = [m00,m10,m20,m30, m01,m11,m21,m31,
         m02,m12,m22,m32, m03,m13,m23,m33]
translation = array[12], array[13], array[14]
```

累计顺序为 `M_parent × M_child`，不是调换顺序。
例如父变换沿 X 平移 10，子变换 X 缩放 2，局部点 X=1，结果 X=12。
完整链为 CBM、DEV/子 DEV、PHM 逐边累计，再乘 Entity 局部矩阵。
缺失或格式不合要求的矩阵按各 parser 的单位阵回退，并不能作为源矩阵本来正确的证据。

不能只提取平移；旋转、非等比缩放、镜像、剪切和非单位阵都影响结果。
不能用 `Object3D.applyMatrix4` 的分解/重组替代所有原始仿射语义。

## 单位和轴转换

当前 MOD/STL 加载将原始毫米顶点转为米。Entity 局部矩阵在原 MOD 空间应用，
然后进行顶点单位转换。外部 placement 的平移分量乘 0.001，
其旋转/缩放线性部分不重复乘 0.001。

等价表示：`p_project_m = S × M_assembly_mm × M_entity_mm × p_mm`，
其中 `S=Scale(0.001)`；若顶点已转米，外部矩阵应使用 `S × M_assembly_mm × S^-1`。

项目 source→viewer 独立应用：GIM Z-up 先绕 X 轴 -90° 转为 Y-up，
再乘 IFC baseCoordinationMatrix。当前组合为 `baseCoordinationMatrix × ZUpToYUp`。
首 IFC 决定锚点，因此冷/暖 IFC 顺序一致是坐标正确性的必要条件。
不能再次旋转已经处于 viewer 坐标的 IFC，也不能重复缩放缓存 GLB。

共享模板 placement 不修改共享 geometry；局部 raw fallback 的顶点烘焙有独立所有权。
源单位与轴转换的具体实现见
[xmlModLoader](../../desktop/src/viewer/xmlModLoader.ts)、
[坐标对齐](../../desktop/src/services/coordinateAlignmentService.ts)。

## 颜色

XML Color 与 PHM COLOR 使用四通道。RGB 为 0–255。
A 在当前样本中有百分制和字节制；当前渲染按文件内 max(A)>100 选择 /255，否则 /100。
A≤0 作为不透明哨兵，不能直接套用常规 alpha=0 透明含义。

PHM 颜色覆盖应作用于当前 occurrence 所有资源，不能修改共享模板材质影响别的实例。
缺少或非法 Color 使用当前缺省策略，不能宣称源颜色已恢复。
刻度规则是当前消费约定，不能仅凭导出厂商固定选择 A 的范围。

## STL

支持二进制与 ASCII 两类。二进制常见结构为 80 字节头、4 字节 little-endian 三角数，
随后每三角 50 字节：normal、三个顶点和属性字节。长度校验为 `84 + 50 × N`。
ASCII 常以 `solid` 和 `facet/vertex` 记录组成；二进制头也可能含 solid，不能仅按开头文字判断。

PHM 可引用 MOD、STL 或混合。没有证据表明它们固定构成某种 LOD、互斥备用或固定设备类别。
二进制/ASCII 转换和单位逻辑见 [stlLoader](../../desktop/src/viewer/stlLoader.ts)。

## GL 辅助来源

同 UUID `.gl` 可与 DEV 形成 sidecar，包含 ConnectGuid、Direction、ConnectionRules、
GimGeCableConcentration 等来源。存在辅助文件不代表它自动参与 SOLIDMODEL 主链。
它的连接/空间字段与主几何事实分别保留，不能由相似 UUID 猜测主装配关系。

## 实现与验证边界

[devParser](../../desktop/src/gim/geometry/devParser.ts)、
[phmParser](../../desktop/src/gim/geometry/phmParser.ts)、
[sourceGraph](../../desktop/src/gim/geometry/substationSourceGraph.ts)
负责原始结构与来源关系；运行时和缓存消费见 [架构](../architecture.md)。
矩阵、alias 和嵌套数量只在 [台账](sample-corpus.md) 维护。
