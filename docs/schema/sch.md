# SCH 文件格式

## 文件概述

> **2026-08-24 十样本复核**：三件套仅 JinQu/SDDP 工具产出（2/4 变电样本），加载逻辑必须容忍缺失。
>
> **2026-08-24 P1-6：SDDP 三件套格式对比**（变电站04 vs 变电站01）：
> - `.sch` 入口结构一致（`SCH.NUM=2` + SCH0/SCH1 指向 .std/.sld），但文件名为中文内部工程名。
> - **`.std` 与 `.sld` 内容为同一份 SVG 文档**（字节数完全一致，根元素 `<svg>`、`version="NBT1"`），
>    即 SDDP 把逻辑定义与主接线图合并为单文档；JinQu 则是分离的
>    `.std`（`<STD version="DLT1">` XML）+ `.sld`（SVG DLT1）。
> - **兼容性风险**：现有 stdParser 以 `<STD>` 为根元素，对 SDDP 产物会直接解析失败；
>    需按根元素/版本号（DLT1 vs NBT1）分发不同解析分支，或对 NBT1 统一走 SVG 路径。
> - 两工具的 gridId 体系与图元结构差异需后续专项对比（当前仅确认容器层）。

SCH（Schematic）文件是 GIM 工程中的逻辑模型索引文件，采用键值对文本格式。SCH 文件作为工程逻辑模型的入口，引用了逻辑模型定义文件（STD）和接线图文件（SLD），建立了工程逻辑结构与电气接线图之间的关联。

> **2026-07-17 实现状态**：并非“仅完成格式说明”。`src/gim/schParser.ts` 已实现 SCH 入口发现和条目解析，`src/services/stdSldService.ts` 已接入首次打开与缓存恢复流程；对应测试 13 项通过。当前仅 `demo-substation` 含 1 份 SCH，两个线路样本均为 0，是否为所有线路工程的固定规则仍需新样本验证。

## 文件格式

- **编码**：UTF-8
- **行分隔符**：换行符
- **键值分隔符**：`=`
- **列表索引**：从 0 开始

## 字段说明

| 字段 | 格式 | 说明 |
|------|------|------|
| `SCH.NUM` | `<N>` | 逻辑模型文件数量 |
| `SCH0` ~ `SCHN` | `<filename.std>` 或 `<filename.sld>` | 引用逻辑模型文件 |

引用的文件类型：
- **`.std` 文件**：变电站逻辑模板定义文件，定义电压等级、间隔、设备等逻辑结构
- **`.sld` 文件**：单线接线图文件，SVG 格式的电气接线图

## 引用关系

```
project.cbm
└── SCH=project.sch    → SCH 文件
    ├── SCH0=main.std  → STD 逻辑模型定义
    │   └── Substation
    │       └── VoltageLevel
    │           └── Bay
    │               └── ConductingEquipment
    └── SCH1=main.sld  → SLD 单线接线图
        └── SVG 电气图（通过 gridId 关联 STD 中的设备）
```

SCH 文件中引用的 STD 和 SLD 文件通过 `gridId` 属性建立关联：STD 中定义的逻辑设备拥有 `gridId`，SLD 中的图形元素通过相同的 `gridId` 引用对应的逻辑设备。

## 示例

### project.sch

```
SCH.NUM=3
SCH0=main.std
SCH1=main.sld
SCH2=auxiliary.sld
```

### 仅包含 STD 的 SCH 文件

```
SCH.NUM=1
SCH0=substation_layout.std
```

### 多个逻辑模型

```
SCH.NUM=4
SCH0=10kV.std
SCH1=10kV.sld
SCH2=35kV.std
SCH3=35kV.sld
```
