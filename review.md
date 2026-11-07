# GIM Viewer 架构评审（复核 v3）

> 复核对象：`8c943be`「会话守卫、python门禁、UI业务依赖、内联样式、移除无用依赖、覆盖率、FAM语义、导航投影」（上一轮 `17791da`）
> 复核日期：2026-11-07
> 复核方式：重跑测试/覆盖率/静态检查 + 逐项对照源码 + 导入图度量
> 正文只保留**仍然存在**的问题；本轮关闭项见附录 A。

**项目约定（不作为缺陷）**：

- 工程测试集、对照基线和复跑环境由开发者自行构建；远程 CI 只运行不依赖工程样本的单元测试、静态检查和构建。
- `docs/performance.md` 只代表作者在所述机器、构建和私有样本上的结果。
- SQLite 物理 schema 在首次正式发布前固定 v1；结构变更由开发者删库重建。

---

## 1. 复核结论

上一轮遗留 8 项（旧 R1–R8）中 **6 项关闭、1 项转登记、1 项部分关闭**；本轮新增 1 项。下表左列沿用上一轮编号，§2 按当前问题重新编号。

| 状态 | 数量 | 条目 |
|---|---:|---|
| 已关闭 | 6 | 旧 R2 Python 门禁、旧 R3 UI 业务依赖、旧 R4 内联样式/CSP、旧 R5 无用依赖、旧 R6 FAM 语义、旧 R7 覆盖率门禁 |
| 转登记（非缺陷） | 1 | 旧 R1 会话守卫：谓词已统一，`SessionScope` 列入 SDK 阶段（`lifecycle.md` 已记录） |
| 部分关闭 | 1 | 旧 R8 UI 集中度：导航树已抽离，两个线路视图仍在 |
| 本轮新增 | 1 | 覆盖率门禁间歇失败 |
| **仍存在** | **2** | **R1、R2（见 §2）** |

复核实测：

| 检查 | 结果 |
|---|---|
| `npm test` | 167 文件 / **1439 通过** / 3 跳过 / 103.8 s |
| `npm run test:coverage` | 3 次运行 **2 次通过、1 次失败**（见 §2 R2）；全局语句 72.41% |
| `npm run lint` | 通过 |
| `check:engineering-boundaries` | 通过；286 模块 / 397 类型边 / 203 动态边 |
| `check:caches` / `check-engineering-docs` / `check-engineering-catalog` | 通过 |
| `cargo test --lib` | 32 通过 / 1 ignored（CI 已执行） |
| Python `test_pure.py` ×3 | 9 个用例全部通过（CI 已按文件名执行） |

本轮关键变化：

| 指标 | 17791da | 8c943be | 说明 |
|---|---:|---:|---|
| `ui/lineNavigationTreeView.ts` | 1,535 行 | **139 行** | 投影抽到 `services/lineNavigationProjection.ts`（1,515 行，无 DOM） |
| `ui/` 生产代码 | 10,190 行 | **8,705 行** | 29 文件 |
| `services/` | 112 模块 / 21.2k 行 | **115 模块 / 23.1k 行** | 新增导航投影与地图投影 |
| UI → gim/viewer 值导入 | 10 处 | **4 处，全部在白名单** | 脚本逐符号校验 |
| 覆盖率门禁 | 阈值全 0 | **engineering 95/95/95/90、gim 90/90/90/80** | CI 执行 `test:coverage` |
| 未使用依赖 | `@tauri-apps/plugin-dialog` | **已移除** | 0 引用 |
| `AppState` | 509 行 / 81 字段 | 507 行 / 81 字段 | 谓词改为 `shared/projectSession` |
| 手工会话守卫 | 229 处 | 229 处 | 设计选择，已登记为 SDK 阶段工作 |

---

## 2. 仍存在的问题

> 当前工作区复核：以下 R1、R2 已完成整改，原评审描述保留作问题依据。R1 将线路属性分桶/来源关系/HNum 预览移入纯 `lineInspectorProjection`、字典格式化移入 `propertyPresentation`、地图坐标工作集及导线语义移入 `lineMapGeometry`；线路视图提供代次保护的销毁句柄，回收搜索、地图、导航、设置监听和异步创建。纯投影无 DOM 测试与边界检查通过，旧句柄不能销毁新视图。R2 为 runtime fixture 统一释放、清理定时器，运行时在访问相机前检查上下文，释放后不再调度；迟到回调、上下文销毁和重复释放回归通过。完整 `test:coverage`：172 文件、1456 通过、3 跳过，exit 0，无 unhandled error；本轮不以文件行数下降或重复重跑次数代替缺陷回归。

