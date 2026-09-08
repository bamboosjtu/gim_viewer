# Powerline Runtime v1 复核报告

日期：2026-09-08
范围：当前 `bamboosjtu/gim_viewer` HEAD 的 Shared Core、Powerline Runtime 路由与线路 v1 业务基线。
明确不在范围内：Substation 性能优化、Line Parser 算法改写、线路地图改写、IFC 并发/Worker、Fragments 策略和 DEV GLB/MOD/STL 优化。

## 结论

Powerline Runtime v1 可以封板：**YES**。

这个结论基于 TypeScript/生产构建、完整单元测试、六套真实线路样本和现有 warm/SQLite 语义回归均通过，且没有发现 P0 或阻断线路 v1 使用的 P1。

本机没有 `cargo`、`rustc`、`rustup`，因此 Rust 编译检查和真实 Tauri cold/warm smoke 未执行；这不是测试失败，但必须在有 Rust toolchain 的 CI/发布机上补跑 architecture acceptance gate。

## Before / After 数据流

### Before

```text
sha256
  -> cache validation
  -> cache hit / miss
  -> extraction
  -> detect project type
  -> line / substation branch
```

旧路径允许缓存行中的 `project_type` 影响缓存域判断，工程类型也在解压之后才完整参与路由。

### After

```mermaid
flowchart LR
    source["GIM source"] --> inspect["inspect head / SHA / magic"]
    inspect --> identity["source identity + runtime type"]
    identity --> cleanup["cleanup + ProjectLoadSession"]
    cleanup --> dispatch{"runtime dispatch"}

    dispatch -->|"GIMPKGT / transmission_line"| line["Powerline Runtime"]
    dispatch -->|"GIMPKGS / substation"| sub["Substation Runtime"]

    line --> lineCache["line cache validation"]
    lineCache --> semantic["semantic pack / SQLite warm"]
    lineCache --> cold["cold extraction + Line Parser Worker"]
    semantic --> graph["GimGraph + FAM/DEV"]
    cold --> graph
    graph --> lineUi["tree / search / map / source"]

    sub --> subCache["substation cache validation"]
    subCache --> subSemantic["CBM / FAM / DEV / FileDevRelation"]
    subSemantic --> subUi["IFC / Fragments / DEV geometry / tree / 3D"]
```

`GIMPKGT` 选择 `transmission_line`，`GIMPKGS` 选择 `substation`。缓存中的 `project_type` 只用于诊断，不能替代 source identity。`hybrid` 仍是异常/诊断状态，不新增 Runtime。

## Acceptance gate

| Evidence | Finding | Path |
| --- | --- | --- |
| `tsc --noEmit`、Vite production build | TypeScript 与生产前端构建通过；Vite 仅报告已有的大 chunk/dynamic-import 警告 | `desktop/` build scripts |
| `read_file_head` bridge 与 Rust command 参数静态核对 | TS `{ path, maxBytes }` 与 Rust command 参数映射一致 | `desktop/bridge/fileReader.ts`、`desktop/src-tauri/src/lib.rs` |
| `validate_gim_cache` bridge 与 Rust 参数静态核对 | TS `expectedProjectType` 与 Rust `expected_project_type` 映射一致；线路/变电 Runtime 分别传入固定期望类型 | `desktop/bridge/database.ts`、`desktop/src-tauri/src/db.rs`、`desktop/src/services/powerlineRuntime.ts`、`desktop/src/services/substationRuntime.ts` |
| `gimSourceService` 单测 | source inspection 与 extraction 观察到不同非空 magic 时抛出 `SOURCE_CHANGED_DURING_OPEN` | `desktop/src/services/gimSourceService.ts`、`desktop/src/services/__tests__/gimSourceService.test.ts` |
| Rust toolchain 探测 | 当前环境没有 `cargo`、`rustc`、`rustup`，未执行 `cargo check` | environment limitation |
| Tauri smoke | 因缺少 Rust/Tauri 可执行环境，line cold/warm、substation cold/warm、line→substation→line 未执行 | environment limitation |

magic 安全修复覆盖 native extraction 和 WASM fallback。原来的 warn-and-continue 行为已改为安全失败，不进入 Runtime，也不把实际解压内容绑定到旧 source identity。解压后的 `detectGimProjectType` 保留，继续承担内容校验、未知 magic fallback 和 mismatch diagnostic。

