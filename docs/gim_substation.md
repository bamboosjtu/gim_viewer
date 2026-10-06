# 变电 GIM 当前实现

> 变电 Runtime 面向 `GIMPKGS` 工程，负责 CBM/IFC 语义、Fragments 3D、DEV 几何和
> 树/属性交互。共用容器、会话、缓存基础设施见 [gim_common.md](gim_common.md)，字段和
> 样本边界见 [schema/README.md](schema/README.md)，性能证据见
> [benchmark_substation.md](benchmark_substation.md)。

交互的最新选择提交、无几何状态与本次桌面验收见
[substation_interaction_correctness.md](substation_interaction_correctness.md)。工程会话保护资源
有效性，独立的 SelectionRequest 保护属性、高亮、相机及树/SLD 的选择提交权。

嵌套 PARTINDEX 的语义父链与实际几何 root 分开；子候选限定在父候选装配子树内，
详见 [嵌套部件正确性](substation_nested_partindex_correctness.md)。原始 IFC conversion 与
Spatial STEP scan 使用独立 Worker，保持原坐标锚点、属性及缓存契约；当前持续响应的
失败项和完整路径证据见 [IFC 响应验收](substation_ifc_responsiveness.md)。

## 1. Runtime 与就绪语义

```text
GIMPKGS
  → substation cache validation
  → CBM/FAM/DEV/FileDevRelation
  → core semantic UI
  → first usable IFC + coordinate anchor
  → firstUsableGeometryReady / interactive
  → remaining IFC、空间语义、STD/SLD、缓存持久化
  → allIfcReady
  → DEV GLB / MOD / GL / STL
  → fullModelReady
```

当前就绪时刻不是同一个门：

| 时刻 | 语义 |
|---|---|
| `coreSemanticReady` | CBM、IFC entry、设备关系和基础属性可用 |
| `firstUsableGeometryReady` | 首个有效 IFC 已进入 Fragments，并建立坐标锚点 |
| `interactive` | 基础树、搜索、属性、相机/选择和首个 IFC 已可操作 |
| `allIfcReady` | 所有 IFC 按既有顺序完成或被记录为失败 |
| `fullModelReady` | DEV 派生几何和按需回退路径完成 |

首次可交互不再等待全部 IFC 或 DEV 几何；项目切换由 `ProjectLoadSession` 和 geometry
token 隔离旧模型、空间结果、GLB placement 和 UI 回调。

## 2. 语义模型与空间索引

当前变电边界沿用既有类型体系，不引入 VendorAdapter 或第二套 Domain Model：

```text
Raw GIM 文件 / 原字段 / 原引用 / source path
  → capability 与 evidence 探测（描述，不选择厂商分支）
  → CbmNode + PARTINDEX alias + FAM 来源属性 / business identity 候选
  + DevDocument / PhmDocument / XML IR + 完整实例 placement
  → Substation Runtime / 功能与空间投影 / 分域缓存
```

`CbmNode.rawProperties` 保留原始分类码、SYSTEMNAME 和引用字段。F2 保留原始顺序，
不把 A/U/S/G、Y、数字或文字码映射为统一专业。名称优先使用 SYSTEMNAME1..N、FAM
的可读名称和 DEV SYMBOLNAME；PARTINDEX 的业务名称可覆盖通用 DEV 名称。

`gim/substationEvidence.ts` 的轻量投影提供：

- `inspectSubstationCapabilities`：统计文件、component GUID / file-level IFC、family reference、
  nested DEV/PHM、optional logical model、GL sidecar 和 FDR；用于诊断 JSON、回归和缓存 metadata。
  它不驱动 parser 分支，也不是另一份 semantic graph。
- `buildSubstationIfcEvidence`：direct-guid / source-file / unlinked 原始引用证据。IFC 发现和
  对象关联分开；IFC.NUM + IFC0..N 不产生伪造 GUID。物理目录是 exporter detail，
  路径基于 CBM 引用 + 全局 entry resolver，不能写死 DEV/ 或 CBM/。
- `buildSubstationAliasIndex`：PARTINDEX 与实际 DEV occurrence 按 OBJECTMODELPOINTER
  identity join；不按数组位置。PARTINDEX 只提供语义属性，不产生第二个几何 seed。
- `discoverSubstationGlSidecars`：MOD/<same-UUID>.gl 与实际设备 DEV 关联，来源 UI 和诊断
  可见；它不自动进入 SOLIDMODEL 链，也不推断 ConnectGuid / ConnectionRules 的空间含义。

FAM 是 property sidecar，支持 BASEFAMILY / BASEFAMILYPOINTER / BASEFAMILY1..N 和空文件。
详细属性保留 sourcePath、section、rawKey、label、rawValue、rawLine；既有 section Map
仍可用于显示。business identity 按三维设计模型编码、电网工程标识系统编码、设备编码、
调度编码、实物ID寻找实际候选，缺失返回空；内部 GUID/path 仍作为技术来源标识。
空 sentinel 不进入可操作属性缓存，原文件与原 CBM 字段仍保留。

