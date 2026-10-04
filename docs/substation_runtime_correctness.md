# 变电 Runtime 正确性收口验收

基线：`d6daecec40b3b8a3db6f15a9038715fcff942b9c`。开始时 HEAD 与该提交一致，工作区干净，未发现需要保留的后续提交。本轮保留现有解析层、Spatial Core、immutable DEV template pool 和分域缓存，不新增厂商分支、primitive、InstancedMesh，不调整 Fragments 默认开关或线路业务。

## 修改前复现

### A：FAM 原始行与旧 SQLite 唯一键冲突

实读解包后的文件，使用旧表定义和普通 INSERT，第二条同节同键记录触发 `UNIQUE constraint failed: substation_fam_property.project_id, substation_fam_property.source_path, substation_fam_property.section_name, substation_fam_property.prop_key`。

| 样本 | 来源 | 物理行 | 原始记录 | 引用它的 DEV |
|---|---|---|---|---|
| 01 | `DEV/bddd1057-a1a4-4101-8ee1-a42fde9b4619.fam` | 2、7 | `材质=材质=铝`；`材质=材质=制造厂家提供` | `DEV/242d773c-a1b4-4ba2-ad79-59f551d1764f.dev` |
| 03 | `DEV/C1B1A90A-5DE2-4DA1-8D3B-D38A979E73CE.fam` | 7、9 | 两条 `=接地开关关合感应电压能力=10` | `DEV/5B111297-BD2F-47EF-B3F9-6A538403E59B.dev` |

两者均为设备实际引用的属性文件。审计还发现 `row_to_fam_property` 读取 `raw_property_json` 的列偏移错误：原 SELECT 的 JSON 位于列 8，代码读取列 9。单独比较 payload 与 restore 无法暴露这个数据库读取错误。

### B：DEV 模板查询跨放置实例选取

修改前运行新增回归：两个 group 共用一个 DEV、拥有不同根 CBM path，限定 A occurrence 后期待一个 group，原实现仍返回两个。

实读 02 的 `DEV/3eb53480-871e-4f33-830d-95c51d364d89.dev`，124 个不同 F4 引用该模板，包含 `CBM/215de1c9-3171-4a47-b324-ed4303a57743.cbm` 和 `CBM/1bd26bb4-2896-4a7d-824d-e64eee24ef09.cbm`。模板存在不能证明被点击的放置实例已经加载。

另一个重复点击回归实际复现：同一 root 先 raw 加载三个叶子，GLB 后来变为可用，再点击会新增一份 GLB，group 数从预期 3 变为 4。全量 raw 自动加载分支也漏写实例归属，现已补齐，新增测试覆盖全量 raw → progressive GLB 的无重复提交。

## 最小修复和边界

### FAM 原始记录与查询视图

- 冷解析给每条有效属性记录增加一基物理行号 `sourceLine`；原始数组按物理顺序保留同键同值、同键异值和空值。
- SQLite 原始行唯一身份为 `(project_id, source_path, source_line)`，保留 `sort_order` 和每行完整 `raw_property_json`。JSON 包含 sourcePath、section、rawKey、label、rawValue、rawLine、sourceLine。
- 查询 Map 的键仍为 section/normalized label，按原始行顺序最后一行生效，包括空值。重复分节延续该分节的 Map。这个投影不删除原始记录。既有业务身份候选仍按候选种类优先级取首个非空来源值，不扩张身份模型。
- 属性来源 UI 展示全部行、物理行号和 rawLine，单独统计重复键及冲突键，并说明单值策略。空 FAM 的来源及空数组在 warm restore 中保留。
- 旧表迁移保留原有行和 JSON，以旧 sort_order/id 生成每来源的稳定 ordinal；旧缓存没有可靠物理行号，由语义版本失效后的重新解析补齐，不伪称迁移可以恢复旧表已丢失的重复行。
- 旧共享 v22 缓存补 domain 字段时记录其实际旧版本，不直接标为当前 v25；否则一次初始化会绕过原始行身份变化所需的重新解析。

### 模板身份与 occurrence 身份

