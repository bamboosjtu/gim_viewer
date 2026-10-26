# 正确性与验证

本文件维护**正确性门禁、验证边界和证据记录规则**，不重复实现机制或性能数字：

- 当前实现机制见 [架构](architecture.md)；
- 性能 SLO 与实测见 [性能](performance.md)；
- 未关闭缺陷与已接受限制见 [问题与限制](open-issues.md)；
- 样本身份/格式统计见 [样本台账](schema/sample-corpus.md)；
- 已回退与未采用路线见 [探索记录](impl/explorations.md)。

保留本文件的理由：它定义“什么算通过”和“证据能证明到哪”，与性能、架构文档不可互相替代。

## 1. 证据边界

源包事实、当前源码、自动测试、真实桌面/移动交互是不同证据层：

| 证据 | 能证明 | 不能证明 |
|---|---|---|
| 源包 SHA/清单/解包 | 输入身份、条目与引用存在 | 场景可达、渲染正确 |
| 单元/集成测试 | 代码契约、边界与竞态 | 真实 WebView、GPU、完整样本 |
| 真实桌面交互 | 当前构建的打开、选择、缓存、坐标 | 其他机器/其他包、长期稳定性 |
| 性能计时 | 指定输入/构件的耗时 | 不同工作量或不同构建的“提速” |

同一结论必须注明输入身份、构建、缓存状态与操作路径；不能用不同构建或不同工作量的成功结果互相替代。

## 2. 必须成立的不变量

| 主题 | 检查要求 |
|---|---|
| 源身份 | magic 决定类型；源改变拒绝继续；源 SHA 与缓存一致 |
| 路径 | 大小写、分隔符兼容；全局 resolver；唯一候选才挂接 |
| FAM | 原文/行号可追溯；重复行不丢；单值视图与原记录分离 |
| PARTINDEX | 按 DEV 身份关联；限制父装配子树；歧义保留；不增加 seed |
| 递归装配 | PHM→PHM 可达；逐边矩阵；分支防环；合法重复路径保留 |
| 模板共享 | clean DEV 解析数接近 unique DEV；placement 不修改共享 geometry |
| 变换 | 非单位阵、旋转、缩放、镜像与深层路径保持；单位/轴转换只应用一次 |
| 缓存几何 | 冷/暖/raw fallback 同引用语义；坏 GLB 局部回退；失败不写完整标记 |
| IFC 顺序 | 首个 anchor 一致；模型数量、GUID 与 IFC/MOD 相对位置一致 |
| Spatial | hit 不重扫 STEP；坏 snapshot 拒绝；nodes/objects/links/placement/source 等价 |
| 选择 | 慢 A/快 B 后属性、高亮、相机、树全部属于 B；重复 B 不新增 occurrence |
| 视角历史 | 返回前结算待记录移动；失败保留历史；代次拒绝旧完成；取消后不跳回旧目的地 |
| 静态容器 | 每帧不重算静态子树；动态对象、重挂载与显式锚点更新仍传播世界矩阵 |
| 缓存视图 | 借用视图只在同一次同步解包内；返回缓冲独立、偏移为 0，不引用相邻条目 |
| 工程切换 | A 未完成时切 B：A 的 worker、slice、恢复结果不提交 B |
| 线路图 | 唯一路径节点与引用边分开；共享边界塔不丢；同塔跳线不当跨塔档 |
| 安全 | SLD 禁执行/外部资源；解压配额；异常局部来源隔离 |

## 3. 自动验证

