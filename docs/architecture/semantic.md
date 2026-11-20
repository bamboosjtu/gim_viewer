# Semantic Core 拆分

Semantic 负责把来源事实解释成可验证的实体、边界与成员关系。目标不是把大文件按行数切开，而是让每个算法阶段有明确输入、输出和可回放的证据。

## 目录

```text
semantic/
├── normalization/
│   ├── prepareEvidence.ts   # composition 归一化、环校验、parents/meaning
│   ├── transformerBank.ts   # 单相主变成组
│   ├── contextualRecognition.ts # 设备/屏柜上下文中的成员解释
│   └── ownershipResolver.ts # 递归归属和成员判断
├── recognition/
│   ├── evidenceReader.ts    # 分类字段的 transient 读取器
│   ├── sourceTypeCandidates.ts # 原始 type/model 候选与字段读取
│   ├── standardClassResolver.ts # 标准目录类别候选
│   ├── componentResolver.ts # 组件/标准优先级
│   ├── materialResolver.ts  # 材料宿主与成员判定
│   └── recognitionPolicy.ts # 上下文规则与模型优先词
├── catalog/
├── normalize.ts             # 阶段编排
└── semantic.ts              # 公共出口
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

### recognition/evidenceReader

把分类字段读取、空值过滤、DEV 字段跳过和证据 ID 构造从 `adaptSourceEvidence()` 提取出来；它只返回 transient 证据，不改变原始属性。

### recognition/sourceTypeCandidates

把原始 `source_type`、TYPE/型号字段、IFC/DEV 别名、标准类别候选、`IFC.PredefinedType` 和 `categoryValue()` 的读取从 `adaptSourceEvidence()` 提取出来。它只产出候选，不决定实体或归属。

## 约束

- 不先冻结当前错误识别结果再拆模块；每次拆分用现有 83 个 recognition parity 用例和语义测试验证。
- 拆分不重复读取 CBM/DEV/FAM；来源文档缓存仍由 Source 层持有。
- Engineering 只消费 Semantic 快照做融合，Projection 不修正底层语义。
- 解析语法归 Parser；Semantic 不直接读文件、不调用 DOM/Worker。

## 下一步

1. 把 `ownershipResolver` 的设备/机柜/neutral-set 分支拆成策略函数，保留同一阶段入口。
2. 提取 `entityFactory`（identity、boundary、classification details）和 `membershipResolver`。
3. 已提取 `sourceTypeCandidates`、`standardClassResolver`、`componentResolver`、`materialResolver` 和 `contextualRecognition`；下一步拆 `objectEvidenceAdapter` 与角色/候选组装，优先保持 83 例 parity。
4. `extractEngineeringSourceGraph()` 的 FAM 归属/读取已抽到 `sourceFamilyIndex`；继续拆遍历调度与 CBM 物理作用域，避免重复文档读取。
