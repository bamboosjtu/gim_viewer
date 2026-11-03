# 设备目录

设备以施工、运维识别的整体为粒度，兼容 2018/2025 通用目录。设计拆出的本体、相单元和内部件保留为该整体的来源，不默认成为独立工程实体。

- `E*` 是项目映射码，不是国网标准编码；表中 2018/2025 条目只作溯源，不写入实体类别。
- 名称证据取自 [catalogRules.json](../../../desktop/src/engineering/catalogRules.json) 的 `nameRules`：按数组顺序首个命中，名称先去空白、大小写不敏感；本文用 `、` 分隔关键词，代码中以 `|` 交替。
- `E-T` 是用途待确认的项目补充粗类，两版目录均无此条目；`U-OBJECT` 是待识别状态，不是目录类别。

## 目录表

| 编码 | 类别 | 2018 / 2025 兼容口径 | 目标整体粒度 | 当前名称/类型证据 | 边界 |
|---|---|---|---|---|---|
| E01 | 主变压器 | 2018 `01 变压器`；2025 `1 主变压器` | 一台/组工程主变，含已确认的中性点组成与各相本体 | 名称 `主变压器、主变本体`；`中性点…成套/装置/设备`；`E-T` 名称含“主变”；`E01/E-T` 类型 + 显式主变编号 | 单相本体按同一 `#n主变` 且相数“单相”组成一台（`transformer_bank`）；散热器、油枕、升高座、分接开关为内部来源；基础 C-B2、端子箱 E16.terminal_box 另建 |
| E02 | 高压并联电抗器 | 2018 `02`；2025 `2` | 一台/套 | 名称 `高压并联电抗器`；DEV `highvoltageshuntreactor`、`oilimmersionreactor` | 裸“电抗器”按 E11；散热器为组件，不另立实体 |
| E03 | 站用变压器 | 2018 无独立条目（旧变压器按用途映射）；2025 `3` | 一台站用变 | 名称 `站用变` | 用途不明留 `E-T`，不得一律判 E01 |
| E04 | 消弧线圈、小电阻及接地变成套装置 | 2018 `14 消弧线圈及接地成套`；2025 `4`，下设四种成套形式 | 一套装置，保留形式与组件 | 名称 `消弧线圈、接地变、小电阻、接地电阻`；DEV `groundtransformer/arcextinguishingcoil`、`completesetofarcsuppressioncoilandgroundingtransformer` | 具体形式作为子类保留；泛称“接地变”不能证明多份来源是一套 |
| E05 | 组合电器 | 2018 `03 气体绝缘金属封闭开关设备`；2025 `5 组合电器` | 一套明确装配的组合设备 | 名称 `HGIS、GIS、组合电器`；DEV `gis`、`hgis`、`combinationapparatushgis`、`combinationapparatugis` | 内部断路器、隔离开关、母线并作整体来源；不按 F3 间隔定套数；独立安装的断路器仍 E06 |
| E06 | 断路器 | 2018 `04`；2025 `6` | 一台/组独立设备 | 名称 `断路器`；DEV `circuitbreaker`、`porcelainpillarcircuitbreaker` | 父级为已识别整体（如 E05、E09）时并入该整体；父级缺失或为 `U-OBJECT` 时另建 |
| E07 | 隔离开关 | 2018 `05` 中的隔离开关；2025 `7` | 一台/组独立设备 | 名称 `隔离开关`；DEV `disconnectingswitch`、`disconnector`、`acisolatingswitch` | 集成在成套设备内不重复列整机 |
| E08 | 接地开关 | 2018 `05` 中的接地开关；2025 `8` | 一台/组独立设备 | 名称 `接地开关`；DEV `groundingswitch`、`earthingswitch`、`acgroundswitch` | 不按单相几何零件机械计台数 |
| E09 | 开关柜 | 2018 `12`；2025 `9` | 一面/台柜 | 名称 `开关柜、出线柜、进线柜、馈线柜、母线设备柜`；DEV `hvswitchcabinet`、`switchcabinet` | 柜内断路器、母排、端子排为组成；“母线设备柜”先命中 E09，不落 M02 |
| E10 | 并联电容器成套装置 | 2018 `08 并联电容器`；2025 `11` | 一套有明确组成的装置 | 名称 `电容器组、并联电容器、电容器成套、框架式电容器`；DEV `framecapacitor`、`framecapacitorbank` | 单个电容器保留为组件/待定；跨平级归一套需工程标识 + 带编号名称 + 兼容签名 |
| E11 | 低压并联电抗器 | 2018 `09`；2025 `12` | 一台/套明确设备 | 名称 `低压并联电抗器、电抗器`；DEV `lowvoltageshuntreactor`、`dryreactor`、`drytypereactor` | “高压并联电抗器”先命中 E02；裸“电抗器”落 E11 |
| E12 | 静止无功发生器 | 2018 无独立条目；2025 `13` | 一套装置 | 名称 `SVG、静止无功` | 柜/模块是否独立按目录角色与证据，名称不拆套数 |
| E13 | 电流互感器 | 2018 `06`；2025 `14` | 一个明确设备单元 | 名称 `电流互感器`；DEV `currenttransformer`、`electromagneticcurrenttransformer` | 相别、单相/三相组合另存，不按单相件计台数 |
| E14 | 电压互感器 | 2018 `07`；2025 `15` | 一个明确设备单元 | 名称 `电压互感器`；DEV `voltagetransformer`、`potentialtransformer`、`capacitivetv` | 同上；名称尾号不改变整机数，也不按尾号拆分 |
| E15 | 避雷器 | 2018 `10`；2025 `16` | 一个明确设备单元 | 名称 `避雷器`；DEV `surgearrestor`、`surgearrester`、`arrester`、`lightningarrester`、`lightningprotector` | 中性点装置内避雷器并作主变来源，不另算整机；独立“避雷针”归 C-D5 |
| E16 | 二次设备 | 2018 `15`；2025 无独立条目 | 独立屏柜、端子箱、控制柜、保护设备、蓄电池组等 | 名称 `屏柜、二次屏、机柜、通信柜、通讯柜、蓄电池、控制柜、端子箱`；DEV `secondarycabinet`、`screencabinetsandinstallations` | 子类见表；名称前缀“主变、HGIS、监控”不改变独立功能；不再把屏柜/蓄电池并入基础 E16 |
| E17 | 动力辅助设备 | 2018 `16`；2025 无独立条目 | 一个屏/箱/终端设备 | 名称 `检修箱、照明箱、配电箱、接地箱、低压配电屏、电缆终端`；DEV `powerbox/lightingbox/maintenancebox` | 电缆终端在此；电缆本体 M05、电缆沟 C-C1 |
| E18 | 预制舱开关设备 | 2018 无独立条目；2025 `10` | 一套交付装置，舱体与内部柜各自保留角色 | 名称 `预制舱` | 舱内 E09 独立关联（`associated_with`）；舱级与柜级汇总分别标口径，不相加 |
| E19 | 水工暖通设备 | 2018 `17`；2025 无独立条目 | 一台独立设备 | 名称 `风机、水泵、空调、消防栓、灭火器、除湿机、闸阀`；IFC `IFCFAN、IFCPUMP、IFCVALVE` | 管段、管件、末端归 C-D4；不把全部附属对象显示成“辅助设施” |
| E-T | 变压器（用途待确认） | 两版均无独立条目（项目补充粗类） | 保留到用途确认 | 名称 `变压器`；DEV 类型 `E01` 在无主变证据时降为 `E-T` | 不得计入 E01 台数；显式主变编号或名称含“主变”才升 E01 |

