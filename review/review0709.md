# GIM Viewer 架构 / 代码质量 / 测试评审报告

评审范围：TS 前端（~80 文件）+ Rust 后端（3 文件，3431 行）。仅分析，未修改任何代码或文档。

---

## 一、总体评价

分层意图清晰、文档（`docs/schema/` 19 篇 + `AGENTS.md`）详尽、关键解析逻辑（几何 IR）测试到位、Rust 后端在 SQL 安全/事务/路径防护上做得相当扎实。但存在三个结构性问题：**`openGimService.ts` 单文件过度集中、整体测试覆盖严重失衡、Rust `db.rs` 体积失控**。

| 维度 | 评级 | 一句话 |
|---|---|---|
| 架构分层 | B+ | 方向基本干净，viewer↔ui 边界有渗漏 |
| 代码质量 | B | 核心 IR 优秀，编排层冗长但稳健 |
| 测试覆盖 | C+ | 几何解析扎实，编排/持久化/线路工程几乎空白 |
| 后端质量 | B+ | 无注入/无 panic/事务正确，但单文件 3300 行 |
| 文档 | A- | schema 文档极其完整，是本项目最大亮点之一 |

---

## 二、架构评审

### 2.1 分层与依赖方向

声称的分层（`AGENTS.md`）：gim(纯解析) / viewer(纯3D) / ui(纯DOM) / services(编排) / desktop(Tauri桥接)。实际依赖方向**大致正确，但有几处偏离**：

**优点**
- `gim/` 层确实**没有**运行时依赖 viewer/ui/services，保持了纯解析独立性。
- `desktop/`、`config/`、`utils/`、`shared/` 是零外部依赖的纯叶子层。
- **无循环依赖**。所有"向上"的边都是 `import type`（编译期擦除）或动态 `import()`（运行期懒加载），构不成静态环。

**偏离点（按严重度）**
1. **viewer→ui 运行时依赖**：`viewer/viewerRuntime.ts:4` 静态导入 `container` from `ui/dom.js`，且 `:34-35` 动态导入 `ui/propsDrawer`、`ui/modelList`。3D 层反向耦合到了特定 DOM 结构。根因是 viewport 元素没有通过参数注入。
2. **ui→viewer / ui→services**：`ui/modelList.ts:3`、`ui/propsDrawer.ts:3` 导入 `ViewerContext` 类型；`ui/cacheManagerView.ts:20` 运行时导入 `services/diagnosticSummaryService`。`AGENTS.md` 声明 ui"不直接碰数据库和 IFC Loader"，实际未完全做到。
3. **ui 直接调用 gim 解析器**：`propsDrawer.ts:5-7`、`cbmTreeView.ts:4`、`fileDevView.ts:4` 直接调用 `parseFamSections`/`getNodeDisplayName`，绕过了编排层。

### 2.2 全局状态管理

`AppState`（`app/state.ts`，131 行）是一个**单一实例 + 参数注入**模式：
- `bootstrap.ts:16` 唯一 `new AppState()`，通过函数参数注入到 20+ 个模块。**不是模块级单例**，这一点比预期干净。
- **风险**：任何持有 `state` 的函数都直接 mutate（`state.currentFiles = ...`、`state.loadedModels.set(...)`）。没有集中的 mutator API，状态结构变更会波及所有 mutator。`resetGimState()` 与 `projectCleanupService` 各自清一半字段，二者职责重叠，容易漏清。

### 2.3 懒加载

**这是架构上做得最好的一处**。`main.ts` 仅 3 行 → `bootstrap()` 只绑定轻量 UI，所有重模块（Three/web-ifc/OBC/services）都通过动态 `import()` 在首次点击时加载。首屏不触碰 Viewer，`visible:false` + `getCurrentWindow().show()` 消除白屏。设计一致且贯彻到位。

### 2.4 耦合热点

| 文件 | 静态 import | 动态 import | 风险 |
|---|---|---|---|
| `openGimService.ts` (888 行) | 19（跨 6 层） | **39** | 全项目最大耦合点，任一层改动都可能影响 |
| `nodeInteractionService.ts` (530 行) | 7 | 23 | 节点点击枢纽 |
| `modAutoLoadService.ts` (864 行) | — | 7 | 体积大但耦合相对集中 |

---

## 三、代码质量评审

### 3.1 GIM 解析层（`gim/`）— 优秀

