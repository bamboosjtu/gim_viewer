# GIM Viewer 评审报告（2026-07-11）

评审范围：TS 前端（~80 文件）+ Rust 后端（3 文件，3668 行）。仅分析，未修改代码。

---

## 一、总体评价

| 维度 | 评级 | 一句话 |
|---|---|---|
| 架构分层 | A- | shared/ 门面层 + viewerUIBinding 装配层到位，仅编排层巨型函数未拆 |
| 代码质量 | B | 核心 IR 优秀，编排层巨型函数和 db.rs 单文件是最大债务 |
| 测试覆盖 | C | 几何解析扎实（222 用例全通过），编排/线路/坐标对齐空白 |
| 后端质量 | B+ | 无注入/无 panic/事务正确，但单文件 3528 行 |
| 实现一致性 | A- | 与 docs/schema 研究结论高度吻合 |

---

## 二、架构问题

### 2.1 openGimService.ts 巨型函数

[openGimService.ts](file:///d:/vibe-coding/gim_viewer/src/services/openGimService.ts) 共 **945 行**，其中 [`openGimWithDialog`](file:///d:/vibe-coding/gim_viewer/src/services/openGimService.ts#L764-L945) 函数 **182 行**，包含 **37 处动态 import**，嵌套了缓存命中短路（变电/线路两条恢复路径）和完整解压回退两条主路径。

**影响**：可读性和可测试性严重受损，该函数是全项目最大的耦合热点，任一层改动都可能波及。

---

## 三、代码质量问题

### 3.1 db.rs 单文件 3528 行

[db.rs](file:///d:/vibe-coding/gim_viewer/src-tauri/src/db.rs) 共 **3528 行**。重复严重：

- 7 个手写 `row_to_*` 位置映射器
- ~20 处复制粘贴的 `prepare→query_map→push` 模式
- `validate_gim_cache` 与 `get_project_cache_diagnostic` 两个 ~400 行函数逻辑高度重复
- `cache_file_path` 与 `fragment_cache_file_path` 90% 相同
- 39 处 `Result<_, String>` 签名

**建议**：拆分为 `schema.rs`/`commands.rs`/`geometry.rs`/`pathutil.rs` 并提取泛型 `collect_rows`，可削减约 40%。

### 3.2 Rust 无结构化错误类型

全部 39 处 Tauri command 签名为 `Result<_, String>`，无 `enum Error` / `thiserror`。前端无法按错误类型匹配（如"缓存损坏"vs"文件不存在"vs"路径遍历"均返回相同 String）。

### 3.3 get_reachable_geometry 持锁做长耗时操作

[db.rs:2939](file:///d:/vibe-coding/gim_viewer/src-tauri/src/db.rs#L2939) 获取 `Mutex<Connection>` 锁后，[:2945](file:///d:/vibe-coding/gim_viewer/src-tauri/src/db.rs#L2945) 在持锁状态下调用 `query_reachable_geometry`，该函数内部执行 CBM 树遍历 + 子设备递归 + DEV/PHM/MOD 三层 JOIN + 矩阵字符串拼接。锁持有到函数返回才释放。

**影响**：长耗时操作期间所有其他 DB 命令被串行化阻塞。桌面级可接受，但是后续扩展的主要瓶颈。

### 3.4 无正式 migration 框架

[db.rs:226-374](file:///d:/vibe-coding/gim_viewer/src-tauri/src/db.rs#L226-L374) 有 6 处 `let _ = conn.execute("ALTER TABLE ... ADD COLUMN ...", [])` 模式，靠吞掉"列已存在"错误实现兼容。`PARSER_VERSION` 版本号失效机制处理加性变更，但非加性 schema 变更（删列/改类型）时会脆弱。

### 3.5 enhanceF3Name 启发式规则脆弱且无测试

[cbmParser.ts:133-172](file:///d:/vibe-coding/gim_viewer/src/gim/cbmParser.ts#L133-L172) 用 `/\*/.test(baseName) || /^[\d]/.test(baseName)` + 长度≤6 判断是否需要 F3 名称增强。规则较脆，且 `cbmParser.test.ts` 仅有 **1 个测试用例**，与 cbmParser.ts 的 435 行体积和核心地位严重不匹配。

---

## 四、测试覆盖问题

### 4.1 测试现状

**11 个 TS 测试文件，222 个用例，全部通过**。覆盖率工具已接入（`@vitest/coverage-v8`），`npm run test:coverage` 可用。

| 测试文件 | 用例数 | 评价 |
|---|---|---|
| `geometry/xmlModParser.test.ts` | 43 | 最佳 |
| `viewer/xmlModGeometry.test.ts` | 39 | 中：多个断言 `toBeNull()`（MVP 暂停） |
| `geometry/devParser.test.ts` | 31 | 高质量 |
| `gim/__tests__/gimExtractor.test.ts` | 26 | 覆盖纯函数 |
| `geometry/phmParser.test.ts` | 25 | 高质量 |
| `services/modGeometryDiscovery.test.ts` | 19 | 唯一集成测试 |
| `geometry/ir.test.ts` | 18 | 低：类型契约锁，运行时价值小 |
| `viewer/xmlModLoader.test.ts` | 14 | 中 |
| `services/gimIndexRoundTrip.test.ts` | 4 | 缓存往返 |
| `services/substationGeometrySeed.test.ts` | 2 | 薄 |
| `gim/__tests__/cbmParser.test.ts` | 1 | **严重不足**：435 行核心解析器仅 1 用例 |

Rust 后端：`db.rs` 仅 4 个 `#[test]`（全在 `query_reachable_geometry`），其余命令无测试。

### 4.2 关键覆盖缺口（按严重度）

**严重（管线入口/核心编排，零覆盖）**

| 模块 | 行数 | 风险 |
|---|---|---|
| [openGimService.ts](file:///d:/vibe-coding/gim_viewer/src/services/openGimService.ts) | 945 | 主编排器，37 处动态 import，两条恢复路径均未验证 |
| [database.ts](file:///d:/vibe-coding/gim_viewer/src/desktop/database.ts) | 855 | 整个 DB 调用包装层零覆盖 |
| [bootstrap.ts](file:///d:/vibe-coding/gim_viewer/src/app/bootstrap.ts) | 175 | 顶层装配零覆盖 |

**高（大体积/线路工程/坐标安全，零覆盖）**

| 模块 | 行数 | 风险 |
|---|---|---|
| [lineMapView.ts](file:///d:/vibe-coding/gim_viewer/src/ui/lineMapView.ts) | 1301 | 线路工程渲染主模块 |
| [modAutoLoadService.ts](file:///d:/vibe-coding/gim_viewer/src/services/modAutoLoadService.ts) | 989 | MOD/STL 自动加载 |
| [lineProjectView.ts](file:///d:/vibe-coding/gim_viewer/src/ui/lineProjectView.ts) | 932 | 线路工程 UI |
| [lineSpanGroupingAuditService.ts](file:///d:/vibe-coding/gim_viewer/src/services/lineSpanGroupingAuditService.ts) | 879 | 跨塔分组审计 |
| [lineMapData.ts](file:///d:/vibe-coding/gim_viewer/src/gim/lineMapData.ts) | 631 | 线路数据提取 |
| [nodeInteractionService.ts](file:///d:/vibe-coding/gim_viewer/src/services/nodeInteractionService.ts) | 660 | 节点点击懒加载枢纽 |
| [lineGeometryAuditService.ts](file:///d:/vibe-coding/gim_viewer/src/services/lineGeometryAuditService.ts) | 436 | 线路几何审计 |
| [coordinateAlignmentService.ts](file:///d:/vibe-coding/gim_viewer/src/services/coordinateAlignmentService.ts) | 181 | **坐标变换正确性对渲染对齐是安全攸关的** |
| [cbmParser.ts](file:///d:/vibe-coding/gim_viewer/src/gim/cbmParser.ts) | 435 | 仅 1 用例，核心解析器 |
| [lineCbmParser.ts](file:///d:/vibe-coding/gim_viewer/src/gim/lineCbmParser.ts) | 301 | 线路 CBM 解析零覆盖 |

线路工程整条解析链（`lineCbmParser`/`lineMapData`/`lineDevParser`/`lineFamParser`）**全部无测试**，只有变电站路径有测试。

### 4.3 测试基础设施问题

1. **无 .gim 二进制 fixture**：`demo/` 目录有 3 个 .gim 文件但未被测试引用，解压/头部解析这条最易出错的 I/O 路径仅靠手工构造 buffer 验证。
2. **CI 不跑测试**：[.github/workflows/ci.yml](file:///d:/vibe-coding/gim_viewer/.github/workflows/ci.yml) 只执行 `npm run build` + `cargo check`，**不执行 `npm test` 也不执行 `cargo test`**，测试回归无门禁。
3. **Rust 测试与 JS 测试割裂**：`npm test` 不跑 `cargo test`，无桥接，容易漂移。
4. `ir.test.ts`（18 用例）多为类型契约锁，运行时价值小，膨胀用例数。

---

## 五、实现与研究结论一致性

### 5.1 一致项（无问题）

- **几何 IR schema**：`src/gim/geometry/ir.ts` 的 5 种 `GimGeometrySource` kind、`NoneGeometrySource` reason 枚举、primitive 14 类强类型与 `docs/schema/13-geometry-ir-schema.md` 一一对应。
- **变换链**：`coordinateAlignmentService.ts` 遵循 `docs/schema/09-transform-chain-analysis.md` 的变换顺序（Entity local → placement → projectSourceToViewer），mm→m 缩放直接烘焙到顶点。
- **MOD mergeGeometries**：`xmlModLoader.ts` 采用 mergeGeometries 静态合并方案，按 Material 分组，失败回退到独立 Mesh + 诊断日志，与 project_memory.md 一致。
- **CBM F3 命名**：`cbmParser.ts` 实现了方案 B（F4 反推），占位符过滤规则与文档一致。
- **悬链线后置**：`lineMapView.ts` 线路导线为直线段（moveTo/lineTo），悬链线未实现，符合 M5 后置约束。
- **SQLite 表结构**：`db.rs` 表定义与 AGENTS.md 描述一致，`PARSER_VERSION` 失效机制正确。
- **MapLibre/OSM 底图**：遵循 project_memory.md 硬约束（OSM online 为主、CSP 允许 tile.openstreetmap.org）。

### 5.2 不一致项

无。当前实现与研究结论高度吻合。

---

## 六、优先建议（不改代码，仅作建议）

按投入产出比排序：

| 优先级 | 建议 | 投入 | 收益 |
|---|---|---|---|
| P0 | **CI 加入 `npm test` + `cargo test`** | 极小 | 测试回归有门禁，防止漂移 |
| P0 | **给 `coordinateAlignmentService.ts` 补单测** | 中 | 坐标变换是渲染对齐安全攸关路径 |
| P1 | **给 `cbmParser.ts` 补测试**（当前仅 1 用例） | 中 | 核心解析器，435 行 |
| P1 | **拆分 `db.rs`** 为 schema/commands/geometry/pathutil 模块 | 大 | 削减 ~40% 重复代码 |
| P1 | **收敛 `openGimWithDialog`**：缓存命中分支、解压回退分支抽成独立可测函数 | 中 | 减少 37 处动态 import 散布 |
| P2 | **引入 Rust 结构化错误类型**（thiserror） | 中 | 前端可按类型匹配错误 |
| P2 | **线路工程解析链补测** | 大 | 当前仅变电站路径有测试 |
| P3 | **正式 migration 框架**（refinery / sqlx-migrate） | 中 | 非加性 schema 变更不再脆弱 |