FileDevRelation 是独立的设备 → 原始设计文档 provenance。缓存保留原 NAME（含 DGN 等
扩展名）及无设备列表的来源条目；它不能替代 package → IFC discovery，也不伪造 IFC 文件。

入口 `CBM/project.cbm` 构建功能树，并从 CBM、FAM、DEV、FileDevRelation 得到 IFC
文件、设备关系和基础属性。IFC 由 `gimIndexer.ts` 发现并使用稳定的 logical `modelId`；
会话内再映射到带 source/session 身份的 Fragments runtime model ID。

`ifcSpatialParser.ts` 实现变电 Spatial Semantic Core：

- selective/two-pass scan 只把空间树、必要关系、placement 闭包和导航对象放入长期索引；
- IFC 属性集、工程量、材质、分类、类型和分组由 Fragments `getItemsData()` 按需读取；
- containment、decomposition、host、boundary 和 CBM↔IFC link 以 evidence/confidence
  保存，不把推断关系伪装成直接 IFC 事实；
- `SubstationSpatialIndex` 提供 `nodeByKey`、`objectByKey`、link 反查和 coverage，供
  空间树、属性抽屉、GUID 选择和导航使用。

交互后先尝试独立的 `substation-spatial-semantic-v2` snapshot。命中只做版本/source SHA
校验、JSON deserialize 和 Map hydrate；miss、损坏或引用不完整才在 `allIfcReady` 后重建。
Spatial Semantic Core 本身不在本文下一步改造范围内。

## 3. IFC、DEV 与 3D 实现

IFC 路径为 `web-ifc → @thatopen/fragments → Three.js/OBC`。`ifcEntryLoader.ts` 依次尝试
Fragments cache，失败时回退原始 IFC；加载后校验模型同时存在于 `AppState.loadedModels`
和 Fragments runtime list，避免“回调到了但模型不可用”。首个模型还负责 coordinate anchor、
名称索引、选择和相机初始化。

DEV 几何路径为 `DEV → PHM/DEV → MOD/GL/STL`：

- DEV/PHM/MOD cardinality 不参与遍历；STL 为零也合法。PHM 按目标扩展名递归，完整保留
  每条边的矩阵和颜色。cold discovery、Rust SQLite query、自动和点击 raw fallback 一致处理
  nested PHM、分支 cycle guard、递归深度与实例上限；缺失目标隔离，不隐藏其余来源。
- XML primitive 是开放 IR：known 正常渲染；未支持或 unknown 保留 raw tag/attrs 并跳过
  renderer，不拖垮其它 Entity。Visible 大小写不敏感；未知 Boolean operation 明确 unsupported，
  不默认 Difference。
- cold 由 `progressiveGeometryService.ts` 按 unique DEV 编译为 GLB，再按 CBM placement
  渐进显示；
- warm 优先读取 geometry manifest 和批量 GLB，`empty`/`unsupported` 是合法确定性结果，
  `partial` 保留已有几何；
- session-local `DevGlbTemplatePool` 对静态 DEV 只做一次 template parse，placement
  共享 immutable geometry/material，不能证明可共享的 DEV 仅按 DEV 回退 legacy placement；
- 单个 DEV 的 GLB 缺失、截断、读取或解析失败只触发该 DEV 的 raw MOD/GL/STL fallback，
  不清理其它成功模型；manifest/source 结构损坏才重建 geometry domain；
- DEV、PHM、CBM、SUBDEVICE 的完整矩阵在实例级累积，PHM `COLOR` 在实例级应用，几何
  状态以 `renderable/partial/empty/unsupported/failed` 写入诊断。

这是 Geometry Failure Isolation + immutable DEV template + bounded placement 的当前
实现；不引入 shared geometry、InstancedMesh，也不把 cold DEV compiler 与 IFC 并发绑定。

## 4. 缓存与属性 UI

变电专属缓存字段在本节维护，共性缓存契约见 [gim_common.md](gim_common.md)：

| 域 | 当前实现 |
|---|---|
| 语义 | `substation_cbm_node`、`substation_ifc_model`、`substation_file_dev_entry`、FAM/DEV 属性 |
| 引用链 | `substation_dev_solid_model`、`substation_dev_sub_device`、`substation_phm_solid_model` |
| IFC 文件 | `substation_gim_entry.local_cache_path`，按 entry path 懒读 |
| Spatial | 独立 snapshot，绑定 source SHA、parser/domain version 和 snapshot version |
| Fragments | `substation_fragment_cache` + `fragments/{project_id}`，绑定 GIM SHA、IFC size、Fragments/web-ifc 版本 |
| DEV 几何 | `glbcache/{project_id}` 的 GLB、manifest 和 geometry version marker |

版本边界：变电语义 `gim-substation-parser-v25`（FAM 原始行身份、完整 provenance 和 occurrence
可达性）；几何 `geometry-cache-v8-occurrence`（GLB 子几何保存 assembly/reference path）。
FAM SQLite 唯一键是 project/source/source_line；section/label 是查询键，不是原始记录身份。
单值 Map 按原始行顺序采用最后一行生效，包含空值；原始行和冲突诊断独立保留。
DEV 是共享模板身份，根 CBM path 是放置实例身份，实际 DEV 装配边路径是 child occurrence。
PARTINDEX 通过 DEV identity join 得到同一 root 下的候选集合，不按数组位置配对；多条候选
明确提示并定位集合。raw、GLB 和 SQLite 恢复共享 root/assembly/reference 归属。
线路保持 v1、Fragments 保持 v6。IFC 空间 parser contract 保持 v23，snapshot 保持
`substation-spatial-semantic-v2`；这两个 Spatial 版本已存在于本轮基线 d6daece。
失效由各域自身版本和 source SHA 决定。不清空整个项目缓存。

