# Substation Runtime 审计与验收

基于本地 main `8e1ab21` 的实现与 `research/*.html` 最新样本分析。研究证据和本轮测试结果分开记录；本地没有真实样本解包目录，本轮不声明真实工程渲染已通过。

## 1. 改动前的 A / B / C 审计

| 类别 | 结论 |
|---|---|
| A：已有支持，保留实现 | IFC 任意目录发现、大小写不敏感 resolver、IFC.NUM 与 IFCFILE+IFCGUID；BASEFAMILY/BASEFAMILYPOINTER；DEV SUBDEVICE 与 TS PHM 递归；MOD/STL/显式 GL；Boolean/Wire/Cable 等扩展 IR；unknown primitive 隔离；PARTINDEX/DEV_SUBDEVICE 排除重复 seed；optional SCH/STD/SLD；多种 FileDevRelation 字段形态 |
| B：已有能力但仍存在假设或路径差异 | F2 分类码映射和排序；SYSTEMNAME 固定 1..4；泛型 DEV 名覆盖真实业务名；FAM indexed refs 在 UI/DEV persistence 不完整；FAM 来源键被显示 Map 丢失；缓存恢复缺失 SYSTEMNAME/DEV 元数据；Rust 与自动/点击缓存回退只展开一层 PHM；FDR 配对启发式和无设备条目缓存丢失；未知 Boolean Type 默认为 Difference |
| C：尚无 production 投影 | 轻量 capability summary、显式双向 PARTINDEX identity alias、same-UUID GL sidecar 来源关联、FAM business identity 候选及详细 provenance |

没有重写 gimIndexer、DEV/PHM parser、Geometry IR、IFC Spatial Core 或 progressive compiler。没有厂商 Adapter，没有 sample id 路由；线路 Runtime 没有改变。

## 2. 修正与 normalized 边界

- Raw：原文件继续保留；CbmNode.rawProperties 与缓存保存原字段，FAM 保存 source path / raw key / label / value / raw line，FDR 保存原设计文档名与引用。
- Evidence：substationEvidence 是纯特征与引用证据探测，不作为 Runtime 分支选择器或第二套 Domain Model。IFC raw 引用保留 direct-guid/source-file/unlinked 及 confidence；字段声明不冒充已验证 IFC 对象。
- Semantic：继续使用 CbmNode、现有 Spatial Core、属性 Map；追加 PARTINDEX ↔ child DEV identity index 和 business identity 候选。PARTINDEX 名称/属性与 DEV placement 分开。
- Geometry：继续使用 DevDocument / PhmDocument / XML IR。Rust query、cold discovery、自动与点击 fallback 按引用递归、逐边矩阵组合、分支防环与深度/实例限制。
- Runtime/UI：真实 SYSTEMNAME1..N / FAM 名称不被泛型 DEV 名覆盖；不按原始码推断专业；child identity 可穿过 GLB 找到已有几何。GLTFLoader 的 Object3D 也可定位，且祖先/后代不重复高亮同一 mesh。
- Auxiliary GL：仅同 UUID 设备 sidecar discovery、来源 UI 和统计；主链仍以真实 SOLIDMODEL 引用为准。

## 3. 样本路径（研究证据，不是本轮真实回归）

| 样本 | IFC | FAM | Geometry |
|---|---|---|---|
| substation01 / demo-substation | F4 IFCFILE+IFCGUID，component-guid；全局 resolver | CBM/DEV BASEFAMILY，分组 indexed BASEFAMILY1..N | 根 DEV → SUBDEVICE → PHM → MOD/STL；PARTINDEX 为语义别名 |
| substation02 | F1 IFC.NUM+IFC0..N，17 个 CBM IFC；file-level，无组件 GUID | BASEFAMILY 与 BASEFAMILYPOINTER，空值和空档案允许 | DEV 1174 / PHM 1174 / MOD 627 / STL 0；引用驱动；logical placeholder，DGN FDR 独立 |
| substation03 | F1 文件清单，8 个 CBM IFC；file-level | BASEFAMILY/POINTER/indexed refs；K=K=V、设计参数/工程属性与自定义名称字段 | DEV 386 / PHM 3316 / MOD 2570 / STL 556；多 PHM 与嵌套 PHM；45 个 GL 为 auxiliary sidecar；PARTINDEX 按 DEV identity 关联，不按顺序 |

## 4. 缓存域