“目标整体粒度”是识别目标，不保证每个来源都另建独立实体：父级已识别且对象不是独立头词时，默认作为该整体的成员；只有父级缺失/`U-OBJECT`、独立头词或 C-B1/C-B2、E09-in-E18 等例外才另建整体。具体见本文末“成套设备边界”。

## E16 子类

| 编码 | 类别 | 兼容口径 | 目标整体粒度 | 名称/类型证据 | 边界 |
|---|---|---|---|---|---|
| E16.terminal_box | 端子箱 | 2018 `15`；2025 无独立条目 | 一个端子箱 | 名称 `端子箱`；DEV `terminalbox`；命中 `independent` 表 | 嵌在主变/中性点 DEV 内作为主变来源；独立设置才建整体 |
| E16.panel_cabinet | 屏柜 | 2018 `15`；2025 无独立条目 | 一面屏柜 | 名称 `屏柜、二次屏、机柜、通信柜、通讯柜、馈线屏、电源屏、电源柜`；命中 `independent` 表 | 屏柜是独立整体；不带“保护/控制”限定词时落此子类，不并入基础 E16 |
| E16.control_cabinet | 控制柜 | 2018 `15`；2025 无独立条目 | 一面控制柜 | 名称 `汇控柜、控制柜、监控系统柜、智能辅助.*柜`；命中 `independent` 表 | “HGIS 智能控制柜”按当前对象头词判控制柜，不因 HGIS 前缀归 E05 |
| E16.battery_set | 蓄电池组 | 2018 `15`；2025 无独立条目 | 一组蓄电池 | 名称 `蓄电池组、蓄电池、电池组`；命中 `independent` 表 | 一组蓄电池为一个整体；不按单节电池或屏柜内空间继续拆分 |
| E16.protection | 保护设备 | 2018 `15`；2025 无独立条目 | 一个保护屏柜；保护装置按证据决定是否独立 | 名称 `保护装置、保护屏、保护.*柜、录波柜` | 按当前对象头词判保护类；“保护屏/保护柜”在独立头词表内，可另建整体；“保护装置”只判类别，父级存在时默认作为宿主成员，不强行另立台套 |

