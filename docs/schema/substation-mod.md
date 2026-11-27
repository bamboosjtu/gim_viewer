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

合成示例不含工程来源标识。SDK Raw Parser 识别工程拼写及 A.3.21 的大写节点与属性，保留原始拼写；宿主按明确的来源布局解释矩阵。标签、字段及兼容分支见 [XML primitive](xml-primitives.md)。

`<Device><Entities /></Device>` 是合法空内容；有 Entity 但全部 malformed 或 unsupported 不能记成 empty。缺少 `Entities` 时当前 parser 也返回空文档。

## Entity 字段

| 元素/字段 | 当前解析行为 |
|---|---|
| `Entity.ID` | 非负安全整数。ID 无效时保留诊断并跳过该 Entity。同 ID 的多条声明均排除，Boolean 引用保留未解析状态 |
| `Entity.Type` | 不作为 primitive 名称；非 simple 值诊断并按当前 simple IR 处理 |
| `Entity.Visible` | 缺失默认为 true；false 不进入可见几何 |
| `TransformMatrix.Value` | 16 项列主序仿射矩阵。缺失时使用单位阵，项数不符、数值无效或不可用于放置时回退单位阵并保留诊断 |
| `Color` | 可选；RGB 0–255，A 的刻度由文件级 `max(A)` 判定，见[几何模型](geometry-model.md#颜色) |
| primitive | 跳过 TransformMatrix/Color 后取首个子元素；未知标签保留 `Unsupported/sourceType/raw` |

标准数值字段完整匹配有限十进制数。缺失、冲突和非法输入保留 Raw 声明及诊断；宿主仅在已登记的提供方兼容入口采用相应浏览策略。Entity 变换在其父坐标系应用一次。

## primitive 处理

- 附录 B 的 29 类标准图元使用 SDK Canonical 参数，各自返回标准派生、估算、预览或无网格状态。
- Boolean 使用文档内来源引用。旧 Cable、BeamChannel/LightBeamChannel、H/H-beam、DoubleChannelSteel 及未识别节点保留独立宿主适配。未知标签和非法 Boolean 运算保留原字段并形成局部诊断。

字段、几何、LOD/近似和上限的完整表见 [XML primitive](xml-primitives.md)。这里只保留格式边界：解析成功不等于几何支持，几何存在也不等于字段被正确理解。

## Boolean 与实体引用

Boolean 的 `Type` 归一化后只接受 union/intersection/difference，其他操作 Unsupported。

`Entity1/Entity2` 通过本文件 Entity ID 引用，两者均须为可表示为非负安全整数的十进制数字串，允许首尾空白。操作数无效、缺失、成环或几何异常时，该 Boolean 无可用几何。每个求值节点包含自身 Entity 变换，中间节点和可见根各应用一次，再应用单位和外部装配变换；镜像同步翻转三角面绕序。隐藏操作数可参与求值。

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
- `ChannelSteel` 的显式截面和型号估算分别记录；`Table` 按两组顶底对角线放样。详见 [XML 图元与截面估算](xml-primitives.md)。
- 颜色/材质共享只影响显示，不推断设备类别、带电状态或工程归属。
- 几何与颜色契约见[几何模型](geometry-model.md)，运行与缓存见[DEV 几何](../architecture/dev-geometry.md)。

## 相关文档

- [XML primitive](xml-primitives.md)
- [几何模型](geometry-model.md)
- [DEV 几何运行时](../architecture/dev-geometry.md)
- [语义模型](semantic-model.md)
- [GIM 格式与样本复核](README.md)
