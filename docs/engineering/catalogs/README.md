# 实体目录

运行时配置的维护源是独立 JSON；[实体索引工作簿](变电三维设计建模规范_实体索引表.xlsx) 只作参考资料。构建、检查、运行和独立工具打包不读取工作簿，也不以当前工作簿 SHA 决定配置有效性。JSON 中的单元格和摘要是所记录的参考版本的来源证据。

- `packages/gim-sdk/src/engineering/standardCatalog.json`：模型条目、目录身份、精确词条及参考来源。
- `catalog.json`：稳定的公开目录和部件条目；内部角色到目录的映射由 `recognitionPolicy.json` 维护。
- `recognitionPolicy.json`：GIM Viewer 内部识别角色及 grain 策略，不是标准原文。
- `compositionPolicy.json`：所有设备的部件宿主能力、独立安装和单相主变组策略。
- `packages/gim-sdk/src/engineering/sourceCompatibilityPolicy.json`：DEV/IFC 及结构化字段的适配枚举；标准精确词条优先，冲突保留观察记录。
- `packages/gim-sdk/src/engineering/sourceVocabulary.json`：模型与部件两个独立词汇命名空间，由上述 JSON 同步。

维护 JSON 后在 `desktop/` 执行 `npm run sync:engineering-catalog`；再运行 `npm run check:engineering-catalog` 和 `npm run test:recognition`。同步命令不读取 XLSX，独立工具持有自己的配置副本；运行和打包均不读取主程序。

公开 `category` 是目录编号，`standardClass.id` 是模型条目身份，`recognitionCode` 是私有用途/归属角色。三者不能混用。grain 是内部工程实体粒度，不表示已经由工作簿条款证明。

模型和部件仍使用独立词汇空间。TerminalBox 在设备内为本体端子箱部件，独立时为材料；GroundResistance 独立作为设备时为接地电阻成套装置，非设备整体语境下为接地电阻材料。中文分类字段优先英文；名称仅在缺少属性时兜底，或消解已有类型的歧义。

所有设备都可以有部件。实际装配、显式宿主与对象角色决定成员关系；未知宿主不视作设备，明确独立角色继续保留整体。均压屏蔽装置默认金具，ProtectionEquipment 默认保护设备；默认规则由领域策略维护，不隐藏原目录中的多个来源。

中文名和英文名中的 `/` 表示多个目录词汇，合写与拆行的查找含义一致。当前目录为 141 个模型条目、46 行部件；运行时不读取工作簿。六类屏柜词汇和其他已确认解释见[目录解释](reference-gaps.md)。

完整条目见[目录参考索引](catalog-index.md)。[设备](equipment.md)、[材料](materials.md)、[构件](components.md)分别描述各自范围。

当前中英文解释、默认规则和人工验收范围见[目录解释与验收边界](reference-gaps.md)。
