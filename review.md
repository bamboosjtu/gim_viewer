# GIM Viewer 架构评审（复核版）

> 复核对象：`e77219d`「bugfix: review.md整改」（基线 `cf6e196` 原评审）
> 复核日期：2026-11-07
> 复核方式：重跑测试与静态检查 + 逐项对照源码 + 导入图度量
> 复核 v2（2026-11-07）：A4「单进程」申诉已评估——事实成立、表述修正、结论降级为架构约束（见 §3 第 1 条与附录 A）。
> 正文只保留**仍然存在**的问题；本轮整改结果与已关闭项压缩到 §1 与附录 A，原报告中不成立的判断在附录 B 更正。

**项目约定（不作为缺陷）**：

- 工程测试集、对照基线和复跑环境由开发者自行构建；远程 CI 只运行不依赖工程样本的单元测试、静态检查和构建，不跑真实/合成样本与性能矩阵。
- `docs/performance.md` 只代表作者在所述机器、构建和私有样本上的结果，不是其他环境的保证。
- SQLite 物理 schema 在首次正式发布前固定 v1；结构变更由开发者删除旧库重建，不维护迁移分支。

---

## 1. 复核结论

本轮整改是一次覆盖面很广的提交：20 项原始发现中 **13 项关闭、4 项部分关闭、2 项按项目约定撤销、1 项转为架构约束**。

| 状态 | 数量 | 条目 |
|---|---:|---|
| 已关闭 | 13 | A2 A3 B1 B3 B4 B5 C2 C3 C4 C5 D1 D2 D3 |
| 部分关闭 | 4 | A1 A6 B2 B6 |
| 按约定撤销 | 2 | A5（测试集自建）、C1（schema 固定 v1） |
| 转为架构约束 | 1 | A4（经申诉复核，见 §3 第 1 条与附录 A 的申诉处理） |
| 仍存在的问题 | 8 | R1–R8 |

复核实测（全部通过）：

| 检查 | 结果 |
|---|---|
| `npm test` | 166 文件 / **1434 用例通过** / 3 跳过 / 133.6 s |
| `npm run lint`（新增） | 通过（`no-floating-promises` + `no-misused-promises`） |
| `npm run check:engineering-boundaries` | 通过；覆盖 6 层，报告 283 模块 / 390 类型边 / 203 动态边 |
| `npm run check:caches`（新增） | 通过：缓存域版本与文档权威一致 |
| `cargo test --lib`（新增进 CI） | **32 通过 / 1 ignored** |
| `check-engineering-catalog` / `check-engineering-docs` | 通过 |

关键度量变化：

| 指标 | cf6e196 | e77219d | 说明 |
|---|---:|---:|---|
| `AppState` 字段 / 行数 | 109 / 550 | **81 / 509** | 三套清理合一，视图状态与属性缓存迁出 |
| `AppState` fan-in | 76 | **61** | 仍为全仓第一 |
| `viewer → app` 依赖 | 12 | **0** | Viewer 不再引用 AppState |
| `services → ui` 值导入 | 21 | **0** | 改为注入 `presentationPort` |
| 静态值循环（排除类型/动态边） | 0 | 0 | 新增全源值图检测；2 处类型级循环仍在，无运行时影响 |
| 前端生产代码 | 50,147 行 | 49,412 行 | 288 文件 |
| `services/` 模块数 | 103 | 112 | 新增展示端口与 inspector 服务 |

---

## 2. 仍存在的问题

严重度：**P2** = 影响长期可维护性或下一阶段工作；**P3** = 成本可控的局部问题。

### R1 [P2] 状态容器与会话守卫仍依赖人工约定

**事实**：`app/state.ts` 509 行、81 个字段，被 294 个模块中的 **61 个**直接依赖（全仓第一）。`isCurrentSession()` 仍有 **229 处调用**；几何路径使用另一套 `isGeometryTokenValid`，两者互不覆盖。本轮新增的 `isCurrentGeometry()`（`shared/projectSession.ts:13`）在生产代码中只有定义、没有调用点。