- `gimExtractor.ts` 的 GIMPKG 头部检测 + 7z/ZIP 签名窗口搜索逻辑清晰，`extractGimHeader` 对零填充、连续 `\0`、字段分隔的处理有充分注释。
- `geometry/ir.ts`（338 行）是**全项目设计最好的模块**：联合类型分发（5 个 kind）、`NoneGeometrySource` 显式表达"无几何"避免 null 散落、primitive 14 类强类型 + 3 类弱 schema fallback，与 `docs/schema/13-geometry-ir-schema.md` 一一对应。
- `xmlModParser.ts` 解析失败优雅降级（矩阵不合法→单位矩阵，颜色越界→undefined），健壮性好。
- `cbmParser.ts` 的循环引用防护（`visited` Set、`devVisited` 逐 sibling 独立分支）和 DEV 文件缓存（`devInfoCache`）考虑周到。`expandDevSubDevices` 的注释（`:377-385`）清楚记录了"为什么虚拟子节点必须携带 SUBDEVICE 变换矩阵"的三个出错路径，说明作者对 bug 根因有深刻理解。

**小瑕疵**
- `cbmParser.ts:97` `type: type === 'simple' ? 'simple' : 'simple'`（xmlModParser 实际在 `:97`）— 这是一个恒等三元，明显是占位/遗留，虽不致 bug 但令人困惑。
- `enhanceF3Name` 用启发式（`/\*/` 或 `/^[\d]/` + 长度>6）判断是否需要增强，规则较脆，缺少测试覆盖。

### 3.2 编排层（`services/`）— 稳健但臃肿

- `openGimService.ts` 的 `openGimWithDialog` 是一个 ~170 行的巨型函数，嵌套了缓存命中短路（变电/线路两条恢复路径）和完整解压回退。逻辑正确，但**分支路径过多、动态 import 过密（39 处）**，可读性和可测试性都受损。
- 错误处理总体克制且合理：逐 IFC 隔离 try/catch + 防御性清理（失败 modelId 立即 `disposeModel`+`loadedModels.delete`），`buildIfcNameIndex` 失败不阻断 UI。`getIfcBufferForEntry` 对缓存损坏（byteLength=0、文件头非 `ISO-`）有专门的 warn 提示，属于生产排障的务实设计。
- `gimIndexPersistenceService.ts` 结构清晰，payload 构建是纯函数，易测试——**但没测**。
- 一个可维护性瑕疵：`gimIndexPersistenceService.ts:180-187` 在文件**中部**出现 `import` 语句（TypeScript 会 hoist，但不符合惯例）。

### 3.3 Rust 后端 — 扎实，但需拆分

**优点（重要）**
- **SQL 全部参数化**，遍历检查无注入。仅有的两处 `format!` 拼接 SQL（`db.rs:686`、`:2526`）只插入硬编码表名字面量，安全。
- **生产代码零 panic**：22 处 `unwrap()` 全在 `#[cfg(test)]` 内。
- **多步写入正确用事务**：`save_gim_index`、`save_line_gim_graph`、`delete_project_cache` 等 5 处，且 `PARSER_VERSION` 版本号在同一事务内更新，crash 能干净回滚。
- **路径遍历防护到位**：`validate_entry_path`（`db.rs:730`）逐 `components()` 拒绝 `ParentDir`/`RootDir`，再 canonicalize + `starts_with` 双重校验。
- 缓存失效机制（`PARSER_VERSION` 常量 + 内容哈希变更检测）设计合理，`upsert_gim_project` 在源文件未变时跳过写 `last_opened_at_ms` 以避免 SQLite 写锁竞争——细节考究。

**问题**
1. **`db.rs` 单文件 3326 行**是最大的可维护性债务。重复严重：7 个手写 `row_to_*` 位置映射器、~20 处复制粘贴的 `prepare→query_map→push` 模式、`validate_gim_cache`(`:1992`) 与 `get_project_cache_diagnostic`(`:2204`) 两个 ~400 行函数逻辑高度重复、`cache_file_path` 与 `fragment_cache_file_path` 90% 相同。拆分为 `schema.rs`/`commands.rs`/`geometry.rs`/`pathutil.rs` 并提取泛型 `collect_rows` 可削减约 40%。
2. **无结构化错误类型**：全部 `Result<_, String>`，丢失错误结构，前端无法按类型匹配。
3. **单 `Mutex<Connection>`**：`get_reachable_geometry`(`:2714`) 在持有 DB 锁的同时做长耗时图遍历+矩阵计算，会串行化其他 DB 命令。桌面级可接受，但是主要扩展瓶颈。
4. **非对称路径信任**：`db.rs` 的缓存读写严格隔离路径，但 `lib.rs:get_file_info`/`read_file_bytes`（`:19`/`:55`）接受前端任意绝对路径——这是后端最强的特权边界。对查看器是有意为之，但值得明确记录。
5. **无正式 migration 框架**：靠吞掉 `ALTER TABLE` 错误 + 版本号失效，非加性 schema 变更时会脆弱。
6. `get_reachable_geometry` 的 `eprintln!` 性能日志在 release 构建中无条件输出。