缓存命中先恢复 CBM/FAM/DEV/FileDevRelation 和基础 UI，再按就绪语义恢复 IFC。缓存失效、
文件缺失、版本不匹配和坏的派生数据都 fail closed，并回到对应的原始路径；不会用空对象
替代未知或失败数据。

严格三样本门禁：`npm run test:substation:strict`；`GIM_SAMPLE_ROOT` 可配置样本根目录。
01/02/03 缺失、失败或 skip 都返回非零；04 可选且独立执行。解包使用
`python desktop/scripts/gim_survey/extract_inventory.py --samples demo-substation substation02 substation03 substation04 --extract-only`，
可加 `--sample-root`。解包身份标记 `.gim-source.sha256` 由工具写入，不属于 GIM entry。
SQLite 往返调用生产 Rust SQL，落盘后关闭并重开连接，读取结果再交给 TS restore。
逐样本明细与验收边界见 [Runtime 正确性收口](substation_runtime_correctness.md)。

属性抽屉统一为概览、参数、关系、来源四个视图：IFC Pset/工程量按需读取，CBM↔IFC、空间
link 和几何来源可互相定位，GUID/长路径只作为来源按钮内部键。STD/SLD 在 interactive
之后解析或从缓存恢复，不成为首个 IFC 的前置门槛。

SCH/STD/SLD 是 optional capability；LOGICALMODEL 空占位或无图纸不会报错、阻塞打开，
UI 不产生空图纸入口，缓存不要求存在逻辑模型。

## 5. 导航、属性与来源投影

同一空间/功能对象图提供两个变电导航视角：空间树用于位置和 IFC 空间容器，功能系统树
用于 F1–F4/专业/设备关系；设备、图纸和模型工作区只改变投影，不复制另一份语义状态。
搜索、面包屑、树行、3D 选择和属性抽屉使用稳定 logical model ID/GUID，来源按钮再回到
CBM、FAM、DEV、IFC、PHM、MOD 或 STL 原文。

当前 UI 遵守以下边界：

- 首个 IFC 建立坐标锚点后即可操作，不等待全部 IFC、Spatial snapshot 或 DEV；
- `visibility`、`highlight` 和 camera fit 只作用于当前 session 的 runtime model；
- IFC Pset/工程量按需读取，空间关系保留 evidence/confidence，不把推断关系当作原始事实；
- STD/SLD 是 interactive 后的图纸能力，不改变首个 IFC 的前置门槛；
- `renderable`、`partial`、`empty`、`unsupported`、`failed` 和 fallback 原因分别展示。

## 6. Fragments Cache 当前状态

Fragments Cache 的版本键绑定 GIM source SHA、IFC size、`@thatopen/fragments`/`web-ifc`
版本和派生格式版本。命中前 validate/read，成功后由 `core.load` 恢复模型；任何缺失、截断、
版本不匹配或运行时登记失败都回到原始 IFC，记录 fallback，并允许该模型继续完成自愈。
cache-off、miss/build、hit 三种 profile 都保留 attempts、hits、misses、fallbacks 和
validate/read/load/serialize/write/upsert 的耗时。

当前产品默认仍为 `false`。最新 release portable gate 的完整 A/B、MISS/build 和逐 IFC
诊断见 [benchmark_substation.md](benchmark_substation.md)；本轮四个样本的 HIT correctness
和 fallback 门槛通过，但 substation04 的 JS heap peak/idle 稳定高于 OFF 约 20%，因此尚未
满足默认开启条件。

## 7. DEV 几何与下一步计划

DEV 路径保持 Geometry Failure Isolation、immutable DEV template 和 bounded placement：
既有 Fragments release gate 没有改 DEV Geometry Compiler、shared geometry、IFC parser 或 IFC scheduling。现有
`devGeometryProfile` 继续保存 `worstDevPaths`、phase、instance count、fallback 和
unresolved 信息；substation01 cold 的长尾另作为下一轮专项，不在 Fragments gate 中混测。

下一步按顺序执行：

1. 对 substation04 做 JS heap 驻留/回收归因，确认 fragment cache 对 heap 的稳定增量；
2. 如内存门槛通过，再复核四样本 release gate 并提交 `ENABLE_FRAGMENTS_CACHE_BASE=true`；
3. 若后续出现超过 30 s 的 HIT Long Task，只继续拆 `fragment read`、`core.load`、
   `core.update(true)` 和 model-added callback 的诊断，不进入 DEV compiler；
4. MISS persistence 若成为唯一不可接受回归，再单独评估把 serialize/write 移出 IFC
   sequential critical path，本轮不移动 persistence。
