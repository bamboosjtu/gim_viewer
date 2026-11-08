# 变电 XML MOD

变电 MOD 的主要内容为 Device XML，包含 Entity、局部矩阵、颜色和 primitive。本文件说明文件 grammar、Entity 字段、Boolean/状态边界；具体 primitive 的字段、别名、几何和 LOD 见 [XML primitive](xml-primitives.md)。

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

合成示例不含工程来源标识。`Device`/`Entities`/`Entity`/`TransformMatrix`/`Color` 标签大小写敏感；primitive 标签在 parser 内做小写归一，别名见 [XML primitive](xml-primitives.md#标签归一与导出器别名)。

`<Device><Entities /></Device>` 是合法空内容；有 Entity 但全部 malformed 或 unsupported 不能记成 empty。缺少 `Entities` 时当前 parser 也返回空文档。

## Entity 字段

| 元素/字段 | 当前解析行为 |
|---|---|
| `Entity.ID` | 整数 ID；不可解析则该 Entity 不进入实体集合 |
| `Entity.Type` | 不作为 primitive 名称；非 simple 值诊断并按当前 simple IR 处理 |
| `Entity.Visible` | 缺失默认为 true；false 不进入可见几何 |
| `TransformMatrix.Value` | 16 项列主序；缺失、长度不符或含 NaN 时回退单位阵 |
| `Color` | 可选；RGB 0–255，A 的刻度由文件级 `max(A)` 判定，见[几何模型](geometry-model.md#颜色) |
| primitive | 跳过 TransformMatrix/Color 后取首个子元素；未知标签保留 `Unsupported/sourceType/raw` |

当前数值读取通常使用 `parseFloat`，缺字段可能为 NaN，不是隐式合法零值。矩阵有限性、单位与轴转换不能由 XML 合法推定；Entity 变换只在其父坐标系应用一次。

## primitive 处理

- 强类型：Cuboid、Cylinder、Sphere、TruncatedCone、Ring、CircularGasket、StretchedBody、PorcelainBushing、TerminalBlock、ChannelSteel、Table、Boolean、Wire、Cable、RotationalEllipsoid、BeamChannelLike。
- 弱 schema：RectangularFixedPlate、OffsetRectangularTable、RectangularRing；字段不可解释时可能用浏览近似或返回 null，不能当作精确源形状。
- 导出器别名：`Rectangularfixedplate`、`H-beam`、`DoubleChannelSteel`、`Insulator/VTypeInsulator`、`ConePorcelainBushing`、`EccentricTruncatedCone`、`SquareGasket/TableGasket`、`EllipticRing`、`BendingCylindrical`、`CircularFixedPlate` 等，统一映射到既有分支。
- 未知标签、非法 Boolean Type：`Unsupported`，保留来源类型和 raw；局部降级，不把文件记成 empty。

字段、几何、LOD/近似和上限的完整表见 [XML primitive](xml-primitives.md)。这里只保留格式边界：解析成功不等于几何支持，几何存在也不等于字段被正确理解。

## Boolean 与实体引用

Boolean 的 `Type` 归一化后只接受 union/intersection/difference，其他操作 Unsupported。

`Entity1/Entity2` 通过本文件 Entity ID 引用；操作数缺失、环与异常几何不能得到伪造结果。每个求值节点包含自身 Entity 变换，中间节点和可见根各应用一次，再应用单位和外部装配变换；镜像同步翻转三角面绕序。隐藏操作数可参与求值。

L0/L1 不执行 CSG：

- Union 组合操作数轮廓；
- Difference/Intersection 递归保留第一操作数，孔洞/交集按轮廓近似；
- 诊断记录 `representationPolicy`、`approximatedBooleans` 和 `simplifiedBooleans`；正常的轮廓简化不作为 partial。

L2 使用递归精确 CSG；失败后的轮廓回退仍报告 partial。可见根诊断记录依赖 ID 与缺失、环、不支持或 CSG 异常；合法空交集是空结果。

## 状态与计数

`XmlModDocument` 保留：

- `declaredEntityCount`：XML 声明的 Entity 数；
- `malformedEntityCount`：缺 ID/primitive 等未进入实体集合的数量；
- `entities`：可解析实体；
- `isEmpty`：`<Entities />` 或无 Entity；
- `colorMaxA`：文件级透明度刻度判定。

运行时另行统计实际可见几何、unsupported 类型和失败原因；合并后的 mesh 数不等于源 Entity 数。

| 状态 | 含义 |
|---|---|
| 完整/可渲染 | 至少一个可见根生成表示，未覆盖来源另计 |
| `partial` | 有可渲染部分，同时有缺失依赖/CSG 回退/未支持图元 |
| `empty` | 源内容没有自有可渲染几何（合法空） |
| `unsupported` | 源存在但当前能力不支持；不能算 empty |
| `source-invalid` / parse failed | 源或解析异常；保留原因，不发布完整几何 |

空文件、解析异常、有内容但不支持、部分可渲染和完整可渲染不能混成一个布尔值。

## 边界

- XML 是设计/导出表达，不是施工安装真值；不能据浏览几何反推尺寸、间隙或电气参数。
- `ChannelSteel`、`Table` 当前生成外廓盒体；早期“无直接几何”的描述已失效，以 [XML primitive](xml-primitives.md) 与源码为准。
- 颜色/材质共享只影响显示，不推断设备类别、带电状态或工程归属。
- 几何与颜色契约见[几何模型](geometry-model.md)，运行与缓存见[DEV 几何](../architecture/dev-geometry.md)。

## 相关文档

- [XML primitive](xml-primitives.md)
- [几何模型](geometry-model.md)
- [DEV 几何运行时](../architecture/dev-geometry.md)
- [语义模型](semantic-model.md)
- [GIM 格式与样本复核](README.md)
