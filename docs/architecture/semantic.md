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
│   └── recognitionPolicy.ts # 上下文规则与模型优先词
├── catalog/
├── classify.ts              # 角色/类别/用途解释
├── recoverMembership.ts     # 宿主声明补充
├── normalize.ts             # 阶段编排
└── semantic.ts              # 公共出口

adapters/
├── evidenceReader.ts        # 格式字段读取，不改变原属性
├── recognizeSource.ts       # SourceRecord -> ObjectEvidence；下一轮继续拆裁决
├── sourceTypeCandidates.ts  # type/model 候选读取
└── sourceTypePolicy.ts      # 格式别名与 canonical 值
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

集中处理递归父级、部件/机柜成员、neutral set、未分类装配候选和独立对象；设备/屏柜上下文解释已移到 `contextualRecognition`。当前仍是最大的单一阶段，后续可按分支继续拆成策略函数，但必须保持现有 parity 结果。

### membershipRecoveryState

归属恢复只构造一次宿主和子件索引；同次归属转移集中更新 owner、状态、依据与后代。它不生成宿主匹配规则，也不改来源父级。

### adapters/evidenceReader 与 sourceTypeCandidates

`evidenceReader` 只读取字段、过滤空值、跳过 DEV 字段并保留证据地址；`sourceTypeCandidates` 只读取原始 `source_type`、TYPE/型号、IFC/DEV 别名和标准类别候选。两者不改变原属性，也不直接决定实体归属。

### 本轮行为收口

- 独立边界与分类冲突分开：显式独立对象保留 `U-OBJECT` 实体，角色本身冲突仍进入待归。
- 物理父级与语义组成冲突时保留两侧证据，主归属进入 `composition_host_conflict`；有/无 Adapter 宿主提示结果一致。
- 中性点成套只接受两个直接且可确认的类型证据，显示名不能升级置信状态；暖开识别决策版本变化会自动重算实体与导航。
- `adapters/recognizeSource.ts` 仍是最大的 Adapter；`adaptSourceEvidence` 的候选裁决/证据组装尚未拆完，不能把文件迁移当成职责拆分完成。

## 约束

- 不先冻结当前错误识别结果再拆模块；每次拆分用现有 83 个 recognition parity 用例和语义测试验证。
- 拆分不重复读取 CBM/DEV/FAM；来源文档缓存仍由 Source 层持有。
- Engineering 只消费 Semantic 快照做融合，Projection 不修正底层语义。
- 解析语法归 Parser；Semantic 不直接读文件、不调用 DOM/Worker。

## 下一步

1. 把 `adapters/recognizeSource.ts` 的格式事实读取与候选裁决分开：Adapter 只提交字段/证据/候选，分类和宿主裁决回到 Semantic；优先拆内部 `adapt()`。
2. 把 `ownershipResolver` 的设备/机柜/neutral-set 分支拆成保留优先级的策略函数，入口与顺序不变。
3. 评估 `classify.ts` 的角色/类别/候选汇合点和 `normalize.ts` 的快照发布；没有独立可验证改进时不扩张拆分范围。
4. `extractEngineeringSourceGraph()` 的 FAM 归属/读取已抽到 `sourceFamilyIndex`，文档读取集中到 `SourceDocumentReader` 的 promise 缓存；继续评估引用解析与 CBM/DEV 遍历拆分，读取次数以测试锁定。