- DEV path 是共享模板身份。根 CBM path 是 F4/root occurrence 身份。实际 DEV 装配边路径（例如 `sub:0/sub:2`）是 child occurrence 身份。
- PARTINDEX 仍通过 DEV identity join 建立 alias；新增所属 root 的索引，保留该 root 下所有匹配装配路径。路径序号来自真实 DEV 边，未使用 PARTINDEX 数组序号配对。
- 叶子 reference path 还包含 DEV solid/PHM 边；raw instance key 为 `raw:<root CBM path><reference path>`。矩阵相同的不同根或不同装配边也不合并。
- F4 只收集该 root；PARTINDEX 只收集所属 root 的候选装配子树。未关联时提示；多条路径提示并定位完整候选集合，不默选第一条。
- PARTINDEX 已加载快路径要求同一 root 下每个候选路径已加载。相同 root 的并发重复点击合并在途加载任务，重复点击不增加副本。
- 同一 root 的 raw/GLB 提交互斥：查询已有 placement 归属，在异步 parse 后、场景提交前再次检查。已开始 raw 加载的 root 不再另加整份 GLB；已有 GLB 的 root 不再逐叶补同一份 raw。只查询现有 group，不新增 SceneGraph。
- raw、SQLite 可达性、GLB cold/warm、单 DEV 损坏 fallback 都保留相同 root/assembly/reference 归属。独立成功 root 使用某 child 模板，不会阻止失败 root 恢复自己的 child placement。
- 延续 immutable template 的共享资源策略，高亮使用克隆材质。相机、动态 import、IFC reset 的异步边界检查 project session，旧任务不重置或高亮新工程。

04 样本额外暴露一个小型 UI 问题：分类码附带“含部件…”摘要后，被误当成功能域名称。修复只在功能树 presentation 层识别这个既有摘要形式，没有增加分类码枚举或厂商判断。

## 真实 SQLite 往返

`sqliteHarness.ts` 将实际 TS parser/persistence payload 交给 Rust test-only 文件交换入口。该入口调用生产 `initialize_schema`、`save_gim_index_connection`、`save_geometry_refs_connection` 和查询函数；数据库落盘后关闭连接、重新打开，再把 SELECT 结果交给 TS restore。不是 payload 直接回填。

小型 fixture 覆盖同节同键同值、同节同键异值、不同节同名属性、重复分节、空属性值、空 FAM、全部原始字段与行顺序、单值 Map 确定性、连续两次 save、旧表迁移后正常重建。Rust 另测迁移保留旧行、重复迁移幂等、旧语义版本失效且线路版本保留。四个真实样本也分别执行落盘重开往返。

## 样本身份与严格门禁

实际原始 GIM 的 SHA-256 与样本登记一致：

| 样本 | SHA-256 | 解包目录 |
|---|---|---|
| 01 | `711259814db95999f5282af1871da9cb50db4548b71626637b33038b062fc390` | `demo/demo-substation` |
| 02 | `a1c0990162e769f678f2fe5eeb275b1266fb8640776399289197d1998d372f29` | `demo/substation02` |
| 03 | `3197c03ef2c6c423cbb85447f71491a4112db0f9a8cea0c9f72f0b410b8175ab` | `demo/substation03` |
| 04 | `00b7746d5ea6ab3b92c215c1e42ffc7eec5a9f0517c1c555fa27a596d4d800dc` | `demo/substation04` |

样本根通过 `GIM_SAMPLE_ROOT` 配置。复用 `extract_inventory.py`，新增 `--sample-root`、`--samples`、`--extract-only`；新解包写入 `.gim-source.sha256`，测试同时验证原始文件 SHA 和解包来源标记。已有非空目录不会被工具覆盖；若旧目录没有来源标记，需要用该工具在新的空目录解包，不仅凭目录名宣称身份。标记不是 GIM entry，不送入生产索引。

仓库根解包示例：

```powershell
python desktop/scripts/gim_survey/extract_inventory.py --samples demo-substation substation02 substation03 substation04 --extract-only
```

在 `desktop/` 执行：

```powershell
$env:GIM_SAMPLE_ROOT = 'C:\path\to\samples' # 可省略，默认仓库 demo/
npm run test:substation:strict
```

