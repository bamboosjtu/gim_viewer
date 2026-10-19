# IFC / DEV 分级与加载性能

本文说明桌面端为什么按 IFC LOD0/LOD1/LOD2 与 DEV LOD0/LOD1/LOD2 分级、如何把首屏和近景细节解耦，以及当前性能边界。实测数字见 [性能](../performance.md)，版本对照见 [performance-ledger](../../research/performance-ledger.md)。

## 1. 目标与约束

- 冷启动首屏目标 ≤40 s，暖启动 ≤10 s；大样本不得以牺牲正确性换速度。
- 首屏只要求“可交互”：坐标锚点、首个可用 IFC、CBM 导航与属性可读；剩余 IFC、DEV 模板和空间语义在后台继续。
- 视觉近似必须显式标注；近景细节按需生成，不能把浏览级近似当作测量/施工依据。

## 2. IFC 分级

生产默认 `bim-lod`：

1. **LOD0**：单位、上下文和递归 `LocalPlacement` 解析后提交的粗表示，用于首屏。
2. **LOD1**：同一 Worker 内继续生成的中等表示，仍是全站基础显示。
3. **LOD2**：属性面板按需请求整文件 Fragments，加载更高精度对象；未请求不阻塞首屏。

调度规则：

- 首个可用 IFC 建立坐标锚点，优先完成首屏。
- 剩余 IFC 按源大小排序；单个 >64 MB 的 IFC 排到队尾，避免超大文件拖住小模型。
- IFC LOD 缓存位于 IndexedDB；重置工程缓存不自动清除它，真正的“冷”需要清 WebView IndexedDB。
- 真冷转换的 452 MB 样本实测约 120 s 完成、127 s 写缓存；180 s 无进度看门狗只在中止时生效。
- 设置面板提供“跳过 >64 MB 非关键 IFC”开关；跳过时状态栏必须显示“已跳过 N 个超大 IFC”，不能静默丢弃。

### 近景区域

- 相机附近约 30 m 进入区域细节；只构建相机附近的区域子集，不每次重开整源。
- 已识别的小孔（≤50 mm 关系孔）省略；中型及未知开洞保留，避免把“看不见”当成“没有”。
- 未缓存类型或回退路径仍可能 `OpenModel` 整个源文件；这是当前接受的边界，不能宣称任意对象即时精化。

## 3. DEV 分级

DEV 几何链：CBM → DEV → PHM → MOD/STL（同 UUID `.gl` 是可选的辅助来源，不自动进入 SOLIDMODEL 主链）。

- **LOD0**：DEV 模板的粗表示，全站远景基础。
- **LOD1**：较近设备的精细表示。
- **LOD2**：选中/近景对象的最高级表示。
- 模板按 DEV 路径和源身份缓存；同一 DEV 的多个 occurrence 共享模板，但保留 occurrence 身份与部件选择。
- Worker 池按逻辑核数 60% 取 2–8 个（`gim-dev-workers` 可覆盖）；结果有字节预算和输出背压。
- 相机评估复用矩阵/视锥上下文；提交按优先级合并，避免每帧重复排序。

### 远景与近景的取舍

- **远景不得按构件类型/名称/包围盒隐藏整台设备**：全站远景下，所有 DEV 仍生成 LOD0，包括当前视锥外/相机看不到的设备；否则会造成“设备丢失”的功能回归。
- 小构件（螺栓、垫片、已识别小孔）只在**近景区域细节**中省略，不能在外层把 DEV 整个标记为小构件。
- 范围目录/模板编译的长尾通过 Worker、缓存和批处理解决；若再次引入延迟目录，必须证明远景仍能显示所有设备，不能以减少设备覆盖换首屏。

### 为什么暂不做实例化/合批

- 已有分批提交、相机评估复用和状态合并刷新；500/substation 首屏均达标。
- 整站相机交互仍需 draw calls 与真实固定路线验收；没有证据时不以“减少三角面”替代 draw calls 改善。
- 任何实例化方案必须保留 occurrence 与部件选择身份，否则属性/高亮会错位。

## 4. 启动流水线（桌面）

1. 读取 GIM 头，定位归档偏移。
2. 原生解压；内嵌 7-Zip 流式路径优先，7z 不可用时回退纯 Rust。
3. 语义 pack/独立 IFC 落盘；小文件批量物化。
4. CBM/FAM/DEV 解析；大工程兄弟节点 32 路并发（B1-4 解析 29 s→16.3 s）。
5. 首个 IFC 坐标锚定并显示；其余 IFC、DEV、Spatial、STD/SLD、缓存发布在后台。
6. 两阶段索引发布：核心索引提交即可暖启动，属性后台补写。

## 5. 验证与边界

