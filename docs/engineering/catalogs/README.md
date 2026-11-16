# 实体目录

运行时配置的维护源是独立 JSON；[实体索引工作簿](变电三维设计建模规范_实体索引表.xlsx) 只作参考资料。构建、检查、运行和独立工具打包不读取工作簿，也不以当前工作簿 SHA 决定配置有效性。JSON 中的单元格和摘要是所记录的参考版本的来源证据。

- `desktop/src/engineering/standardCatalog.json`：模型条目、目录身份、精确词条及参考来源。
- `catalog.json`：稳定的公开目录和部件条目；内部角色到目录的映射由 `recognitionPolicy.json` 维护。
- `recognitionPolicy.json`：GIM Viewer 内部识别角色及 grain 策略，不是标准原文。
- `compositionPolicy.json`：部件宿主角色、独立安装和单相主变组策略；宿主值为 null 表示未配置。
- `gim/engineering/sourceCompatibilityPolicy.json`：DEV/IFC 及结构化字段的适配枚举；标准精确词条优先，冲突保留观察记录。
- `gim/engineering/sourceVocabulary.json`：模型与部件两个独立词汇命名空间，由上述 JSON 同步。

维护 JSON 后在 `desktop/` 执行 `npm run sync:engineering-catalog`；再运行 `npm run check:engineering-catalog` 和 `npm run test:recognition`。同步命令不读取 XLSX，独立工具持有自己的配置副本；运行和打包均不读取主程序。

公开 `category` 是目录编号，`standardClass.id` 是模型条目身份，`recognitionCode` 是私有用途/归属角色。三者不能混用。grain 是内部工程实体粒度，不表示已经由工作簿条款证明。

模型词汇不携带部件身份，部件词汇不携带模型目录身份。TerminalBox、GroundResistance 等同名词在无角色和字段语境时保持 unresolved；明确独立角色或模型类型字段选择模型语义，明确部件角色、部件字段或宿主声明选择部件语义。真实装配边本身不能消除词义碰撞。

部件表按部件名称、英文名称两个语义字段解释；当前参考表另有序号列，不推定固定列位置或宿主列。宿主兼容性由 CompositionPolicy 独立配置，区分 compatible、incompatible、unconfigured。名称候选不能证明归属，未知兼容性不能视作通过。

参考资料待完善建议：为跨目录同名词补充字段语境说明；为散热器、储油柜、中性点套管、保护装置等补充可审核的宿主条款；逐项审核未配置部件的宿主范围。两个“均压屏蔽装置”保留两个模型条目及各自单元格，不能标为唯一映射。修改资料前先审核，不通过扩展表列或自动重生成来推定新契约。

完整条目见[目录参考索引](catalog-index.md)。[设备](equipment.md)、[材料](materials.md)、[构件](components.md)分别描述各自范围。

当前工作簿的列位置、拆行、疑似中英文对调和缺英文名等问题见[参考资料未决项](reference-gaps.md)。
