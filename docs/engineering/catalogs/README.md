# 实体目录

当前目录包括 60 条设备、42 条材料、40 条构件及 46 行设备部件。SDK 从独立 JSON 加载目录和策略，实体盘点器随包携带配置副本。[实体索引工作簿](变电三维设计建模规范_实体索引表.xlsx)用于人工对照。目录记录中的工作表、单元格和 SHA 指向各条目所用的参考版本。

| 配置 | 内容 |
|---|---|
| [standardCatalog.json](../../../packages/gim-sdk/src/engineering/standardCatalog.json) | 模型条目、名称、别名及来源位置 |
| [catalog.json](../../../packages/gim-sdk/src/engineering/catalog.json) | 公开目录类别及部件条目 |
| [recognitionPolicy.json](../../../packages/gim-sdk/src/engineering/recognitionPolicy.json) | 内部识别角色、粒度和同名词的解释规则 |
| [sourceCompatibilityPolicy.json](../../../packages/gim-sdk/src/engineering/sourceCompatibilityPolicy.json) | 格式类型、枚举和有条件的来源映射 |
| [compositionPolicy.json](../../../packages/gim-sdk/src/engineering/compositionPolicy.json) | 整体边界、宿主和功能细分策略 |

公开的 `category` 表示目录类别，`standardClass.id` 标识具体模型条目，内部 `recognitionCode` 用于语义判断。模型与设备部件分别检索词汇，成员归属按实际组成与对象角色决定。

维护上述 JSON 后，在 `desktop/` 运行 `npm run sync:engineering-catalog`，再运行 `npm run check:engineering-catalog` 和 `npm run test:recognition`。同步生成词汇、内容指纹、独立工具配置副本和目录索引。整个流程以 JSON 为输入。

完整条目见[目录参考索引](catalog-index.md)，同名词、条件映射和别名见[识别规则](reference-gaps.md)。
