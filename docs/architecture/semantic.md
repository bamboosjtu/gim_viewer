# Semantic Core 拆分

Semantic 负责把来源事实解释成可验证的实体、边界与成员关系。目标不是把大文件按行数切开，而是让每个算法阶段有明确输入、输出和可回放的证据。

## 目录

```text
semantic/
├── normalization/
│   ├── prepareEvidence.ts   # composition 归一化、环校验、parents/meaning
│   ├── transformerBank.ts   # 单相主变成组
│   ├── contextualRecognition.ts # 设备/屏柜上下文中的成员解释
│   ├── membershipRecoveryState.ts # 归属恢复索引与成员写入
│   └── ownershipResolver.ts # 有序归属和成员判断
├── recognition/
│   ├── standardClassResolver.ts # 标准目录类别候选
│   ├── componentResolver.ts # 组件/标准优先级
│   ├── materialResolver.ts  # 材料宿主与成员判定
│   ├── recognitionPolicy.ts # 上下文规则与模型优先词
│   ├── neutralAssemblyResolver.ts # 中性点成套类型证据
│   ├── sourceFormatFacts.ts # 原始声明和来源证据契约
│   ├── sourceTypeDecision.ts # 别名、目录匹配、类型特征和细分类线索
│   ├── sourceTypePolicy.ts # 类型文字和型号的领域解释
│   ├── objectEvidenceCandidates.ts # SemanticDecisionInput 与上下文候选
│   ├── objectVocabularyEvidence.ts # 词典匹配与歧义证据
│   └── objectEvidenceDecision.ts # 解释候选并组装对象证据
├── catalog/
├── classify.ts              # 角色/类别/用途解释
├── recoverMembership.ts     # 宿主声明补充
├── normalize.ts             # 阶段编排
└── semantic.ts              # 公共出口

adapters/
├── evidenceReader.ts        # 格式字段读取，不改变原属性
├── sourceEvidenceReader.ts  # 对象、组成、身份及宿主证据组装
├── recognizeSource.ts       # 对外适配入口及识别版本转发
└── sourceTypeDeclarations.ts # 类型、型号和物理父级的声明提取
```

## 已完成阶段

### prepareEvidence

输入原始 `ObjectEvidence[]`，输出不可变的：

- 去重/排序后的 `ordered`；
- `sourceId -> row`；
- composition 歧义和缺失父级；
- 已校验无环的 `assemblyParentId`；
- `parents` 和每行的 `interpretObject` 结果。

后续阶段共享这些 Map/Set，不重复遍历 composition 边。

### transformerBank

在归属遍历前识别单相 E01 主变本体。证据冲突时保留 `whole_identity_conflict` 诊断并进入 pending，不猜测主变成组。

### ownershipResolver

先递归确定已知父级，应用 `contextualRecognition` 中的设备或屏柜解释，再按优先级尝试策略。类别冲突和组成缺口优先保留诊断，灯具端子、已确认装配、中性点、部件兼容性、来源细节、未分类候选及独立整体依序决定归属。选定的结果在后续子件读取父级之前提交。

### membershipRecoveryState

归属恢复只构造一次宿主和子件索引；同次归属转移集中更新 owner、状态、依据与后代。它不生成宿主匹配规则，也不改来源父级。

### 来源适配与识别契约

`evidenceReader` 为当前对象建立一次字段索引并保留原始证据地址。Adapter 输出 `SourceFormatFacts`，其中包含原始类型和型号声明、身份与角色声明、宿主、组成及字段读取完整性。中性点成套的输入包含原始类型和实际物理父级。

Semantic 掌管别名、标准目录匹配、隐含角色与用途、类型特征和细分类裁决，并从格式事实生成 `SemanticDecisionInput`。普通对象、设备内成员和屏柜内成员共享一次类型解释。中性点成套和最终归属继续由 Semantic 判定。

分层检查拒绝 Semantic 导入原始来源记录，也拒绝 Adapter 调用目录和内部裁决模块。Adapter 通过对象识别、中性点成套和模型归一化入口接线。

### 本轮行为收口

- 独立边界与分类冲突分开：显式独立对象保留 `U-OBJECT` 实体，角色本身冲突仍进入待归。
- 物理父级与语义组成冲突时保留两侧证据，主归属进入 `composition_host_conflict`；有/无 Adapter 宿主提示结果一致。
- 中性点成套只接受两个直接且可确认的类型证据，显示名不能升级置信状态；暖开识别决策版本变化会自动重算实体与导航。
- Semantic 将声明和候选裁决、词典证据、候选解释及对象证据组装分成独立阶段。
- `adapters/objectEvidence.ts` 传递来源边和读取完整性。Semantic 负责分类、成套证据、宿主和归属裁决。

## 约束

- 不先冻结当前错误识别结果再拆模块；每次拆分用现有 83 个 recognition parity 用例和语义测试验证。
- 拆分不重复读取 CBM/DEV/FAM；来源文档缓存仍由 Source 层持有。
- 等价的设备声明与真实装配放在 CBM F2、F3、F4 时，设备类别、整体边界和部件归属一致。来源路径和 occurrence ID 各自保留。
- Engineering 只消费 Semantic 快照做融合，Projection 不修正底层语义。
- 解析语法归 Parser；Semantic 不直接读文件、不调用 DOM/Worker。

来源图通过 `sourceReferenceResolver` 保留引用候选和歧义证据，通过 `sourceFamilyIndex` 管理 FAM 归属。`SourceDocumentReader` 共用在途读取和结果。来源顺序和每路径读取次数由 Source 测试约束。