## 主变、中性点、端子箱

| 来源对象 | 目录角色 | 是否独立实体 | 当前规则路径 |
|---|---|---|---|
| 主变本体 | E01 主体来源 | 否 | 归属 E01 整体；相数、本体标识留在来源与参数 |
| 多个单相本体 | E01 组成 | 否（组成一台） | 同一显式主变编号 + 相数“单相”且成员 ≥2，建 `transformer_bank`，记录 `phaseBodyCount` 与 `phase_completeness_unverified` |
| 中性点成套装置 | E01 组成 | 否 | 父级为 E01 时并入；宿主不明进待归集合；随后按唯一显式主变编号重定向 |
| 端子箱 | E16.terminal_box | **是** | 嵌入主变/中性点 DEV 则为主变组成来源；其他独立端子箱保留整体 |
| 散热器、油枕、升高座、分接开关、电动机构 | E01 内部来源 | 否 | 命中 `part`，随宿主，不生成普通工程树节点 |
| 主变基础、支架 | C-B2、C-B1 | **是** | 父级为 E 类时按 `independent_installation_object` 关联，不并入主变几何 |

- 显式主变编号取自“工程中名称”字段，多个取值必须归一到同一编号；编号不取设备名称、型号或电压等级。
- 只交付本体时以其代表主变整体，不制造空的内部实体；本体数与相别完整性另存，不把本体数当主变组数。
- 中性点归属优先用明确装配或工程标识；共同 F3、邻近位置、相同型号只生成候选，不能确定宿主。
- “中性点套管”只是普通组件或材料名称，不因“中性点”关键词判成中性点成套装置。
- 中性点装置内避雷器并作主变来源，不另计 E15；装置内端子箱随中性点装置归主变整体。

## 成套设备边界