- v0.1.0 三 SLO 冷启动实测：First usable 500 系列 17.5/31.7/11.3/16.8/53.3 s，substation 21.9/13.3/11.2/5.0 s，线路 4.1–10.5 s；Current view/Full fidelity 仅 substation03（66.9 s）和 substation04（37.5 s）在 90 s 内完成，其余样本 >90 s。完整表见 [性能](../performance.md)。
- 全量测试与诊断入口见 [验证](../validation.md)。
- 已接受的边界：IFC 近景其他类型仍可能重开整源；DEV LOD2 缓存未命中仍走主线程 RPC；这些在 [性能](../performance.md#已接受的当前边界) 记录，出现新的现场要求时重新立项。

## 6. 代码索引（新人先看这里）

| 关注点 | 入口 |
|---|---|
| 打开工程、解压/IFC 分支 | `desktop/src/services/openGimService.ts`、`gimOpenCore.ts` |
| 变电首屏、CBM/IFC/DEV 调度 | `desktop/src/services/substationRuntime.ts` |
| IFC LOD/Fragments 加载 | `desktop/src/viewer/ifcLoader.ts`、`ifcConversion.ts`、`ifcRegionalRuntime.ts` |
| DEV 范围目录/模板/LOD 调度 | `desktop/src/services/devLodRuntime.ts`、`devLodPolicy.ts`、`devGeometryWorkerClient.ts` |
| DEV→PHM→MOD/STL 发现 | `desktop/src/services/modGeometryDiscovery.ts` |
| 设备 GLB 序列化/缓存 | `desktop/src/services/glbCacheService.ts`、`devGlbTemplateRuntime.ts` |
| CBM 树与并发解析 | `desktop/src/gim/cbmParser.ts` |
| 线路首屏/地图 | `desktop/src/services/powerlineRuntime.ts`、`ui/lineProjectView.ts` |

## 7. IFC 加载状态机

```
读源 -> 首个 IFC 坐标锚定 -> LOD0 commit -> firstUsableGeometryReady
                                   |-> LOD1 后台
                                   |-> 其余 IFC 按队列
                                   |-> 对象选中 -> 整文件 Fragments(LOD2)
```

关键约束：

- **首个 IFC 与其余 IFC 分离**：`firstUsableGeometryReady` 只依赖第一个可用 IFC；其余 IFC 不阻塞 interactive。
- **LOD0/LOD1 顺序提交**：同一个 Worker 完成 LOD0 后才提交 LOD1，避免首屏被 LOD1 拖住。
- **LOD2 不自动全站加载**：只在属性面板请求/对象精化时读取整文件，防止全站 IFC 堆内存暴涨。
- **坐标锚点只建立一次**：后续 IFC 复用同一 `sourceToViewer` 矩阵，锚点未就绪时 DEV/IFC 不提交到场景。
- **取消语义**：切换工程时旧 conversion 以 `AbortError: IFC conversion belongs to an obsolete project` 结束，这是预期取消，不是失败。

## 8. DEV 目录与模板流水线

```
CBM seeds
  -> 按 DEV 路径分组
  -> 范围目录（catalog）：读取/计算 sourceBounds（PHM/MOD/STL）
  -> 相机可见性/距离/LOD 决策
  -> 模板（template）编译：Worker 内 MOD/STL -> GLB
  -> 模板缓存（按 source SHA + DEV + LOD）
  -> occurrence 共享模板 + placement 矩阵 -> scene commit
```

- **范围目录**决定“这个 occurrence 在不在相机内、距离/像素多大”；未知范围仍会给自动 LOD0。
- **模板编译**是重任务；结果按 `(source SHA, DEV, LOD)` 缓存，同一 DEV 的多个 occurrence 只编译一次。
- **提交**按优先级队列合并：选中 > LOD0 > LOD1/2；单次 commit 不可中断，但相机移动可以重新决策后续任务。
- **失败隔离**：单个 DEV 失败只影响该 DEV；`source-invalid` 不重试，临时错误可在选中时重试。

### LOD 决策阈值（`devLodPolicy.ts`）

| 条件 | LOD |
|---|---|
| 选中 | LOD2 |
| 不可见 | LOD0（仍保留基础表示） |
| 距离 ≤30 m 且投影 ≥120 px | LOD2 |
| 已是 LOD2、距离 ≤35 m 且投影 ≥90 px | 继续 LOD2（滞回） |
| 投影 ≥30 px（已有表示）/ ≥40 px（首次） | LOD1 |
| 其他 | LOD0 |

滞回避免相机抖动导致 LOD 反复升降。

### 缓存键与失效

- DEV 模板：`DEV_GEOMETRY_VERSION | sourceSha | devPath(lower) | lod`。
- 范围目录：`DEV_SPATIAL_CATALOG_VERSION | DEV_GEOMETRY_VERSION | sourceSha | devPath(lower)`。
- 语义/几何/parser 域分别 bump 版本；一个域失效不应连带重建无关域。
- 模板写入失败只影响缓存完整性，不把当前已编译几何标记为 source-invalid。

## 9. 现场排查

1. 打开 `Ctrl+Shift+D` 诊断，先看 timings 中首屏/IFC/DEV 分段。
2. 看状态栏 `冷编译 / 缓存命中 / 失败 / 阻塞`，区分“没请求”“在排队”“失败”。
3. 若设备不显示，先确认它是 occurrence 被跳过还是 DEV 本身 empty/unsupported：
   - `viewPendingOccurrences`、`readinessBlockers`；
   - DEV 诊断的 reason（empty-device-xml/dev-no-solidmodel/phm-no-solidmodel/parser-unsupported/source-invalid）。
4. 远景必须保留全部 DEV LOD0；不要用“设备看不到”解释缺失设备，除非它确实不在 CBM/DEV 引用图中。