```powershell
cd desktop
npm test                 # 快速单元测试（不启动 Cargo）
npm run test:sqlite      # 真实 SQLite 集成：构建一次，直接运行 harness
npm run test:sample      # 真实样本回归（缺样本时可跳过，skip 不算通过）
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

SQLite 集成测试独立于单元测试和样本回归，Windows CI 必须单独执行 `test:sqlite`。准备阶段最多 10 分钟，通过 Cargo JSON 产物消息取得本次测试程序；每次 SQLite 执行最多 30 秒，外层测试最多 60 秒。输入、输出和临时 SQLite 文件位于已忽略的 `desktop/.tmp-vitest/sqlite/`，每次调用独立目录，进程退出后清理。

按改动选择更窄的门禁：

- IFC 加载/转换：`npm run test:ifc-critical`；
- 静态容器矩阵：`src/viewer/__tests__/staticContainer.test.ts`；
- 视角历史：`src/viewer/__tests__/viewHistory.test.ts` 与 `src/ui/__tests__/viewHistoryFeedback.test.ts`；
- 原生批读/GIMR 协议：`bridge/__tests__/devLodCache.test.ts`、`devLodNativeBatch.test.ts`、`database.test.ts`；
- DEV 几何/缓存/选择：`devGeometryWorkerClient`、`devLodRuntime`、`devGlbTemplateRuntime`、`xmlModGeometry` 对应测试；
- 真实几何门禁：`GIM_VERIFY_SUBSTATION01=1` 后运行 `devGeometryGate.test.ts --maxWorkers=1 --minWorkers=1`；
- 严格变电样本：`GIM_REQUIRE_SUBSTATION04=1 npm run test:substation:strict`，缺样本必须失败，不能 skip 通过。

样本解包（只读检查前置）：

```powershell
python desktop/scripts/gim_survey/extract_inventory.py --samples demo-substation substation02 substation03 substation04 --extract-only
```

## 4. 真实桌面复核

固定提交、源 SHA、EXE/资产哈希、WebView 环境和缓存初始状态，通过生产入口操作，不暂停解析/编译。

变电至少覆盖：

- 一个物理根、PARTINDEX、嵌套装配、IFC 关联对象的来源/属性/高亮/相机终态；
- A→B、重复 B、搜索、关闭、同进程重开；
- 冷/暖的根数、unique DEV、occurrence、几何状态、IFC 顺序与空间索引；
- 默认显示不先点树，覆盖已知/未知范围、视野内外、选择/取消、远近切换、失败重试、坏缓存局部修复。

线路至少覆盖：六包根/F2/F3、共享塔位、WIRE/CROSS、塔形预览、搜索、树↔图、缺文件降级；原属性长度与几何长度分列。

性能验收必须同时记录 First usable / Current view settled / 基础表示完成 三个 SLO，不能只报首屏；浏览器开发模式与 Release/WebView2 结果分开报告。

### 2026-10-25 原生 Release 复核（诊断导出、选择隔离、精化与严格链）

构建与状态：便携包 `GIM-Reader.exe`（`b414a59` 加当时工作树，不能视为该提交的干净构建），同一 Fixed WebView2 155.0.4283.62、同一应用数据目录与 WebView profile；窗口移出屏幕但不最小化，通过 CDP 驱动真实 WebView，状态从 `__gimAppState`、`#status-*` 与属性抽屉读取。测量期间未暂停解析/编译；同机另有一个长任务进程运行，计时只用于判断“是否等待全站转换”，不作为 SLO。