**已改善**：清理逻辑已收敛为 `releaseSessionResources()`（`state.ts:318`），`invalidatePendingLoads` 先递增代次再释放（`:312-316`），`activateProject`/`resetGimState` 都委托给它；`sessionDisposables` 保证单个 disposer 抛错不影响其余释放，并有对应测试（`reviewLifecycle.test.ts`）。

**仍存在的风险**：任何新增异步路径仍需手工记得调用守卫；`isCurrentSession` 与 `isGeometryTokenValid` 的边界（语义工作 vs 几何批次）只写在注释里，没有类型或包装器强制。

**建议**：下一阶段抽取 SDK 时，把 `ProjectLoadSession` 与守卫一并抽成可注入的 `SessionScope`；在完成前不必为现有 229 处调用做机械改造。

### R2 [P2] Python 工具链是第四份格式实现，且 CI 不再运行其单元测试

**事实**：`tools/` 共 39 个 Python 文件 / 10,157 行，独立实现容器、CBM/DEV/MOD、IFC 查询与分类推断；与 TS（`desktop/src/gim/`，7.3k 行）、Rust（解压 + 语义索引）没有共享 fixture 或一致性检查。

本轮把 `tools-ci.yml` 的步骤从「test + onefile + frozen smoke」改为「onefile + startup」，并注明工程样本测试与 frozen smoke 属于开发者本地。结果是 **CI 中不再有任何 Python 单元测试**（`tools/*/tests/` 仍在仓库里）。

**影响**：Python 侧逻辑变更没有自动化门禁；四份实现对同一格式的解释可能分叉，而分叉只能靠人工发现。

**建议**：若工具链要继续维护，至少保留不依赖样本的 `python -m unittest discover`（现有 `test_core.py` 多为纯函数）；若计划收敛，在下一阶段方案中明确工具的定位（研究工具 or 交付工具）。

### R3 [P3] `ui/` 仍直接值依赖 `gim/` 与 `viewer/`

**事实**：`ui/` 有 10 处非类型导入，例如：

- `ui/propsDrawer.ts:3-4`：`resolveBaseFamilyReferences`、`resolveSubstationBusinessIdentity`、`FamSourceProperty`
- `ui/propsDrawer.ts:13-14`：`isRegionalConnectionObject`、`ifcConnectionOwnershipIndex`
- `ui/lineProjectView.ts:26`：`extractLineMapData`

边界脚本对 `ui` 只禁止 `@desktop`/`@tauri-apps`，因此这些依赖合法通过。数据装配已迁入 `services/inspectorService.ts`，但身份判定与地图数据提取仍在视图层。

**影响**：`layers.md` 规定 ui 只消费"services 暴露的结果、纯类型"，现状是"纯函数也可以"；规则与实现不一致，后续容易扩大。

**建议**：要么在 `layers.md` 明确"ui 可依赖 gim/viewer 的纯函数"，要么把剩余调用移入 `inspectorService`/新的投影服务，并在检查脚本中固定结论。

### R4 [P3] 两处内联 `style` 使 CSP 仍需 `unsafe-inline`

**事实**：内联样式已抽到 `desktop/src/ui/app.css`（452 行），`index.html` 从 609 行降到 137 行。但仍有 2 处 HTML 字符串带内联样式：

- `ui/propsDrawer.ts:330`：`<pre style="max-height:240px;...">`
- `ui/searchBox.ts:104`：`<div style="color:#94a3b8;...">`

因此 `desktop/src-tauri/tauri.conf.json:26` 仍保留 `style-src 'self' 'unsafe-inline'`。

**建议**：把这两处改成 class（成本约半小时），即可去掉 `unsafe-inline`；`script-src` 已经是 `'self' 'wasm-unsafe-eval'`，去掉后 CSP 只剩 `wasm-unsafe-eval` 这一必要放宽。