## Core / Runtime 边界

| 边界 | 责任 | 关键位置 |
| --- | --- | --- |
| Shared Core | source inspection/header、source identity、授权读文件、SHA、extraction、路径归一化、cleanup、`ProjectLoadSession`、perf/diagnostics、SQLite/cache bridge 基础设施 | `desktop/src/services/gimSourceService.ts`、`desktop/src/services/gimOpenCore.ts`、`desktop/src/app/state.ts`、`desktop/src-tauri/src/db.rs`、`desktop/src-tauri/src/gim_extract.rs` |
| Powerline Runtime | line cache validation、semantic pack/SQLite warm、Line Parser Worker、GimGraph、FAM/DEV 属性、线路 tree/search/map/source tracing | `desktop/src/services/powerlineRuntime.ts`、`desktop/src/services/lineParserInput.ts`、`desktop/src/services/lineParserWorker.ts`、`desktop/src/gim/lineCbmParser*.ts`、`desktop/src/gim/lineMapData.ts` |
| Substation Runtime | CBM/FAM/DEV/FileDevRelation、IFC/Fragments、DEV GLB、MOD/STL fallback、变电 tree/3D/UI | `desktop/src/services/substationRuntime.ts` 及其变电解析/viewer/UI 依赖 |

`powerlineRuntime.ts` 不依赖 `substationRuntime.ts`，反向也不成立；两者不共享 Line/Substation domain model。顶层只保留 dispatch boundary 和 Shared Core 编排。

## 六套真实线路样本结果

样本为 `demo-line1`（对应 line01）和 `line02`–`line06`。六套样本均通过：

- F1/F2/F3/F4 层级图构建；主线程冷解析与可序列化 Worker 解析的完整 `stats` 相等。
- FAM/DEV payload 与 Worker cache 解析结果逐项相等，六套 `unmatched=0`。
- Tower/WIRE/CROSS 图统计、塔位坐标、导线端点、包围盒和路径大小写/分隔符兼容性检查。
- map/tree source key 关联、导航索引和 search index 非空；每个地图塔位均能回到树节点 source path。
- 塔号、塔型、呼高、转角字段在每个样本至少有可解析实例；现有属性/来源追踪测试全部通过。

| 样本 | 图总节点 | F1/F2/F3/F4 | `Tower_Device` | `WIRE` | 图 `CROSS` | 地图 tower/wire/cross |
| --- | ---: | --- | ---: | ---: | ---: | --- |
| demo-line1 | 4,998 | 1/2/22/1,072 | 782 | 1,013 | 152 | 40/1,013/19 |
| line02 | 9,276 | 1/1/47/2,405 | 1,701 | 2,232 | 414 | 129/2,232/44 |
| line03 | 7,949 | 1/2/48/1,964 | 1,528 | 1,081 | 772 | 111/1,081/772 |
| line04 | 499 | 1/2/4/148 | 141 | 138 | 16 | 6/138/4 |
| line05 | 5,447 | 1/1/23/1,226 | 855 | 1,154 | 798 | 49/1,154/23 |
| line06 | 978 | 1/2/10/222 | 216 | 198 | 7 | 14/198/10 |

所有地图塔位的坐标均为有限值且包围盒有效，所有地图导线端点均为有限值。样本中的 CROSS 记录普遍没有可用坐标，因此图节点数与地图 CROSS marker 数可以不同；节点仍保留在树和 source tracing 中，这属于数据/语义待研究项，不是本轮发现的解析丢失。

## Findings 分类

### P0 Correctness

**已修复：source magic 在 inspection 与 extraction 之间变化时继续打开。**

- Evidence：原流程只 warning；新增单测覆盖 `GIMPKGT → GIMPKGS`。
- Finding：继续打开会使实际解压内容与 source identity/cache 绑定不一致。
- Path：`assertGimSourceMagicStable()`；失败码 `SOURCE_CHANGED_DURING_OPEN`。

### P1 Product correctness

没有发现阻断线路 v1 使用的 P1。A→B 迟到 Worker、semantic pack 结果、异常结果和 cleanup/session guard 回归均通过。

### P2 Performance / accepted debt