### R1 [P3] 两个线路视图仍各约 1,800 行（原 R8）

**已解决的部分**：`lineNavigationTreeView` 从 1,535 行降到 139 行，数据装配抽到 `services/lineNavigationProjection.ts`（1,515 行，无 DOM/AppState/平台 IO，配套 `lineNavigationProjection.test.ts` + fixture）。这正是上一轮建议的拆分方式，且已写入 `layers.md`。

**仍存在**：

| 文件 | 行数 |
|---|---:|
| `ui/lineProjectView.ts` | 1,800 |
| `ui/lineMapView.ts` | 1,801 |
| `ui/propsDrawer.ts` | 1,111 |

三者合计 4,712 行，占 `ui/` 8,705 行的 54%。`lineMapView` 有 `destroy()` 句柄，`lineProjectView` 没有同等的资源边界。

**影响**：线路属性/预览与地图绘制仍难以在无 DOM 环境测试；这两个文件也是 Validate 与地图扩展最可能改动的地方。

**建议**：沿用导航树的拆分方式——先把纯投影（属性分桶、预览几何、地图数据）移到 `services/`，UI 只保留渲染与事件；`propsDrawer` 的渲染函数也可先抽成纯字符串函数做快照测试。

### R2 [P2] 覆盖率门禁间歇性失败（本轮新增）

**事实**：CI 现在用 `npm run test:coverage` 作为唯一前端测试步骤。本机连续运行 3 次：

| 次 | 结果 | 说明 |
|---|---|---|
| 1 | **失败（exit 1）** | 测试全部通过，但报 3 个 unhandled error，堆栈指向 `services/devLodRuntime.ts:477` 的 200 ms 定时器 |
| 2 | 通过（exit 0） | 无错误 |
| 3 | 通过（exit 0） | 无错误 |

错误形态：`devLodRuntime` 的 `schedule()` 定时器在测试文件结束后触发，`update()` 通过 `current()` 后访问已被拆除的 `this.ctx.world.camera`（`devLodRuntime.ts:483`）。覆盖率插桩使运行变慢，放大了这个窗口；不带覆盖率的 `npm test` 未复现。

**影响**：CI 会在代码无回归时随机变红；作为唯一测试门禁，间歇失败会迅速降低门禁可信度。

**建议**：

1. 测试侧：为创建 runtime 的 fixture 统一加 `afterEach(() => runtime.release())`，并在 `vi.useRealTimers()` 前 `vi.clearAllTimers()`；
2. 实现侧：`update()` 在读取 `ctx.world` 前校验渲染上下文仍可用（或让 `release()` 置空 ctx 引用），使迟到定时器成为无操作而不是抛错。

---

## 3. 架构约束（不是缺陷，但影响下一阶段）

1. **单 OS 进程内的 Worker 并行**：DEV/PHM/MOD 解析、primitive→Geometry、CSG、GLTF 导出在 `devGeometryWorker` 池（`max(2, min(memoryCap, floor(cores*0.6)))`，最多 8）；IFC 转换/区域/精细/Spatial 各有 Worker。常规路径下主线程只做 GLB 恢复、模板实例化、场景提交与 scoped raw fallback；缓存恢复与目录 bounds 在依赖未注入时会回退主线程。代价是共享进程地址空间，但进程隔离不减少总内存且增加 IPC/Android 成本——先测量、后决策。
2. **Rust 只做 IO/解压/SQLite/语义索引**：跨端复用边界清晰，Android 无法直接复用桌面几何编译。
3. **测试集本地化**：CI 只能验证代码契约；"工程可用"必须由开发者本地样本复跑。
4. **SQLite schema 固定 v1**：结构变更即删库重建，升级路径不可回退。
5. **会话守卫以显式调用为主**：`isCurrentProject` / `isCurrentGeometry` 已统一到 `shared/projectSession.ts`，几何上下文已改为委托；229 处提交前守卫保留为当前设计，`SessionScope` 抽取列入 SDK 阶段（`docs/architecture/lifecycle.md` 已登记）。

