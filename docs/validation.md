# 正确性与验证

本文件维护**正确性门禁、验证边界和证据记录规则**，不重复实现机制或性能数字：

- 当前实现机制见 [架构](architecture.md)；
- 性能 SLO 与实测见 [性能](performance.md)；
- 未关闭缺陷与已接受限制见 [问题与限制](open-issues.md)；
- 样本身份/格式统计见 [样本台账](schema/sample-corpus.md)；
- 未采用的性能路线见 [探索记录](impl/explorations.md)。

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

当前已覆盖：

- 变电四站冷/暖打开、选择隔离、L2 精化、空间语义与严格 SQLite/几何链；
- 设备样本的源/派生冷开与缓存重开、树/属性/选择、设备→线路→设备切换；
- 线路六包地图、导航、搜索和导出；
- 零 GUID、坏矩阵、异常范围、坏缓存与迟到结果的隔离路径。

未覆盖：设备全库逐个人工显示、大条目设备库性能/内存、全部样本三次冷暖矩阵、自动 L1 与增量连接线的完整组合边界。具体未关闭项见 [问题与限制](open-issues.md)。

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