- HNum/MOD lazy preview 长尾。
- warm RSS。
- line03 7z cold decode。
- catenary 进一步研究。
- 更精细的塔形显示。
- CROSS source 没有坐标时的地图定位。

这些问题没有破坏本轮验证的核心业务正确性，未在本轮扩大修改范围。线路首开仍不把大 MOD/STL/HNum 几何放入 critical path。

### Research Unknown

- 不同厂商 CROSS 坐标字段的完整语义和可推导策略。
- 同 magic 文件在 hash/inspection 后、extraction 前被替换时的二次 SHA 校验策略。
- demo-line1 中未被当前引用链消费的部分 MOD 的产品语义。

## Line v1 Baseline

### 稳定能力

- GIMPKGT source routing 到 Powerline Runtime。
- line cache validation、semantic pack warm、SQLite restore 和 cold Line Parser Worker。
- GimGraph、FAM/DEV properties、线路 tree/search/map/source tracing。
- PascalCase/uppercase entity、路径大小写和 `/`、`\\` 分隔符兼容。
- cache 损坏或 semantic pack integrity 失败时不恢复 partial Runtime，而是回退 cold 重建。
- `ProjectLoadSession` 和 `state.isCurrentSession` 保护所有异步结果提交，A→B 迟到结果不能污染 B。

### Correctness invariants

1. source magic 决定 Runtime；缓存存储的 `project_type` 不决定 source routing。
2. inspection/extraction magic 不一致时必须以 `SOURCE_CHANGED_DURING_OPEN` 失败。
3. cold parser、Worker semantic input、warm semantic input 的 graph stats 和 FAM/DEV 业务 payload 相等。
4. 地图塔位必须能关联 graph source path；塔位坐标、导线端点和包围盒必须有效。
5. SQLite fallback 的图、文件类型计数和属性业务形状与 semantic 结果一致。
6. cache integrity 失败不能提交 partial graph/properties。
7. 任何异步 Runtime 结果只能在当前 `ProjectLoadSession` 有效时写入 AppState/UI。

### Cold / warm baseline

| 路径 | 结果 |
| --- | --- |
| 六套真实样本 cold graph + Worker semantic | 6/6 通过，stats 和 FAM/DEV payload 严格相等 |
| semantic warm vs cold | 现有 warm fast-path 回归通过，包含图、导航输入、塔位/导线/跨越物属性 |
| SQLite fallback vs semantic | 现有 restore 回归通过，包含 graph shape、MOD/STL 统计和属性数量 |
| 原生 Tauri cold/warm 时间/RSS | 未测；当前机无 Rust toolchain，不把它伪装成通过 |

### 封板后允许修改的范围

只接受 correctness、安全、真实格式兼容性、cache integrity/version、session/race 修复和真实用户反馈驱动的线路修改。不得以性能优化为理由继续主动重构线路稳定路径；新性能工作应先形成独立基线和可回滚变更。

## Compatibility re-export

`desktop/src/services/__tests__/lineSemanticWarmFastPath.test.ts` 已从 `openGimService` 改为直接引用 `powerlineRuntime` 的 `buildLineSemanticWarmFiles` 和 `commitLineParserResult`；`openGimService` 不再 re-export 线路 Runtime helper。

仍保留的兼容 re-export 是变电侧 `onGimExtracted`、`loadAllIfcFiles`。`projectStateCommitRace.test.ts` 对 `openGimService` 的引用只涉及变电 helper，不是线路 Runtime 依赖；可在后续变电边界清理中处理，不扩大本轮范围。

## 实际执行的验证

```text
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc && node_modules/vite/bin/vite.js build
node node_modules/vitest/vitest.mjs run
node node_modules/vitest/vitest.mjs run --config vitest.sample.config.ts
```

结果：

- 普通套件：60 个文件、676 个测试通过。
- 真实样本套件：6 个文件、34 个测试通过，约 306 秒。
- 相关定向套件：5 个文件、19 个测试通过。
- 样本结构化验证：container、line grammar、reference chain、MOD reachability、STL transform 全部通过；六个线路 `.gim` 均识别为 `GIMPKGT`，引用链无 hard missing。

## 提交

- `6c55b47 fix: fail closed when GIM source changes during open`
- `8626e9e test: baseline powerline runtime across line samples`

提交后工作树干净。未开始 Substation 性能优化。