01/02/03 是硬门禁，缺失、SHA 不符、失败或 skip 都返回非零；04 只在可用时独立增加测试。日常 `test:sample` 仍允许缺样本跳过，且缺 04 不会跳过已有 01/02/03。

逐样本验收包含原始解析、SQLite save/query/restore、cold/warm 名称及来源、alias 候选集合、Rust/TS 逐叶子 instance key/完整 16 元矩阵/颜色对比，以及实际序列化 GLB 后落盘读取、重新 parse、全部 root placement 恢复。相同模板的多 root 同时存在时检查选取范围。选择一个实际完整 DEV 的 GLB 截断后，调用生产 fast path，再调用生产 raw fallback，对照该 root 的 SQL 可达叶子、实例键及 bounding box，重复 fallback 不产生副本。矩阵比较归一化数值表示中的负零并精确到 6 位小数，raw/GLB bounding box 检查到 3 位小数。

## 逐样本结果

以下 root/模板计数是独立根设备入口及其 unique DEV，不是全部 DEV 文件数。重复/冲突是 source+section+label 的键组数，不是重复行的数量。状态列按 unique 根 DEV 编译结果计数。

| 样本 | 原始解析 | SQLite | Rust/TS | GLB 恢复 | 单 DEV raw fallback | 必需测试 skip | 视觉验收 |
|---|---|---|---|---|---|---|---|
| 01 | 通过 | 通过 | 通过 | 通过 | 通过，70 个叶子 | 0 | 未执行 |
| 02 | 通过 | 通过 | 通过 | 通过 | 通过，1 个叶子 | 0 | 未执行 |
| 03 | 通过 | 通过 | 通过 | 通过 | 通过，3 个叶子 | 0 | 未执行 |
| 04（可选） | 通过 | 通过 | 通过 | 通过 | 通过，32 个叶子 | 0 | 未执行 |

| 样本 | 原始 FAM 行 | 重复键 / 冲突键 | 根 occurrence / unique DEV | PARTINDEX / 未关联 / 歧义 | 可达几何叶子 | 辅助 GL sidecar | GLB 恢复 root |
|---|---:|---:|---:|---:|---:|---:|---:|
| 01 | 40,867 | 6 / 6 | 285 / 285 | 3,894 / 0 / 0 | 5,938 | 0 | 285 |
| 02 | 22,887 | 0 / 0 | 3,326 / 976 | 1,349 / 0 / 0 | 4,346 | 0 | 2,566 |
| 03 | 26,395 | 11 / 3 | 162 / 162 | 224 / 0 / 0 | 3,126 | 45 | 162 |
| 04 | 6,376 | 0 / 0 | 532 / 207 | 137 / 0 / 60 | 621 | 0 | 532 |

| 样本 | complete | partial | empty | unsupported | failed |
|---|---:|---:|---:|---:|---:|
| 01 | 204 | 81 | 0 | 0 | 0 |
| 02 | 371 | 50 | 547 | 8 | 0 |
| 03 | 83 | 79 | 0 | 0 | 0 |
| 04 | 184 | 23 | 0 | 0 | 0 |

02 的 760 个 root occurrence 属于 empty/unsupported 模板，没有伪造 GLB 恢复或把 unsupported 标成 empty。03 的 45 个同 UUID GL sidecar 保留为辅助来源，未混入普通 SOLIDMODEL 主链。04 的 60 个 PARTINDEX 有多个真实装配候选，保留全部并明确提示。

## 命令验收

| 命令（desktop/） | 结果 |
|---|---|
| `npm test` | 72 个测试文件、752 个测试通过 |
| `npm run test:sample` | 31 个通过、2 个线路样本测试因缺少解包目录跳过；四个变电样本均执行 |
| `npm run test:substation:strict` | 4 个真实变电样本通过，必需 01/02/03 零 skip |
| `npm run build` | TypeScript 与 Vite 构建通过；保留现有大 chunk 提示 |
| `cargo check --manifest-path src-tauri/Cargo.toml` | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 34 个通过、0 ignored；SQLite 交换入口由 TS 测试实际提供输入并校验输出 |