| 域 | 版本 | 原因 |
|---|---|---|
| 变电语义 | gim-substation-parser-v23 → v24 | 原 CBM/FAM/FDR 来源事实、indexed 属性引用、能力 metadata 与可读名称持久化 |
| Spatial snapshot | substation-spatial-semantic-v1 → v2 | FDR 配对修正、CBM entity identity 归一化影响资产来源链接 |
| IFC spatial parser contract | 保持 v23 | IFC selective/two-pass parser 未变化；与变电基础属性域分开 |
| Geometry | geometry-cache-v6-geometry-status → geometry-cache-v7-open-boolean | Boolean unknown operation 改为 unsupported；GLB 保存 child DEV identity；修正缓存图遍历 |
| Fragments | 保持 fragments-cache-v6 与安装版本组合键 | 未改变 IFC fragments 格式或加载行为 |
| Line semantic | 保持 gim-line-parser-v1 | 未改变线路 Runtime 与持久化含义 |

仅增加列与版本校验，不执行全项目或全盘缓存清理。既有 immutable DEV template pool 保留；没有跨 DEV 的同大小去重、猜测共享或 InstancedMesh 重构。实际 GLB fixture 对 nested PHM、多 PHM、重复 MOD 和未引用 GL sidecar 验证了重复编译字节一致性。

## 5. 新增/补强测试

新增 substationEvidence 的 18 项 fixture 测试与一个实际 GLB 编译/读取测试：覆盖 IFC 文件级/组件级/hybrid、BASEFAMILYPOINTER/indexed refs、PARTINDEX 反序 identity join、nested PHM/cycle/missing target、cardinality 不等、STL=0、optional logical model、GL sidecar、空 FAM、来源字段/业务候选冷暖往返、SYSTEMNAME1..N 与可读名 fallback、unknown primitive 和 unknown Boolean operation。

Rust 增加两个数据库查询回归：nested PHM 多实例矩阵/颜色/环/缺失分支；SOLIDMODEL DEV 循环终止、sibling placement 与显式 GL 路径。补强既有 F2 命名、功能树分类、FDR 和 spatial snapshot 路径断言。

| 验证 | 本轮结果 |
|---|---|
| npm test | 69 files / 742 tests 通过，包含既有线路单元测试 |
| npm run test:sample | 26 tests 通过，7 个真实样本测试跳过 |
| npm run build | TypeScript + Vite 成功；保留 web-ifc 大 chunk 提示 |
| cargo check --manifest-path src-tauri/Cargo.toml | 成功 |
| cargo test --manifest-path src-tauri/Cargo.toml db::tests | 22 tests 通过，其他 10 个 Rust 测试不在此筛选范围 |
| git diff --check | 通过 |

缺失 demo-substation、substation02/03/04、line02 及其余线路解包 corpus。因此 sampleRegression 的七项跳过为：

1. CBM 树 + IFC 发现 + FAM 属性全链路。
2. 真实 IFC 空间实体投影与资产缺失状态。
3. 四样本空间实体/包含关系/解析错误基线。
4. 四样本功能域与无效 SYSTEMNAME 分组。
5. 四样本 vendor-neutral compatibility matrix。
6. 线路图构建/属性/地图全链路。
7. 线路冷解析/Worker/属性/地图树一致性。

## 6. 明确未实现的边界

GL ConnectGuid / ConnectionRules / GimGeCableConcentration 的空间规则没有足够证据，未猜测 3D 渲染。Insulator、ConePorcelainBushing、SquareGasket、CircularFixedPlate、BendingCylindrical 等当前不支持的 primitive 保留 raw IR 与 diagnostic，未猜测几何。文件级 IFC 未伪造组件 GlobalId；缺失业务编码未补造统一编码。

没有真实工程的 Tauri/GPU 视觉验收与性能实测，不能据 fixture 结果声称三样本图形完全一致或加速百分比。下一轮有解包目录后可直接运行强化后的样本回归与 Viewer 验证。

## 7. 修改文件清单

