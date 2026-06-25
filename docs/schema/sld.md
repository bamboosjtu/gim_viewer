# SLD 文件格式

## 文件概述

SLD（Single Line Diagram）文件是 GIM 工程中的单线接线图文件，基于标准 SVG 1.1 格式并扩展了自定义属性。SLD 文件描述了变电站的电气主接线方案，通过自定义 CSS 样式类、`gridId` 属性和 `<symbol>` 定义，实现了电气元件的可视化表示以及与逻辑模型（STD）的关联。

## 文件格式

- **格式**：SVG 1.1
- **编码**：UTF-8
- **命名空间**：标准 SVG 命名空间 + 自定义属性

## 字段说明

### 自定义 CSS 样式类

SLD 文件使用自定义 CSS 类来组织图形元素的显示层级：

| CSS 类名 | 说明 |
|-----------|------|
| `主接线元件层` | 主接线电气元件（断路器、隔离开关等） |
| `主接线连接线层` | 主接线连接导线 |
| `主接线标注层` | 主接线文字标注 |
| `主接线母线层` | 主接线母线 |

### 自定义属性

| 属性 | 适用元素 | 说明 |
|------|----------|------|
| `gridId` | `<g>`, `<use>` 等 | 关联逻辑模型（STD）中的设备标识，是 SLD 与 STD 的关键关联字段 |
| `type` | `<g>` | 元素类型，如 `Bay`（间隔）、`Drawing`（图纸）等 |
| `name` | `<g>` | 元素名称 |
| `schedulecode` | `<g>` 等 | 调度编码 |

### SVG 结构元素

| 元素 | 说明 |
|------|------|
| `<symbol>` | 定义电气元件符号（断路器、隔离开关、接地开关、变压器等），每个 symbol 有唯一 UUID 作为 id |
| `<g>` | 组织层级结构，特别是间隔（Bay）层级 |
| `<use>` | 引用 symbol 实例，通过 `transform` 属性定位和旋转 |
| `<line>` | 绘制连接线 |
| `<circle>` | 绘制圆形元件 |
| `<rect>` | 绘制矩形元件 |
| `<text>` | 添加标注文字 |

## 引用关系

```
SCH 文件
└── SCH<i>=<filename>.sld    → SLD 文件
    └── SVG
        ├── <symbol id="<UUID>">     → 电气元件符号定义
        │   └── <line>, <circle> 等  → 符号图形
        ├── <g gridId="<id>" type="Bay">  → 间隔分组
        │   ├── <use href="#<UUID>">      → 引用 symbol 实例
        │   └── <line>, <text> 等        → 连接线和标注
        └── 通过 gridId 关联 → STD 文件中的 ConductingEquipment
```

SLD 与 STD 的关联机制：
1. STD 文件中 `ConductingEquipment` 和 `Bay` 拥有 `gridId` 属性
2. SLD 文件中对应的 `<g>` 和 `<use>` 元素通过相同的 `gridId` 值引用
3. 两者通过 `gridId` 建立一一对应关系

## 示例

```xml
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <style>
    .主接线元件层 { stroke: #000; fill: none; stroke-width: 2; }
    .主接线连接线层 { stroke: #000; fill: none; stroke-width: 1.5; }
    .主接线标注层 { font-size: 12px; fill: #000; }
    .主接线母线层 { stroke: #000; fill: none; stroke-width: 4; }
  </style>

  <defs>
    <!-- 断路器符号 -->
    <symbol id="a1b2c3d4-e5f6-7890-abcd-ef1234567890" viewBox="0 0 40 40">
      <line x1="20" y1="0" x2="20" y2="12" />
      <line x1="20" y1="28" x2="20" y2="40" />
      <line x1="12" y1="12" x2="28" y2="28" />
    </symbol>

    <!-- 隔离开关符号 -->
    <symbol id="b2c3d4e5-f6a7-8901-bcde-f12345678901" viewBox="0 0 40 40">
      <line x1="20" y1="0" x2="20" y2="12" />
      <line x1="20" y1="28" x2="20" y2="40" />
      <line x1="10" y1="20" x2="30" y2="20" />
      <circle cx="20" cy="12" r="2" />
      <circle cx="20" cy="28" r="2" />
    </symbol>
  </defs>

  <!-- 母线 -->
  <line class="主接线母线层" x1="100" y1="100" x2="900" y2="100" />

  <!-- 间隔 -->
  <g gridId="grid-bay-001" type="Bay" name="10kV线路1">
    <!-- 断路器 -->
    <use href="#a1b2c3d4-e5f6-7890-abcd-ef1234567890"
         gridId="grid-dev-cb01" x="200" y="100"
         transform="translate(200,100)" />
    <!-- 隔离开关 -->
    <use href="#b2c3d4e5-f6a7-8901-bcde-f12345678901"
         gridId="grid-dev-ds01" x="200" y="160"
         transform="translate(200,160)" />
    <!-- 连接线 -->
    <line class="主接线连接线层" x1="200" y1="120" x2="200" y2="160" />
    <!-- 标注 -->
    <text class="主接线标注层" x="220" y="140">QF1</text>
  </g>
</svg>
```