门禁负向检查也执行：缺少 01/02/03 时退出码 1；`node scripts/test-substation-strict.mjs -t __no_required_test__` 使 Vitest 跳过全部测试，外层门禁检查报告后仍退出码 1。结果 JSON 和运行日志在被 Git 忽略的 `demo/`，未提交原始 GIM 或完整解包目录。

视觉验收未执行：本轮没有接入可操作的 Tauri 桌面/GPU 验收会话。Three.js/GLB、材质及相机范围的函数验收不等同于 Bentley 样本中真实点击两个柜体的界面验收。

## 缓存版本与迁移

| 域 | 变化 | 原因 |
|---|---|---|
| 变电语义 | v24 → `gim-substation-parser-v25` | FAM 原始行身份、完整 provenance 和 occurrence 可达性含义改变 |
| FAM 表 | 移除旧 section/key 唯一键，新增 source_line 唯一身份 | 允许完整保留重复记录；事务迁移保留旧数据后按语义版本重建 |
| geometry | v7 → `geometry-cache-v8-occurrence` | GLB 序列化新增实际 assembly/reference 路径，旧 GLB 不具备 PARTINDEX occurrence 定位证据 |
| 线路 | 保持 `gim-line-parser-v1` | 契约未改变 |
| Spatial | 保持空间 parser v23、snapshot v2 | 契约未改变，已是基线现有版本 |
| Fragments | 保持 v6，默认开关不变 | 契约未改变 |

不无差别清空项目或线路/Fragments 数据。geometry bump 对应实际 GLB 格式含义变化，不只因为运行时查询增加 scope。

## 实际修改文件

| 分组 | 文件 |
|---|---|
| FAM 与数据库 | `desktop/src/gim/famParser.ts`；`desktop/src/services/gimIndexPersistenceService.ts`；`desktop/src/services/gimIndexRestoreService.ts`；`desktop/bridge/database.ts`；`desktop/src-tauri/src/db.rs`；`desktop/src/ui/propsDrawer.ts` |
| occurrence 与几何路径 | `desktop/src/gim/substationEvidence.ts`；`desktop/src/services/nodeInteractionService.ts`；`desktop/src/services/modGeometryDiscovery.ts`；`desktop/src/services/glbCacheService.ts`；`desktop/src/services/devGlbTemplateRuntime.ts`；`desktop/src/services/modAutoLoadService.ts`；`desktop/src/services/progressiveGeometryService.ts`；`desktop/src/viewer/highlight.ts` |
| 小型 fixture/数据库测试 | `desktop/src-tauri/src/substation_sqlite_tests.rs`；`desktop/src/services/__tests__/sqliteHarness.ts`；`famSqlite.test.ts`；`occurrenceSelection.test.ts`；`occurrenceInteraction.test.ts`；既有 `gimIndexRoundTrip.test.ts`、`modAutoLoadFastPath.test.ts`；`desktop/src/ui/__tests__/propsDrawerInteractions.test.ts` |
| 真实样本门禁 | `desktop/src/services/__tests__/strictSubstation.test.ts`；`desktop/src/gim/__tests__/sampleRegression.test.ts`；`desktop/scripts/test-substation-strict.mjs`；`desktop/scripts/gim_survey/extract_inventory.py`；`desktop/vitest.strict-substation.config.ts`；`desktop/vitest.config.ts`；`desktop/package.json` |
| 功能树 presentation | `desktop/src/ui/substationFunctionalTreeView.ts`；`desktop/src/ui/__tests__/substationFunctionalTreeView.test.ts` |
| 文档 | `AGENTS.md`；`docs/gim_substation.md`；本文 |

## 尚未关闭的范围

1. 真实桌面高亮与相机交互的视觉验收未执行。
2. 已知 primitive 的 partial/unsupported 降级仍存在；本轮没有扩展 primitive，也没有把缺失几何伪装成成功。
3. 04 的多个装配候选缺乏进一步唯一定位证据；当前行为是保留和提示候选集合，不猜测唯一部件。
4. GL sidecar 的高质量空间渲染语义没有新增实现，继续只作为既有辅助来源。
5. 常规样本组的两个线路解包回归未执行；线路单测及 Rust 实际线路解包测试通过，本轮没有改变线路业务。

本轮未提交 Git commit；修改与测试产物可在工作区审阅。