### 3.4 类型安全

- `as any` 用得克制（集中在 `viewer/`，因 OBC API 类型不全，可理解）。`openGimService` 仅 3 处。
- 非空断言 `!` 全项目很少（解析器仅 4 处）。
- `strict` 模式开启。

---

## 四、测试覆盖评审

### 4.1 测试现状

**8 个 TS 测试文件，~180 个用例**，集中在**几何解析 + MOD 渲染**单一子系统：

| 测试文件 | 用例 | 质量 |
|---|---|---|
| `geometry/xmlModParser.test.ts` | 43 | 最佳：11 强类型 + 3 弱 schema + 未知 primitive + XML 错误 |
| `geometry/devParser.test.ts` | 31 | 高质量：矩阵 NaN、CRLF、越界索引 |
| `viewer/xmlModGeometry.test.ts` | 29 | 中：多个 primitive 断言 `toBeNull()`（MVP 暂停），锁定的是"未实现"非正确性 |
| `geometry/phmParser.test.ts` | 25 | 高质量 |
| `services/modGeometryDiscovery.test.ts` | 19 | 唯一集成测试（CBM→DEV→PHM→MOD 链） |
| `geometry/ir.test.ts` | 18 | 低：多为类型契约锁，运行时价值小 |
| 其余 | — | 薄 |

Rust 后端：仅 `query_reachable_geometry` 有 4 个单测（in-memory DB，写得好），其余命令无测试。

### 4.2 关键覆盖缺口（按严重度）

**严重（管线入口/核心编排，零覆盖）**
1. `gim/gimExtractor.ts`（161 行）— 整条管线入口，GIMPKG 检测/解压。其中 `hasGimPackageHeader`/`findArchiveOffset`/`extractGimHeader` 都是纯函数，**极易单测却没测**。
2. `services/openGimService.ts`（888 行）— 主编排器。
3. `desktop/database.ts`（765 行）— 整个 DB 调用包装层。
4. `services/gimIndexPersistenceService.ts`(281) + `gimIndexRestoreService.ts`(197) — **缓存命中快路径完全未验证**，意味着缓存往返正确性无保障。
5. `app/bootstrap.ts`（175 行）— 顶层装配。

**高（大体积/线路工程，零覆盖）**
- 线路工程整条解析链（`lineCbmParser`/`lineMapData`(631)/`lineDevParser`/`lineFamParser`）**全部无测试**。只有变电站路径有测试。
- `services/modAutoLoadService.ts`(864)、`lineSpanGroupingAuditService.ts`(879)、`lineGeometryAuditService.ts`(436)。
- `coordinateAlignmentService.ts`(181) — 坐标变换正确性对渲染对齐是安全攸关的。
- `cbmParser.ts`(435 行) — 仅 1 个测试用例，与其核心地位严重不匹配。

### 4.3 测试基础设施问题

- **未安装覆盖率工具**（无 `@vitest/coverage-*`，配置无 `coverage` 项）→ 无法量化行/分支覆盖。
- **无 `.gim` 二进制 fixture** → 解压/头部解析这条最易出错的 I/O 路径完全未验证。
- **Rust 测试与 JS 测试割裂**：`npm test` 不跑 `cargo test`，无 CI 桥接，容易漂移。
- `ir.test.ts` 和部分 `xmlModGeometry.test.ts` 是低价值测试，膨胀了用例数却不降低风险。

---

## 五、优先建议（不改代码，仅作建议）

按投入产出比排序：

1. **给 `gimExtractor.ts` 的纯函数补单测**（投入小，收益高，最该先做）。
2. **拆分 `db.rs`** 为 schema/commands/geometry/pathutil 模块，提取泛型 row collector。
3. **给缓存往返加测试**：用 `modGeometryDiscovery.test.ts` 的内联 fixture 模式，测 `buildGimIndexPayload` → （mock invoke）→ `restoreGimIndexToState` 的 round-trip。
4. **接入 `@vitest/coverage-v8`** 并在 CI 跑，先量化再补测。
5. **收敛 `openGimWithDialog`**：把缓存命中分支、解压回退分支抽成独立可测函数，减少 39 处动态 import 的散布。
6. 修正 `xmlModParser.ts:97` 的恒等三元 `type === 'simple' ? 'simple' : 'simple'`（死代码/困惑源）。
7. 明确 `lib.rs` 的 `get_file_info`/`read_file_bytes` 路径信任边界并补充注释。