- **诊断导出**：打开 substation03 后台加载 3 s 后触发 Ctrl+Shift+D。导出耗时 563 ms；`databaseDiagnosticScope=active-project`、`substationCapabilitiesStatus=not-collected`、`diagnosticReadErrors` 为空；触发时 IFC 仅 2/8，导出不等待全站转换，也未触发能力摘要重扫。导出前后 DEV 缓存批读计数 5→6，该增量与后台 DEV 启动同时发生；导出只读取 SQLite/内存状态。拒绝剪贴板写权限后再次导出，界面显示“诊断失败: … Write permission denied”，未挂起；成功提示可能被后台 IFC 进度提前隐藏（采样中约 0.6 s），失败提示保持可见。导出期间关闭工程：选择、DEV runtime、IFC 模型均清零，状态栏回到“就绪”，迟到结果被会话守卫拒绝。
- **选择隔离**：搜索选择 DEV“主变有载调压设备”后“仅看选中”，可见 DEV 组 1/285，恢复后 285/285；在隔离状态下直接点击视口中心，DEV 射线回退（新增非实例化 placement 拾取）选中同一 occurrence 并保持 1/285，说明 DEV 视口拾取可用。IFC 视口拾取构件后“仅看选中”：其他 IFC 源的 runtime 根与 model 对象均不可见，DEV 只保留 1 个可见组，恢复后全部 IFC 根/模型与 285/285 DEV 组可见；DEV 选择时 12 个 IFC 源根/模型全部隐藏。关闭工程后两者均为 0。DEV L2 在“查看精细模型/取消精化/完成/返回浏览”四个阶段浮层始终隐藏，抽屉状态依次为“正在生成…/已返回浏览表示/精细模型已显示/已返回浏览表示”，状态栏在选择名与“· 精细模型”之间切换。
- **选择反馈**：普通 DEV/IFC 选择、快速跨模型两次 IFC 拾取、拾取后立即关闭，均未出现工程加载浮层；选择状态只更新 `#status-selection`，精化进度只更新属性抽屉，不改写工程打开进度。
- **严格链**：接入 `sqliteGlobalSetup` 后，Cargo harness 0.7–7.4 s 构建并注入。初次运行发现 `STRICT substation02` 在单个 DEV 模板序列化阶段持续 >40 min CPU、无 I/O 增长；定位为测试调用 `serializeDevToGlbDetailed` 时未指定 LOD，默认走 L2 精确 CSG（该 MOD 含 300+ Boolean）。严格链改为验证浏览表示 L0 轮廓，并把源级 raw 回退的 MOD 加载对齐到同一 L0 + placement 过滤；随后 `npm run test:substation:strict` 的 4 个样本全部通过（约 147 s），所需 substation01/02/03 零 skip 通过。L2 CSG 长尾仍属 L-03，不由本链覆盖。

- **冷转换预览隔离**：仅清除 WebView 的 IFC LOD IndexedDB 后重开 substation01，IFC 重新冷转换。检测到第一批预览网格后立即选中 DEV“开关柜”并“仅看选中”：此时预览根 5 个子组、629 个网格（`连接构件 445 个 · 增量加载中`、IFC 3/12 冷转换中）全部不可见（0/629），DEV 组 0/285，IFC 仍在 3/12 冷转换。随后权威模型替换预览组，最终 12/12 加载、`连接构件 1159 个`。说明连接线预览批次未完成时不会在隔离范围外保留可见网格。

- **500-B1-1 冷暖隔离验收**：验收构建 `profile=native-release-acceptance`、独立 identifier，源指纹 `7d407effd680…`（源码 `b414a59` + 工作树）。通过 `upsert_gim_project` 登记 `500-B1-1 三维设计.gim` 后从最近工程打开，未使用文件对话框。冷启动两次（每次重置验收数据）基础表示 213.6/232.2 s，IFC 24/24 于 102.3/101.2 s；DEV 进度从 0 连续推进到 11,250，未出现 `0/0` 长期停留。第二次冷启动缓存累计 5,235 次写入、0 失败，并在关闭前 `cacheWritePendingCount=0`。重启同一构建与 profile 暖启动两次：基础表示 17.98/18.75 s、IFC 24/24 32.8/33.6 s，L0 命中 2617、L1 1、冷编译 0、待写 0、失败 0。验收数据位于独立 `%APPDATA%\com.bamboosjtu.gimviewer.acceptance` 根，未读写日常缓存；本轮未取得进程内存峰值。
- **substation03 首对象与完整源长尾**：清除 IFC LOD IndexedDB 后重新转换，诊断 span 显示大源 `CBM/设备接线.ifc` 首批连接预览 14.96 s、预览 settled 30.57 s（272 个对象）；8/8 个 IFC 转换状态于 72.6 s 到齐，但 420 s 内 `IFC 已结束` 未出现，权威 Fragments 模型仅 1/8 就绪，272 个预览对象（约 297 MB）仍由预览承载。首对象提前与完整源长尾同时存在。