### R5 [P3] 未使用的 npm 依赖

**事实**：`desktop/package.json:52` 仍声明 `@tauri-apps/plugin-dialog`，但 `src/`、`bridge/` 与脚本中 **0 处引用**；文件对话框由 Rust 侧 `tauri_plugin_dialog::DialogExt` 直接调用（`src-tauri/src/lib.rs`），不需要 JS 包。

**建议**：删除该依赖并重新 `npm install`，减少一份需要跟随 Tauri 升级的包。

### R6 [P3] FAM 段语义在两个域各有一套解释

**事实**：本轮把行切分统一到 `packages/powerline-core/src/famRecords.ts`（输出 `segments`），但取值规则仍不同：

- 变电 `gim/famParser.ts:65-73`：最后一段为值，前面第一个非空段为 key；
- 线路 `packages/powerline-core/src/lineFamParser.ts:80-82`：≥3 段时 `segments[0]` 为展示键、`segments[1]` 为属性键、`segments[2..]` 拼回值。

对 `A=B=C` 这类记录，两者给出不同的键值对。`docs/schema/container.md:64` 只写了"FAM 使用分节和多段 `=`"，没有定义段语义。

**影响**：两域各自自洽，但同一份来源若被另一域读取会得到不同属性；文档无法裁决谁对。

**建议**：在 `docs/schema` 补一节"FAM 段语义"（按域声明），并各加一个 `A=B=C` 的对照用例；若确认两域格式相同，则合并为一个解释器。

### R7 [P3] 质量门禁仍有两处空白

**事实**：

1. `desktop/vitest.config.ts:58-63` 的 `thresholds` 全部为 0（注释写"待覆盖率达到稳定基线后再启用"），覆盖率只报告不拦截。
2. `tools-ci.yml` 不再运行任何 Python 单元测试（见 R2）。

**建议**：覆盖率不必一次设高阈值，可先对 `engineering/`、`gim/` 两个纯层设 70% 下限；Python 侧恢复不依赖样本的 unittest。

### R8 [P3] 三个线路视图仍集中了 UI 一半代码

**事实**：`ui/` 29 个生产文件 / 10,190 行，其中：

| 文件 | 行数 |
|---|---:|
| `ui/lineProjectView.ts` | 1,801 |
| `ui/lineMapView.ts` | 1,801 |
| `ui/lineNavigationTreeView.ts` | 1,535 |

三者合计约 50% 的 UI 代码。`lineMapView` 有完整的 handle/destroy 契约（`destroy()` 在 `:1806`），另外两个没有同等的资源边界。

**影响**：拆分前难以在无 DOM 环境下测试线路投影；这三个文件也是后续 Validate/地图扩展最可能改动的地方。

**建议**：按"数据装配 / 渲染 / 副作用"拆，而不是按行数切；优先把 `lineNavigationTreeView` 的投影函数抽成纯函数（可在 Worker 与测试中复用）。

---

## 3. 架构约束（不是缺陷，但影响下一阶段）

1. **单 OS 进程内的 Worker 并行**：DEV/PHM/MOD 解析、XML primitive → Geometry、CSG 与 GLTF 导出都在 `devGeometryWorker` 池执行（池大小 `max(2, min(memoryCap, floor(cores*0.6)))`，最多 8，`devGeometryWorkerClient.ts:81-92`）；IFC 主转换、区域近景、单对象精细与 Spatial 扫描各有 Worker（`ifcConversion.ts:51`、`ifcRegionalRuntime.ts:157`、`ifcObjectFineRuntime.ts:35`、`substationSpatialWorkerClient.ts:19`），web-ifc 的 `OpenModel`/`IfcImporter.process` 在 Worker 内（`ifcConversionWorker.ts:85,109,153`）。**常规路径下主线程只做** GLB 解析恢复（`glbCacheService.ts:741-747`）、模板实例化、场景提交（`devGeometryTelemetry.ts:8,13` 的 `glbParse`/`sceneCommit`）与失败 DEV 的 raw fallback（`modRawGeometryLoader.ts:219,285` 的 `loadModFile`/`loadStlFile`）；缓存恢复与目录 bounds 在依赖未注入时仍会回退到主线程解析（`devGlbCacheRecovery.ts:96-101`、`devSpatialCatalog.ts:132`）。
   **代价**：Worker 与主线程共享同一进程地址空间，内存仍计入 WebView 进程，`terminate()` 不保证页面立即归还；单个失控任务可导致整应用 OOM/崩溃。**但**进程隔离不减少总内存（编译产物仍要回主进程，进程树总量相加），且会引入 IPC、打包与 Android 复杂度。**结论**：这是有明确取舍的已知约束，不是缺陷；Benchmark 阶段先采集 `glbParse`/`sceneCommit` 与进程内存峰值，只有在复现到具体 OOM/崩溃后再评估隔离。
