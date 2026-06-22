# MOD 文件格式

## 文件概述

MOD（Model/Module）文件是 GIM 工程中描述基础几何模型的数据文件，采用 XML 格式。MOD 文件定义了由基本几何图元（长方体、圆柱体、瓷套管、拉伸体）组成的模型，每个图元拥有独立的空间变换和颜色属性。MOD 是三维可视化层级中最底层的几何定义文件。

## 文件格式

- **编码**：UTF-8
- **格式**：XML
- **根元素**：`<Device>`
- **坐标单位**：毫米（mm）

## 字段说明

### XML 结构

| 元素 | 层级 | 说明 |
|------|------|------|
| `<Device>` | 根元素 | 模型根节点 |
| `<Entities>` | Device 子元素 | 图元集合容器 |
| `<Entity>` | Entities 子元素 | 单个几何图元定义 |

### Entity 属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `ID` | 整数 | 图元唯一标识 |
| `Type` | 字符串 | 图元类型，目前为 `simple` |
| `Visible` | `True` / `False` | 是否可见 |

### 几何图元类型

每个 `<Entity>` 内必须包含且仅包含以下一种几何图元：

| 图元 | 元素名 | 参数 | 说明 |
|------|--------|------|------|
| 长方体 | `<Cuboid>` | `L`（长）、`W`（宽）、`H`（高） | 标准长方体 |
| 圆柱体 | `<Cylinder>` | `R`（半径）、`H`（高度） | 标准圆柱体 |
| 瓷套管 | `<PorcelainBushing>` | `R`（底部半径）、`R1`（中部半径）、`R2`（顶部半径）、`N`（伞裙数）、`H`（高度） | 绝缘子/瓷套管，带伞裙结构 |
| 拉伸体 | `<StretchedBody>` | `Array`（截面顶点坐标，分号分隔）、`Normal`（拉伸法向量）、`L`（拉伸长度） | 沿法向量拉伸截面形成的体 |

### Entity 子元素

| 元素 | 必需 | 说明 |
|------|------|------|
| 几何图元（四选一） | 是 | 定义图元形状 |
| `<TransformMatrix>` | 是 | 空间变换矩阵，`Value` 属性为 16 个浮点数（逗号分隔，行优先） |
| `<Color>` | 是 | 颜色定义，`R`/`G`/`B` 范围 0-255，`A` 范围 0-100（透明度百分比） |

## 引用关系

```
PHM 文件
└── SOLIDMODEL → <uuid>.mod    → MOD 文件
    └── <Device>
        └── <Entities>
            ├── <Entity ID="0">
            │   ├── <Cuboid /> / <Cylinder /> / <PorcelainBushing /> / <StretchedBody />
            │   ├── <TransformMatrix />
            │   └── <Color />
            ├── <Entity ID="1">
            │   └── ...
            └── ...
```

## 示例

### 长方体模型

```xml
<?xml version="1.0" encoding="utf-8"?>
<Device>
  <Entities>
    <Entity ID="0" Type="simple" Visible="True">
      <Cuboid L="800" W="600" H="2000" />
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
      <Color R="128" G="128" B="128" A="100" />
    </Entity>
  </Entities>
</Device>
```

### 圆柱体模型

```xml
<?xml version="1.0" encoding="utf-8"?>
<Device>
  <Entities>
    <Entity ID="0" Type="simple" Visible="True">
      <Cylinder R="50" H="300" />
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
      <Color R="200" G="50" B="50" A="100" />
    </Entity>
  </Entities>
</Device>
```

### 瓷套管（绝缘子）模型

```xml
<?xml version="1.0" encoding="utf-8"?>
<Device>
  <Entities>
    <Entity ID="0" Type="simple" Visible="True">
      <PorcelainBushing R="30" R1="45" R2="25" N="8" H="500" />
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
      <Color R="180" G="180" B="220" A="100" />
    </Entity>
  </Entities>
</Device>
```

### 拉伸体模型

```xml
<?xml version="1.0" encoding="utf-8"?>
<Device>
  <Entities>
    <Entity ID="0" Type="simple" Visible="True">
      <StretchedBody Array="0,0;100,0;100,50;0,50" Normal="0,0,1" L="200" />
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
      <Color R="100" G="150" B="200" A="100" />
    </Entity>
  </Entities>
</Device>
```

### 多图元组合模型

```xml
<?xml version="1.0" encoding="utf-8"?>
<Device>
  <Entities>
    <Entity ID="0" Type="simple" Visible="True">
      <Cuboid L="800" W="600" H="50" />
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
      <Color R="128" G="128" B="128" A="100" />
    </Entity>
    <Entity ID="1" Type="simple" Visible="True">
      <Cylinder R="25" H="300" />
      <TransformMatrix Value="1,0,0,200,0,1,0,200,0,0,1,25,0,0,0,1" />
      <Color R="200" G="50" B="50" A="100" />
    </Entity>
    <Entity ID="2" Type="simple" Visible="False">
      <Cuboid L="100" W="100" H="100" />
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
      <Color R="0" G="0" B="0" A="0" />
    </Entity>
  </Entities>
</Device>
```