上述复核覆盖了部分选择/精化操作，但当时工作树的 IFC 拾取跳过可见性查询，未覆盖自动 L1 替换掩码。该捷径现已撤回；O-05 保持待边界验收，不能由上述局部操作关闭。O-07 仍缺少属性概览 DOM 的 p95 与高亮 ≤100 ms 验收。

### 2026-10-26 指定提交与最终候选对照

基线分别为 `7b4d0fc4b8cf9a55e8383a6aad469cc9d989c38d`、`b414a59268ae5a52b61f218a7d6d16b48247cdf5` 的独立 checkout，构建后规范化源码差异为空。最终候选指纹 `f1e187e2b132908839877e24ee5d3166f6cf49baa0e0cecff651630b26019173`；三组实际使用同一份 Fixed WebView2 155.0.4283.62、独立验收数据和兼容缓存，提交标记、EXE、样本 SHA 与实际数据库根逐项核对。

- 执行 33 次暖恢复，正式对照采用 27 次：substation01/B1 每构建三次，其他三站每构建一次；3、4 号站因首轮各有一组新增 L1 编译而补测全命中。选入的运行均语义命中、L0/L1 冷编译 0、全部 IFC 命中、DEV 缓存写入 settled、正常退出。
- 最终候选另做 substation02/03 原生真冷准备，分别全部 IFC 17/17、8/8 完成，L0 与 IFC 缓存命中 0；substation02 保留 34 个 DEV 失败、561 个空源和 807 个未知范围，不作为完整成功。
- 每构建固定十点重复点击 20 次，18 次有效 IFC 命中身份序列一致，无新增 L2；候选点击至 RAF p95 427 ms，对照 487.1/491.9 ms。不是 20 个独立来源或 GPU 呈现验收，O-07 仍未通过。
- 最终候选相关现有 49 项用例再次通过；完整 1122 项及严格四站 SQLite 链通过于撤回临时选择细分埋点之前。没有新增测试文件。严格链本机需将进程级 TEMP/TMP/SQLITE_TMPDIR 指向工作区临时目录；系统临时目录的 SQLite 打开失败日志保留，没有修改断言吞错。
- O-05 仍待完整组合边界；O-10 跟踪异步缓存回调覆盖 IFC 结束文字。辅助 B1 冷记录的驱动文本等待超时不等于模型加载超时，具体时刻和边界见[性能基线](performance.md)。

原始数据、源码与缓存审计见 `output/review-open-issues/final-audit.json`、`formal-environment.json` 和 `native/`；保留判定见[本轮评审报告](impl/test-performance-regression-rollback.md)。

## 5. 移动端验证

在 `app/` 运行 `npm test`、`npm run build`；样本测试先准备本地输入，缺包不允许 skip。覆盖唯一对象、共享塔 occurrence、物理档聚合、跳线排除、完整树可达、原始属性与 HNum 预览、JSON 恢复等价。

原生存储门禁：

```powershell
cargo test --manifest-path crates/gim-native-core/Cargo.toml
cargo test --manifest-path app/src-tauri/Cargo.toml --lib
cargo test --manifest-path app/src-tauri/Cargo.toml six_native_imports -- --ignored --nocapture
```

最后一条必须实际执行并报告零 skip。Android 还需在指定 API/WebView/设备上验证 SAF 导入、权限/定位拒绝、折叠屏与沉浸模式；模拟器数据不能替代真机性能承诺。

## 6. 证据记录

每个结果记录：输入身份、构建/提交、命令或操作、通过/失败/跳过数、环境、输出位置和边界。截图只证明可见状态；结束码、JSON 可解析、缓存命中或阶段完成都不能单独证明语义正确。

不得：

- 把 skip 计入通过；
- 把旧构建的结论用于当前构建；
- 用自动居中/整体偏移掩盖坐标问题；
- 用 draw calls 降低代替对象覆盖/坐标验证；
- 把 Worker 墙钟当 CPU 时间，或把工作量变化当单模板提速。

可重复运行材料独立保存，不追加为正文流水。
