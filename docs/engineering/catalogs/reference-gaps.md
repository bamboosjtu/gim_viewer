# 目录识别规则

先读取当前对象的结构化类型、角色和关联 FAM 属性。有可识别的中文分类声明时优先采用中文，再用英文声明补足。显示名称可以提供候选类别，实际装配与明确宿主声明负责确定归属。目录中用 `/` 合写的词汇可以分别查找，共用同一条目身份。

| 场景 | 处理方式 |
|---|---|
| `TerminalBox` | 属于设备时为本体端子箱部件。独立端子箱归材料 |
| `GroundResistance` | 作为独立设备时归接地电阻成套装置。材料声明、有效中文消歧或设备内实际装配可将其解释为接地电阻材料，成员仍随设备计入组成 |
| 均压屏蔽装置 | 只有通用中文词时默认归金具。明确英文类型可定位两个原目录项 |
| `ProtectionEquipment` | 默认保护设备。当前对象明确声明为线路保护装置或变压器保护装置时采用相应部件类型 |
| 中性点成套设备 | 有明确独立角色时按设备识别。附件可按实际装配或唯一且兼容的明确宿主归入主变，宿主未确认时保留待归 |
| 消弧线圈与接地变压器成套装置 | 英文分别为 `ArcExtinguishingCoil` 和 `GroundTransformer` |
| 电容器组 | 框架式、并联的名称和完整来源值 `AssembledCapacitorBank;SeriesCapacitorSet` 对应同一目录项。保留完整来源值，实例按来源身份计数。集合式和串补成套装置各有独立目录项 |
| 油浸式变压器与绝缘子串 | `OilFilledTransformer` 和 `ChainInsulation` 分别作为来源别名，规范英文保留 `OilImmersedTransformer`、`InsulatorsSring` |
| `ScreenCabinetsAndInstallations` | 对象自身的屏柜名称提供柜体证据时可解释为二次屏柜。明确部件角色优先 |
| `LED` | 灯具类别由对象自身证据决定。带有 LED 声明的端子板可沿实际 DEV 装配归入灯具，保留候选成员状态 |

六类屏柜的英文名称为 `ControlCabinet`、`ControlPanel`、`MeasurementAndControlCabinet`、`ProtectionPanel`、`ProtectionCabinet` 和 `RelayProtectionCabinet`。具有明确变压器保护装置且没有线路保护装置冲突的二次屏柜，可细分为主变压器保护柜。物理归属、独立角色和冲突处理见[实体与来源模型](../entities.md)。
