# STD 文件格式

## 文件概述

STD（Substation Template Definition）文件是 GIM 工程中定义变电站逻辑结构的 XML 文件。STD 文件描述了变电站的层级逻辑模型，包括电压等级、间隔（Bay）、导电设备（ConductingEquipment）及其参数和子设备。STD 文件是电气逻辑模型的核心，通过 `gridId` 属性与 SLD 接线图建立可视化关联。

> **2026-07-17 实现状态**：`src/gim/stdParser.ts` 已解析 Substation/VoltageLevel/Bay/Group/ConductingEquipment 并构建 `gridId` 索引；`stdSldIndex.ts` 已实现 STD/SLD/CBM 三向关联，相关 parser/index 测试已覆盖。当前只有 `demo-substation` 提供 1 份 STD，两个线路样本均为 0，因此“仅变电存在”是当前样本事实，不是已证明的格式强约束。

## 文件格式

- **编码**：UTF-8
- **格式**：XML
- **根元素**：`<STD>`
- **版本属性**：`version="DLT1"`，`revision="2023"`

## 字段说明

### XML 层级结构

| 元素 | 层级 | 说明 |
|------|------|------|
| `<STD>` | 根元素 | 变电站模板定义根节点 |
| `<Substation>` | STD 子元素 | 变电站定义 |
| `<Private>` | Substation 子元素 | 私有扩展数据 |
| `<VoltageLevel>` | Substation 子元素 | 电压等级 |
| `<Voltage>` | VoltageLevel 子元素 | 电压值定义 |
| `<Group>` | VoltageLevel 子元素 | 设备组 |
| `<Bay>` | VoltageLevel 子元素 | 间隔 |
| `<ConductingEquipment>` | Bay 子元素 | 导电设备 |
| `<Parameter>` | ConductingEquipment 子元素 | 设备参数 |
| `<SubEquipment>` | ConductingEquipment 子元素 | 子设备 |

### 元素属性说明

#### `<STD>`

| 属性 | 说明 |
|------|------|
| `version` | 版本标识，如 `DLT1` |
| `revision` | 修订版本，如 `2023` |

#### `<Substation>`

| 属性 | 说明 |
|------|------|
| `name` | 变电站名称 |
| `desc` | 变电站描述 |

#### `<Private>`

| 属性 | 说明 |
|------|------|
| `type` | 私有数据类型，如 `CIME-dtype`（数据类型）、`CIME-area`（区域） |
| `name` | 名称 |
| `desc` | 描述 |

#### `<VoltageLevel>`

| 属性 | 说明 |
|------|------|
| `name` | 电压等级代码 |
| `desc` | 电压等级描述 |

#### `<Voltage>`

| 属性 | 格式 | 说明 |
|------|------|------|
| `multiplier` | `k` 等 | 电压单位乘数，`k` 表示千 |
| `unit` | `V` | 电压单位 |

元素内容为电压数值，如 `10` 表示 10kV。

#### `<Group>`

| 属性 | 说明 |
|------|------|
| `name` | 组名称 |
| `desc` | 组描述 |
| `gridId` | 关联逻辑模型的 gridId |
| `type` | 类型，如 `multiequipment`（多设备组） |
| `guidtemp` | GUID 模板标识 |

#### `<Bay>`

| 属性 | 说明 |
|------|------|
| `name` | 间隔名称 |
| `desc` | 间隔描述 |
| `gridId` | 关联逻辑模型的 gridId |
| `guidtemp` | GUID 模板标识 |

#### `<ConductingEquipment>`

| 属性 | 说明 |
|------|------|
| `name` | 设备名称 |
| `desc` | 设备描述 |
| `gridId` | 关联逻辑模型的 gridId |
| `groupGridId` | 所属设备组的 gridId |
| `type` | 设备类型（见枚举表） |
| `virtual` | 是否为虚拟设备，`true` / `false` |
| `guidtemp` | GUID 模板标识 |

#### `<Parameter>`

| 属性 | 说明 |
|------|------|
| `name` | 参数名称 |
| `desc` | 参数描述 |
| `dimension` | 参数量纲 |

元素内容为参数值。

#### `<SubEquipment>`

| 属性 | 说明 |
|------|------|
| `name` | 子设备名称 |
| `desc` | 子设备描述 |
| `type` | 子设备类型 |
| `phase` | 相位标识（可为空） |
| `guidtemp` | GUID 模板标识 |

### ConductingEquipment type 枚举

| 类型代码 | 说明 |
|----------|------|
| `SAR` | 避雷器 / 电涌保护器 |
| `DIS` | 隔离开关 |
| `VTR` | 电压互感器 |
| `CTR` | 电流互感器 |
| `PTR` | 变压器 |
| `EVPIS` | 高压带电显示器 |
| `OTHER` | 其他设备 |

## 背景与对比

`.std`（Substation Template Definition）文件属于中国国网 GIM 体系下的自定义 XML 格式，描述变电站逻辑拓扑，不是国际通用标准格式。

