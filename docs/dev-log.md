# 开发者日志（待优化项）

> 仅记录待优化 / 待决策 / 待核验项。
> 历史过程记录与关键决策说明已移除，可在 git 历史（`docs/dev-log.md`）中查阅。

---

## 1. 变电工程

| 项 | 说明 | 优化方向 |
|---|---|---|
| 几何管线主线程编译 | `serializeDevToGlb`（XML 解析 + GLTFExporter）在主线程分批 yield，首次打开仍占用主线程 | 移入 Web Worker |
| IFC 无 Fragments 缓存 | 每次打开重新解析 IFC（`ENABLE_FRAGMENTS_CACHE=false` 休眠） | 重评估启用该缓存 |
| web-ifc 模型完整性 | 部分 IFC 可能丢构件；"Malformed tile" 被 catch 但该 IFC 显示不全（OBC 上游限制） | 跟踪上游 |
| Bentley F2 编码语义 | F2System `SYSCLASSIFYNAME=1/2/3/4/Y/02` 与 JinQu 的 U/A/S/G 体系不同，层级树暂显示裸编码 | 待更多样本确认后映射 |
| 电气图数据缺失 | Bentley 样本不含 `.sld`/`.std`/`.sch`，电气图 tab 无数据可渲染 | 数据层面，无动作 |

---

## 2. 线路工程

| 项 | 说明 |
|---|---|
| 塔位真实 3D | 普通地图使用圆形/菱形符号；HNum 形状在选中杆塔后的属性面板“来源”页等比例预览；线路不启用独立 3D |
| 塔型分类 | 仅区分直线塔（圆形）/耐张塔（菱形） |
| 工程弧垂 | 曲线为抛物线示意，未使用 MATRIX0 挂点 / BLHA 高程；hover/click 已与可见曲线一致（wireScreenPoints 共享采样）；升级工程语义依赖 KVALUE 确认（见 §3） |
| 坐标偏移 | 已核验（2026-08）：BLHA 为 CGCS2000/WGS-84 勘测数据，叠加 WGS-84 底图（OSM）无需转换；GCJ-02 为 Web 地图展示层混淆，强转反而引入误差。决策已文档化（lineMapBaseLayer.ts / lineMapData.ts 头注释） |
| Canvas fallback 投影 | 已改为 Web Mercator（与 MapLibre/OSM 一致，正形投影），比例尺按中心纬度修正；原高纬度等距投影畸变已消除 |
| 跨越点定位 | 数据层面受限：line02 实测 44 个 CROSS 全部无 BLHA 坐标（无法插值修复——跨越点不在塔位连线上）；有坐标样本已可正常定位标注；无坐标时统计面板显示 unresolved 计数 |
| OSM 在线依赖 | 设计如此：OSM 不可用（3 次 tile error）自动回退 Canvas-only，行为符合预期，无动作 |
| 首次导入性能 | 2026-09-02 已用真实 Tauri 对 line01–line06 做 cold/warm 各 n=3：Worker 解析通常低于 0.5s，SQLite 已移出 ready critical path；冷启动瓶颈随样本变化，line03 的 Rust 7z decode 约 13.1s | 7z decoder 专项；保持与 UI/语义缓存改造解耦 |
| 杆塔 HNum/MOD lazy preview 偶发长延迟 | 选中杆塔后来源页按需读取/解析 HNum/MOD，真实使用中偶发几十秒才显示 | 拆分 preview read/parse/render 埋点后，再评估预览缓存或独立解析任务 |
| warm RSS 偏高 | 六个线路样本的 Tauri warm 采样约 0.9–1.3 GB（进程树工作集，非 JS heap） | 先做独立进程基线与回收测量，再决定 property lazy load |
| line03 7z decode 偏慢 | 真实 Tauri 冷启动 Rust `decodeMs` 约 13.1s，总解压约 15.1s | decoder 专项分析 7z 解码、entry 写盘和调度，不在本轮线路 UI 范围内 |

---

## 3. 悬链线待决策项

> 数据可行性已确认（BLHA=塔位中心、MATRIX0=挂点偏移、挂点坐标可算、KVALUE 为参数字段），
> 详见 [schema/15-wire-catenary-evidence.md](schema/15-wire-catenary-evidence.md)。
> 已解决：WIRETYPE 来源（经 DEV→FAM 链解析）、KVALUE=0 语义、MATRIX0 x 符号对称性。

| 项 | 现状 | 阻塞 |
|---|---|---|
| KVALUE 物理含义与公式 | 非零值 0.00025-1.34，符合弧垂系数特征；具体含义（弧垂/张力/应力参数）、单位与公式（抛物线 `f=k*x*(L-x)` vs cosh）未确认 | GIM 标准无字段定义；需对照导线型号表 + 标准弧垂表反推 |
| MATRIX0 y 分量与坐标系局部性 | y 值极小（±0.3m）影响可忽略；基于 BLHA=塔位中心的局部坐标系推论未做跨塔交叉验证 | 需同塔多挂点样本核验 |
| 悬链线模式决策 | 当前默认启用实验性 2D 曲线（非工程语义） | 关闭 / 保留示意模式 / 升级工程语义（后者依赖 KVALUE 确认，路线 M5-A~E 见 [schema/14](schema/14-line-catenary-study.md) §6.5） |

---

## 4. 通用

| 项 | 说明 |
|---|---|
| 单工程模式 | 同时只能打开一个 GIM 工程（架构级限制：AppState 单例 + 工程切换清理流程；多工程需重设计状态管理与缓存隔离，暂不实施） |
| 无搜索 | 已实现（2026-08）：变电 CBM 树 + 线路工程均支持按名称/编号搜索定位（通用组件 ui/searchBox.ts），搜索结果联动属性面板 + 地图定位 + 树行选中 |
| 无导出 | 已实现（2026-08）：线路地图新增「截图」PNG 导出（合成底图+叠加层）与「CSV」塔位/导线/跨越点表格导出（UTF-8 BOM）；变电属性抽屉新增「⇩」按钮导出当前属性 CSV |
| 休眠功能 | 决策（2026-08）：继续保留休眠、开关关闭。Fragments 缓存此前因正确性问题主动休眠，重新启用需实测验证；PMTiles 为离线场景预研，保留代码路径待离线需求明确后再评估。两者均不影响默认功能路径 |
| 审计服务 | `lineGeometryAuditService` / `lineSpanGroupingAuditService` / `lineCatenaryAuditExportService` / `lineWireSemanticService` 为纯内存研究工具（Ctrl+Shift+C 导出），保留 |