- [AGENTS.md](../AGENTS.md)
- [desktop/bridge/database.ts](../desktop/bridge/database.ts)
- [desktop/src-tauri/src/db.rs](../desktop/src-tauri/src/db.rs)
- [desktop/src/app/bootstrap.ts](../desktop/src/app/bootstrap.ts)
- [desktop/src/app/state.ts](../desktop/src/app/state.ts)
- [desktop/src/gim/__tests__/cbmParser.test.ts](../desktop/src/gim/__tests__/cbmParser.test.ts)
- [desktop/src/gim/__tests__/fileDevParser.test.ts](../desktop/src/gim/__tests__/fileDevParser.test.ts)
- [desktop/src/gim/__tests__/sampleRegression.test.ts](../desktop/src/gim/__tests__/sampleRegression.test.ts)
- [desktop/src/gim/__tests__/substationEvidence.test.ts](../desktop/src/gim/__tests__/substationEvidence.test.ts)
- [desktop/src/gim/cbmParser.ts](../desktop/src/gim/cbmParser.ts)
- [desktop/src/gim/famParser.ts](../desktop/src/gim/famParser.ts)
- [desktop/src/gim/fileDevParser.ts](../desktop/src/gim/fileDevParser.ts)
- [desktop/src/gim/geometry/substationSourceGraph.ts](../desktop/src/gim/geometry/substationSourceGraph.ts)
- [desktop/src/gim/geometry/xmlModParser.ts](../desktop/src/gim/geometry/xmlModParser.ts)
- [desktop/src/gim/gimValueSemantics.ts](../desktop/src/gim/gimValueSemantics.ts)
- [desktop/src/gim/substationEvidence.ts](../desktop/src/gim/substationEvidence.ts)
- [desktop/src/gim/types.ts](../desktop/src/gim/types.ts)
- [desktop/src/services/__tests__/glbCacheService.test.ts](../desktop/src/services/__tests__/glbCacheService.test.ts)
- [desktop/src/services/__tests__/substationSpatialSemanticCache.test.ts](../desktop/src/services/__tests__/substationSpatialSemanticCache.test.ts)
- [desktop/src/services/gimIndexPersistenceService.ts](../desktop/src/services/gimIndexPersistenceService.ts)
- [desktop/src/services/gimIndexRestoreService.ts](../desktop/src/services/gimIndexRestoreService.ts)
- [desktop/src/services/glbCacheService.ts](../desktop/src/services/glbCacheService.ts)
- [desktop/src/services/modAutoLoadService.ts](../desktop/src/services/modAutoLoadService.ts)
- [desktop/src/services/nodeInteractionService.ts](../desktop/src/services/nodeInteractionService.ts)
- [desktop/src/services/substationRuntime.ts](../desktop/src/services/substationRuntime.ts)
- [desktop/src/services/substationSpatialSemanticCache.ts](../desktop/src/services/substationSpatialSemanticCache.ts)
- [desktop/src/shared/displayName.ts](../desktop/src/shared/displayName.ts)
- [desktop/src/ui/__tests__/substationFunctionalTreeView.test.ts](../desktop/src/ui/__tests__/substationFunctionalTreeView.test.ts)
- [desktop/src/ui/propsDrawer.ts](../desktop/src/ui/propsDrawer.ts)
- [desktop/src/ui/substationFunctionalTreeView.ts](../desktop/src/ui/substationFunctionalTreeView.ts)
- [desktop/src/viewer/highlight.ts](../desktop/src/viewer/highlight.ts)
- [docs/gim_substation.md](gim_substation.md)
- [docs/schema/02-gim-file-inventory.md](schema/02-gim-file-inventory.md)
- [docs/schema/03-gim-file-role-matrix.md](schema/03-gim-file-role-matrix.md)
- [docs/schema/04-cbm-field-dictionary.md](schema/04-cbm-field-dictionary.md)
- [docs/schema/05-gim-reference-integrity.md](schema/05-gim-reference-integrity.md)
- [docs/schema/07-dev-phm-geometry-reachability.md](schema/07-dev-phm-geometry-reachability.md)
- [docs/schema/09-transform-chain-analysis.md](schema/09-transform-chain-analysis.md)
- [docs/schema/17-batch-load-schema.md](schema/17-batch-load-schema.md)
- [docs/schema/20-substation-partindex-alias-correction.md](schema/20-substation-partindex-alias-correction.md)
- [docs/schema/README.md](schema/README.md)
- [docs/schema/cbm.md](schema/cbm.md)
- [docs/schema/fam.md](schema/fam.md)
- [docs/schema/mod.md](schema/mod.md)
- [docs/schema/phm.md](schema/phm.md)
- [docs/substation_runtime_audit.md](substation_runtime_audit.md)
