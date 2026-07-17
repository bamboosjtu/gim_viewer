# SLD 文件格式

## 文件概述

SLD（Single Line Diagram）文件是 GIM 工程中的单线接线图文件，基于标准 SVG 1.1 格式并扩展了自定义属性。SLD 文件描述了变电站的电气主接线方案，通过自定义 CSS 样式类、`gridId` 属性和 `<symbol>` 定义，实现了电气元件的可视化表示以及与逻辑模型（STD）的关联。

> **2026-07-17 实现状态**：`src/gim/sldParser.ts`、`src/ui/sldView.ts` 和 `stdSldService.ts` 已实现解析、视图展示、gridId 双向联动及缓存恢复，并有 parser/index/cache 测试。当前只有 `demo-substation` 提供 1 份 SLD，两个线路样本均为 0。注意：现有 SVG/CSS 清洗仍不足以安全处理不可信 SLD，这是评审报告中的独立 P0 问题，不能因“已实现解析”而视为已解决。

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

## 背景与对比

`.sld` 文件属于中国国网 GIM 体系下的自定义格式，不是国际通用标准格式。

### 实证信息（基于 demo-substation）

| 属性        | 值                                                            |
| ----------- | ------------------------------------------------------------- |
| 文件名      | `zjx.sld`                                                     |
| 实际格式    | SVG 1.1（XML）                                                |
| 大小        | 53 KB                                                         |
| 内容        | 变电站主接线图（可视化图形）                                  |
| CSS 图层    | "主接线元件层"、"主接线母线层" 等                             |
| 版本标识    | `version="DLT1"`（DLT 电力行业推荐性标准）                    |
| 生成工具    | `soft="GRevitTools"`（北京博超 Revit 二次开发工具 STD-R）     |

### 国际对比

- **格式本身**：标准 SVG 1.1，这是国际主流的主接线图呈现格式（Powsybl、JointJS 等工具也是输出 SVG）
- **扩展名**：`.sld` 是 GIM 体系的自定义命名约定。国际上，单线图一般直接使用 `.svg` 扩展名
- **不属于 IEC 标准体系**

| 层面       | 中国（GIM 体系）         | 国际                          |
| ---------- | ------------------------ | ----------------------------- |
| 接线图呈现 | `.sld` (SVG, DLT 扩展)   | SVG / CIM/CGMES + Powsybl     |

`.sld` 在国内国网工程中是**事实上的交付标准**，在国网体系内属于主流格式；但在国际电力行业，该扩展名并不通用。

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