### 实证信息（基于 demo-substation）

| 属性        | 值                                                            |
| ----------- | ------------------------------------------------------------- |
| 文件名      | `zjx.std`                                                     |
| 实际格式    | XML                                                           |
| 大小        | 5 KB                                                          |
| 内容        | 变电站逻辑拓扑描述                                            |
| 顶层概念    | 电压等级（220kV）、间隔（Bay）、导电设备（断路器/隔离开关/互感器等） |
| 版本属性    | `version="DLT1"`、`revision="2023"`                           |
| 关联字段    | `gridId`（与 SLD 文件中的图形元素一一对应）                   |

### 国际对比

- **专属格式**：GIM 体系内自定义的 XML 格式，描述变电站逻辑拓扑
- **国际对标**：
  - **IEC 61850-6 SCL**（Substation Configuration Language，含 SSD 系统规范描述）
  - **CIM/CGMES**（IEC 61970/61968）
- **不属于 IEC 标准体系**

| 层面       | 中国（GIM 体系）   | 国际                          |
| ---------- | ------------------ | ----------------------------- |
| 逻辑拓扑   | `.std` (STD XML)   | IEC 61850 SCL (`.ssd`/`.scd`) |

`.std` 在国内国网工程中是**事实上的交付标准**，在国网体系内属于主流格式；但在国际电力行业，该扩展名并不通用。

## 引用关系

```
SCH 文件
└── SCH<i>=<filename>.std    → STD 文件
    └── <STD>
        └── <Substation>
            ├── <Private>
            └── <VoltageLevel>
                ├── <Voltage>
                ├── <Group gridId="<id>">
                └── <Bay gridId="<id>">     ← 通过 gridId 关联 SLD 中的 <g>
                    └── <ConductingEquipment gridId="<id>">
                        ├── <Parameter>
                        └── <SubEquipment>
```

STD 与 SLD 的关联：STD 中 `Bay` 和 `ConductingEquipment` 的 `gridId` 与 SLD 中对应图形元素的 `gridId` 一一对应。

## 示例

```xml
<?xml version="1.0"?>
<STD version="DLT1" revision="2023">
  <Substation name="某变电站" desc="110kV变电站">
    <Private type="CIME-dtype" name="" desc="" />
    <Private type="CIME-area" name="" desc="" />

    <VoltageLevel name="10kV" desc="10kV电压等级">
      <Voltage multiplier="k" unit="V">10</Voltage>

      <Group name="10kVI段母线" desc="10kV I段母线设备组"
             gridId="grid-group-001" type="multiequipment"
             guidtemp="aaaa-bbbb-cccc" />

      <Bay name="10kV线路1" desc="10kV线路1间隔"
           gridId="grid-bay-001" guidtemp="dddd-eeee-ffff">
        <ConductingEquipment name="断路器1" desc="真空断路器"
          gridId="grid-dev-cb01" groupGridId="grid-group-001"
          type="DIS" virtual="false" guidtemp="1111-2222-3333">
          <Parameter name="ratedVoltage" desc="额定电压" dimension="kV">10</Parameter>
          <Parameter name="ratedCurrent" desc="额定电流" dimension="A">630</Parameter>
          <SubEquipment name="A相" desc="A相触头" type="phase" phase="A" guidtemp="4444-5555-6666" />
          <SubEquipment name="B相" desc="B相触头" type="phase" phase="B" guidtemp="7777-8888-9999" />
          <SubEquipment name="C相" desc="C相触头" type="phase" phase="C" guidtemp="aaaa-bbbb-cccc" />
        </ConductingEquipment>

        <ConductingEquipment name="避雷器1" desc="氧化锌避雷器"
          gridId="grid-dev-ar01" groupGridId="grid-group-001"
          type="SAR" virtual="false" guidtemp="dddd-eeee-1111">
          <Parameter name="ratedVoltage" desc="额定电压" dimension="kV">12</Parameter>
        </ConductingEquipment>
      </Bay>
    </VoltageLevel>

    <VoltageLevel name="110kV" desc="110kV电压等级">
      <Voltage multiplier="k" unit="V">110</Voltage>

      <Bay name="主变压器" desc="主变压器间隔"
           gridId="grid-bay-002" guidtemp="ffff-0000-1111">
        <ConductingEquipment name="主变压器" desc="三相双绕组变压器"
          gridId="grid-dev-tr01" type="PTR" virtual="false"
          guidtemp="2222-3333-4444">
          <Parameter name="ratedCapacity" desc="额定容量" dimension="MVA">50</Parameter>
          <Parameter name="ratedVoltageHV" desc="高压侧额定电压" dimension="kV">110</Parameter>
          <Parameter name="ratedVoltageLV" desc="低压侧额定电压" dimension="kV">10.5</Parameter>
        </ConductingEquipment>
      </Bay>
    </VoltageLevel>
  </Substation>
</STD>
```