2. **Rust 只做 IO/解压/SQLite/语义索引**：跨端复用的边界清晰，但也意味着 Android 无法直接复用桌面几何编译。
3. **测试集本地化**：CI 只能验证代码契约，不能验证真实工程；任何"工程可用"的结论都必须由开发者本地样本复跑。
4. **SQLite schema 固定 v1**：结构变更即删库重建，语义/几何缓存仍按各自域版本失效；这降低了迁移复杂度，也意味着升级路径不可回退。

---

## 4. 复核方法与证据

```powershell
cd desktop
npm test                                        # 166 文件 / 1434 通过 / 3 跳过 / 133.6 s
npm run lint                                    # 通过
node scripts/check-engineering-boundaries.mjs   # 通过（283 模块 / 390 类型边 / 203 动态边）
node scripts/check-cache-contracts.mjs          # 通过
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked   # 32 通过 / 1 ignored
```

导入图度量脚本：`research/scripts/import-graph.mjs`（仓库根运行）。统计口径：`desktop/src` 与 `desktop/bridge` 的 `.ts`，排除 `__tests__` 与 `*.test.ts`，`.js` 说明符映射到 `.ts`；同时解析静态与动态导入，循环检测区分"纯静态值图"与"含类型/动态边"。

**复核基线说明**：结论以提交 `e77219d` 为准。复核期间工作区出现 9 个未提交文件（`entryResolver` 新增 WeakMap 路径索引缓存并更新 `cbmParser`/几何服务调用点），已单独验证 `tsc --noEmit` 通过、相关 61 个测试通过；该改动不在本次结论范围内，提交后建议重跑一次全量测试。

---

## 附录 A：本轮已关闭项

| 原 ID | 问题 | 关闭证据 |
|---|---|---|
| A2 | 会话/几何 token 校验 | 已有 `isGeometryTokenValid`（cf6e196 即存在）；本轮统一 `releaseSessionResources` + `sessionDisposables` + `isCurrentGeometry`，并有 `reviewLifecycle.test.ts` |
| A3 | 边界检查盲区 | `check-engineering-boundaries.mjs` 覆盖 engineering/gim/viewer/ui/services/app 六层，viewer 禁 app、services 禁 ui 值导入、全源静态值环检测 |
| B1 | 质量门禁缺口 | 新增 `eslint.config.mjs`（no-floating-promises）；CI 新增 `npm run lint`、`check:caches`、`cargo test --lib`（32 用例） |
| B3 | 内联 CSS | CSS 抽到 `ui/app.css`（452 行），`index.html` 609→137 行 |
| B4 | 解析契约 | `cbmParser` 改用 `createEntryResolver`（相对路径 + 歧义用例）；`decodeGimText`（UTF-8 fatal → GB18030）；`reviewParsing.test.ts` 覆盖 |
| B5 | 失效开关与不可达缓存域 | `readIfcOpeningPolicy`、`fragments-cache-v6`、`substation_fragment_cache` 表与遥测全部移除，全仓 0 引用 |
| C2 | 删除工程漏表 | `schema.rs` 的 `PER_PROJECT_TABLES`（16 表）统一驱动 `clear_project_tables` |
| C3 | 持锁做文件 IO | `cache_validation.rs:311-317` 取快照后 `drop(locked)`，stat 在锁外 |
| C4 | 7z 子进程早退不回收 | `seven_zip_cli.rs:239-246` `ReapedChild` 在 `Drop` 中 kill+wait，并有 `process_guard_tests` |
| C5 | Android key 归一化不一致 | `app/src-tauri/src/storage.rs:310` 单一 `normalize_entry_key`，读写导入三处共用 |
| D1 | 未绑定会话的 `hideLoading` | 服务层已无；仅 app/ui 入口保留 10 处提示性延时 |
| D2 | 发布状态模块单例 | 改为 `createCachePublishStatus(isCurrent)` 工厂，按会话创建并注册到 `sessionDisposables` |
| D3 | Worker RPC 重复 | `services/workerRequests.ts` 统一超时与单次结算；engineering/lineParser/substationSpatial 三个 RPC 型 client 复用，线路 client 补齐 `onerror`/`onmessageerror`；DEV 池化 client 保留自己的 slot 生命周期并同样补齐错误回调 |