---

## 4. 复核方法与证据

```powershell
cd desktop
npm test                                         # 167 文件 / 1439 通过 / 3 跳过 / 103.8 s
npm run test:coverage                            # 3 次：2 通过，1 次 3 个 unhandled error
npm run lint                                     # 通过
node scripts/check-engineering-boundaries.mjs    # 通过（286 模块 / 397 类型边 / 203 动态边）
node scripts/check-cache-contracts.mjs           # 通过
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked   # 32 通过 / 1 ignored

cd ../tools
python -m unittest discover -s gim_info/tests -p 'test_pure.py'     # 3 passed
python -m unittest discover -s gim_element/tests -p 'test_pure.py'  # 3 passed
python -m unittest discover -s gim_device/tests -p 'test_pure.py'   # 3 passed
```

导入图：`research/scripts/import-graph.mjs`（仓库根运行，297 模块 / 1,255 条边；`AppState` fan-in 61）。

R2 的失败样本（第一次运行）关键行：

```text
Test Files  167 passed (167)
Tests  1439 passed | 3 skipped (1442)
Errors  3 errors
❯ Timeout._onTimeout src/services/devLodRuntime.ts:477:61
❯ 483| const camera = (this.ctx.world.camera as any).three as THREE.Camera;
[exit code: 1]
```

---

## 附录 A：已关闭项

### 本轮（8c943be）关闭

| 上一轮 ID | 问题 | 关闭证据 |
|---|---|---|
| 旧 R2 | Python 工具链无门禁 | `tools-ci.yml` 按文件名执行 `test_pure.py`；三个工具各 3 个纯逻辑契约用例，本机全部通过；`docs/validation.md` 记录为何不用无过滤 discover |
| 旧 R3 | UI 值依赖 gim/viewer | `check-engineering-boundaries.mjs` 新增 `uiPresentationValues` 白名单，逐符号校验；剩余 4 处均为展示选择器/格式化函数；`layers.md` 明确"新增纯函数不自动获得 UI 导入权限" |
| 旧 R4 | 内联样式 / CSP | HTML `style=` 已清零（2 处改 class）；CSP 保留 `unsafe-inline` 的原因登记为 `open-issues` L-13（CSSOM `cssText`、第三方视图、SLD SVG 需逐项验证），属已接受限制 |
| 旧 R5 | 未使用依赖 | `@tauri-apps/plugin-dialog` 已从 `package.json` 移除，全仓 0 引用 |
| 旧 R6 | FAM 段语义无契约 | `docs/schema/semantic-model.md` 新增两域投影对照表（三段/多段/两段 × 变电/线路），并补 `famParser.test.ts` 用例 |
| 旧 R7 | 覆盖率与 Python 门禁空白 | `vitest.config.ts` 设置 `engineering/` 95/95/95/90、`gim/` 90/90/90/80；CI 改为执行 `npm run test:coverage` |

### 上一轮（17791da）关闭

13 项（A2 A3 B1 B3 B4 B5 C2 C3 C4 C5 D1 D2 D3）的关闭证据见仓库根 `review.md`（v2 版），此处不重复。

### 转登记

| 上一轮 ID | 处理 |
|---|---|
| 旧 R1 会话守卫 | 谓词统一为 `isCurrentProject` / `isCurrentGeometry`，`modGeometryContracts` 改为委托；`lifecycle.md` 记录"显式守卫保留、SessionScope 随 SDK 抽取"。不再作为缺陷，转为 §3 第 5 条约束 |

---

## 附录 B：对原报告的更正

1. **"没有任何提交点因 token 变化而拒绝"不成立。** `cf6e196` 时 `isGeometryTokenValid` 已存在并被几何路径使用；准确表述是"`isCurrentSession` 不含 token，几何路径另有一套守卫"。
2. **Android "必失败"撤回。** 原推断未经运行验证；本轮已统一 `normalize_entry_key`。
3. **性能/内存归因撤回。** 静态代码不能证明 21 s / 7.5 GiB 与单进程拓扑的因果关系；只保留结构事实（§3 第 1 条）。
4. **"验证资产不可复现"撤销。** 测试集自建、CI 不跑样本是项目约定。
