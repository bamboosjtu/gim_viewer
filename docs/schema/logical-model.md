# SCH、STD 与 SLD

逻辑模型是可选能力。SCH 索引逻辑文件，STD 可表达电气结构，也可具有 SVG 内容；SLD 表达单线图。缺失或局部解析异常不能阻断可用语义与三维模型。

## SCH 入口

```text
SCH.NUM=2
SCH0=main.std
SCH1=main.sld
```

CBM 根的 SCH 指向入口，SCHn 按实际条目引用 STD/SLD。
文件名和目录不固定，使用全局 resolver；计数与有效引用分别检查。
大小写、空条目和缺文件应保留诊断，不能要求每包都有固定三件套。

## STD 内容分型

| 实际 root | 内容 | 当前行为 |
|---|---|---|
| STD | 电气逻辑 XML | 解析层级和非空 gridId 索引 |
| svg | 图纸内容 | 返回无 Substation 的空逻辑结构，不虚构电气层级 |
| 非法 XML/其他 root | 不符合当前结构 | 按 parser 错误/空结果边界反馈 |

扩展名 `.std` 不证明 root 为 STD；分型依据实际内容，不按厂商分支。
台账保存各包实际能力。SVG STD 与 SLD 是否同内容是文件事实，不能据此假定全标准都合并两者。

### STD 电气层级

```xml
<STD version="DLT1">
  <Substation name="站A">
    <VoltageLevel name="电压级A">
      <Bay name="间隔A" gridId="bay-a">
        <Group name="组A">
          <ConductingEquipment name="设备A" gridId="equipment-a">
            <SubEquipment name="部件A" />
            <Parameter name="参数A" value="值A" />
          </ConductingEquipment>
        </Group>
      </Bay>
    </VoltageLevel>
  </Substation>
</STD>
```

此例只说明层级，不声称每种节点都必有或必在该位置。
当前 parser 读取 Substation、VoltageLevel、Bay、Group、ConductingEquipment、SubEquipment 和 Parameter，保留节点原属性。version/revision、name、gridId、type、schedulecode 等属于来源信息。
gridId 为空时不进入有效索引，重复和无法对应的 ID 不能解释为确定一一关系。
实际遍历与索引见 [stdParser](../../desktop/src/gim/stdParser.ts)。

## SLD SVG

SLD 为 SVG 图形加行业扩展属性。
常见结构包括 symbol、g、use、line、circle、rect、text；id 用于符号/本地引用，gridId 用于逻辑设备候选关联，二者不能混用。

| 字段/结构 | 含义 |
|---|---|
| gridId | 逻辑对象/图形关联线索 |
| type / name / schedulecode | 原对象类型、名称、调度来源 |
| symbol.id | 符号定义身份 |
| use.href / xlink:href | 本地符号引用 |
| transform / viewBox | SVG 坐标和布局 |
| 图层 CSS class | 源图纸组织，不能直接变成业务类型 |

展示前白名单净化，使用 img 沙箱；脚本、事件、foreignObject、外部资源和危险样式不能执行。
关联数据独立抽取，用当前选择流程控制图纸/树/三维联动，不将不可信 SVG 作为可执行 UI。
实际保留元素和属性以 [sldParser](../../desktop/src/gim/sldParser.ts) 为准。

## 关联边界

STD gridId、SLD gridId、CBM 字段和 IFCGUID 是独立身份域。
只有经来源索引确认的映射才能联动；图纸元素没有三维关联时仍可保留图纸事实。
一个设备可对应多个图形，非空 ID 也不能自动证明一一映射。
SVG STD 不提供传统 STD 层级，应显示能力边界，不能按扩展名补造对象。

[schParser](../../desktop/src/gim/schParser.ts)、[stdSldIndex](../../desktop/src/gim/stdSldIndex.ts) 负责格式与关联，打开、恢复、安全和当前产品入口分别见 [架构](../architecture.md) 和 [规格](../software-spec.md)。