部分关闭：

| 原 ID | 已做 | 仍存在 |
|---|---|---|
| A1 | 字段 109→81、清理合一、视图状态/属性缓存/DEV 槽迁出 | R1（fan-in 61、手工会话守卫） |
| A6 | 配额与阈值统一到 `contracts/gim-limits.json`，TS/Rust/Android 共用 | R2（Python 第四份实现） |
| B2 | 补 LICENSE、`.gitattributes`、缓存版本校验脚本、修复文档死链 | R5（未使用依赖） |
| B6 | 新增 `services/inspectorService.ts` 承接数据装配 | R3（ui 仍值依赖 gim/viewer） |

### 申诉处理：A4 单进程拓扑

| 项 | 结论 |
|---|---|
| 申诉主张 | 编译已 Worker 化，不是"所有几何计算在主线程"；缺的是 OS 进程级隔离 |
| 事实核验 | **成立**。DEV/MOD/GLB 导出在 Worker 池；IFC 转换/近景/精细/Spatial 均在 Worker；主线程只做 GLB 恢复、场景提交与 scoped raw fallback |
| 表述处理 | **采纳**。删除原 R1 的"编译全部位于单进程"标题，改为 §3 第 1 条的精确描述 |
| 结论处理 | **部分采纳**。Worker ≠ 进程隔离这一结构事实保留，但按"进程隔离不减少总内存 + Android/IPC 成本"降级为已知约束，并改为"先测量、后决策" |
| 净结果 | 问题数 9 → 8；A4 不再计入缺陷 |

---

## 附录 B：对原报告的更正

1. **"没有任何提交点因 token 变化而拒绝"不成立。** 在 `cf6e196` 时 `modGeometryContracts.ts` 已提供 `isGeometryTokenValid`，`progressiveGeometryService.ts` 与 `modAutoLoadService.ts` 已使用。准确表述应为："`isCurrentSession` 不包含几何 token，几何路径另有一套守卫；两套守卫的边界只写在注释里。"
2. **Android "必失败"不成立。** 原报告依据 key 归一化不一致推断"含反斜杠条目必失败"，该推断未经运行验证；本轮已统一 `normalize_entry_key`，结论作废。
3. **性能与内存归因撤回。** 原报告把 21 s 暖开与 7.5 GiB 峰值归因到单进程拓扑，属于从结构推断因果，静态代码不能证明；`docs/performance.md` 也已声明仅为作者本地结果。本文只保留结构事实（§3 第 1 条），不再复述具体数值作为缺陷证据。
4. **"验证资产不可复现"撤销。** 测试集由开发者自建、CI 不跑样本是项目明确约定（见 AGENTS.md 与 `docs/validation.md:13`），不构成缺陷。