- **GIS/HGIS（E05）**：只有明确成套或工程身份才形成一套；内部断路器、隔离开关只保留功能与来源，不另建默认实体。另行安装的断路器仍是 E06，不能把整间隔仅按名称合成一套。
- **开关柜与预制舱（E09、E18）**：设备包含关系与独立设备身份并存；舱内各面柜保留 E09 实体并与舱关联。舱级与柜级汇总分别标口径，不相加成“设备总台数”。
- **并联电容器（E10）**：单个电容器为组件或待定单元；跨平级来源归一套要求同一工程标识、带编号工程名称与兼容成套签名，否则聚为待归集合。
- **消弧线圈、接地变（E04）**：2025 的小电阻装置是明确补充，不能沿用旧类别名称漏掉；具体形式作为子类保留。
- **三相设备**：主变整体可含多个相本体；没有明确工程编号和成组证据时不按“三份”机械合并。
- **独立安装件**：C-B1、C-B2 位于任何 E 类整体下仍独立关联；E09 位于 E18 下同理；其余子对象默认属于父整体，不在工程树中重复出现。

## 来源类型映射

DEV `source_type` 与 IFC 类型只是类型证据：名称命中时名称优先（材料类型属性除外），类型仅在名称未识别时兜底。

| 类型别名目标 | DEV `source_type`（小写匹配） | 说明 |
|---|---|---|
| `E-T` | `oilimmersedtransformer`、`oilfilledtransformer`、`drytypetransformer` | 原始别名指向 E01，进入分类前降为 `E-T`，类型本身不能证明主变 |
| E02 | `highvoltageshuntreactor`、`oilimmersionreactor` | 与 E11 同名“电抗器”时由名称决定 |
| E04 | `groundtransformer/arcextinguishingcoil`、`completesetofarcsuppressioncoilandgroundingtransformer` | 成套形式仍由名称或来源成员表达 |
| E05 | `gis`、`hgis`、`combinationapparatushgis`、`combinationapparatugis` | 类型不证明整套边界 |
| E06、E07、E08 | `circuitbreaker`、`porcelainpillarcircuitbreaker`；`disconnectingswitch`、`disconnector`、`acisolatingswitch`；`groundingswitch`、`earthingswitch`、`acgroundswitch` | 组内别名并列，仅作类型证据 |
| E09 | `hvswitchcabinet`、`switchcabinet` | 与 E18 的舱内柜关系由装配与关联决定 |
| E10、E11 | `framecapacitor`、`framecapacitorbank`；`lowvoltageshuntreactor`、`dryreactor`、`drytypereactor` | 单台与成套由名称和成员证据区分 |
| E13、E14、E15 | `currenttransformer`、`electromagneticcurrenttransformer`；`voltagetransformer`、`potentialtransformer`、`capacitivetv`；`surgearrestor`、`surgearrester`、`arrester`、`lightningarrester`、`lightningprotector` | 类型不表达相别与安装位置 |
| E16 及子类 | `secondarycabinet`、`screencabinetsandinstallations`；`terminalbox` | 类型只作 E16 证据；端子箱/屏柜/控制柜/蓄电池组由名称与独立头词细分 |
| E17 | `powerbox/lightingbox/maintenancebox` | 一个别名覆盖配电箱、照明箱、检修箱 |
| C-B1、C-C4、C-D1 | `equipmentsupportandfoundation`、`metalfence`、`lampsandlanterns` | 非设备专用别名，按构件/设施处理，见[构件目录](components.md) |

`neutralpointequipment` 类型映射为 `neutral_set` 标记，不是类别编码，最终归入 E01 宿主。IFC 侧本目录只覆盖 `IFCFAN`、`IFCPUMP`、`IFCVALVE`（E19）；`IFCFASTENER`、`IFCMECHANICALFASTENER` 只产生紧固件标记，不产生目录实体。

## 保留待识别

- 名称含 `GIS` 的对象按大小写不敏感子串命中 E05；厂房、间隔等非设备名称需按对象角色复核，当前规则不做词边界判断。
- 名称只有“主变”而没有“变压器/主变本体”时不命中 E01；来源为 `E-T` 时名称含“主变”或有显式主变编号才升级。
- 名称未覆盖的二次设备（如 UPS、通信电源模块）落 `U-OBJECT`，不强行归入 E16。
- 类型别名与名称冲突时按名称建实体并记录 `conflict`（如类型 M02、名称含“支架”）。
