# 平台、安全与发布

本页汇总跨工程的运行平台约束、安全边界、配置开关、诊断和发布边界。开发命令与工作区约定见[开发指南](../development.md)；具体算法、缓存和生命周期见各主题文档。

## 安全边界

| 面 | 当前约束 |
|---|---|
| SLD 渲染 | 白名单净化；删除脚本、事件、`foreignObject` 和外部资源；图形选择数据与原 SVG 执行环境分离 |
| 解压 | 路径规范化/目录穿越、重复路径（大小写不敏感）、声明/累计/归档大小配额、输出路径 symlink/reparse 与 staging 根边界；任一失败终止整次解压 |
| 源读取 | 只接受数据库记录或文件对话框授权的路径；工程 root 句柄在单次校验内禁止 delete sharing；逐 entry 检查 regular-file、大小和 reparse |
| 临时文件 | 解压/缓存先写 staging 或临时文件，校验后原子 rename；中断不发布“部分有效” |
| 外部服务 | 底图/天地图 Key 保存在本地 SQLite `app_setting`，不写入构建产物；不后台批量下载瓦片 |
| 页面策略 | 主文档 CSP 保留 `style-src 'unsafe-inline'`；静态类已承载属性诊断与搜索副标题，但 CSSOM `cssText`、第三方视图和独立 SLD SVG 样式仍需兼容验证，见[问题与限制 L-13](../open-issues.md) |

不能以关闭安全机制、修改 ACL 或放宽路径检查替代验收失败。收紧 CSP 前需逐项迁移运行时样式并验证地图、SLD 与 Viewer；移除少数 HTML `style` 属性不等于可以删除 `unsafe-inline`。约束依据见 [MDN style-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/style-src)。

## 发布与运行时资产

- 桌面发布包只带 `GIM-Reader.exe`；`7z.exe`/`7z.dll` 以字节资源内嵌。首次使用时释放到 `%TEMP%\gim-viewer-7zip/<exe-hash16>-<dll-hash16>/`（验收构建可重定向到工作区临时目录），释放后重算 SHA-256 一致才执行。
- 同目录 sidecar 只有在两个文件 SHA-256 都与随包版本一致时才使用，否则回退内嵌副本；不信任“存在且大小相同”。
- 固定 WebView2 与 WASM 资产由构建脚本准备；`desktop/public/worker-bundle.js`、`libarchive.wasm`、`wasm/web-ifc*.wasm` 是随项目维护的运行时资产。
- 缓存数据库为 `gim_cache_schema_v1.db`，直接创建当前完整表结构；不接受旧库迁移或历史版本放行。
- 发布前需核对 EXE、固定运行时、源码指纹和验收 manifest；测量构建不能混用日常缓存。
- 桌面应用版本以 `desktop/package.json` 为准；Tauri 的 `version` 引用 `../package.json`，NSIS 和 portable manifest 使用同一版本。`npm run check:version` 校验 npm 锁文件与 Cargo 清单/锁文件的一致性；前端构建、桌面构建和 portable 组包均先检查，版本不一致时停止。Windows portable 组包还读取真实 EXE 的 ProductVersion，拒绝把旧程序标为新版本。升级版本时同步 npm 与 Cargo 的根包版本，不修改依赖包或 Android 版本。

## 配置与状态

| 配置/状态 | 当前行为 |
|---|---|
| IFC 浏览策略 | 默认 `bim-lod`；完整 Fragments 缓存默认关闭，且默认路径不可达 |
| 超大 IFC | `ifc.skipLargeFiles` 默认关闭；开启后跳过 >64 MiB 非关键 IFC，来源/诊断保留 |
| 自动定位 | 默认开；`gim-auto-locate` 保存偏好；三维点击始终不自动定位 |
| 底图 | 默认 OSM 在线；天地图可配置；PMTiles 未实现；Canvas 兜底 |
| 设备 Worker | 按逻辑核约 60% 取 2–8；`gim-dev-workers` 可覆盖 |
| 内存压力 | 6 GiB 的 80% 暂停预取/自动 L1，90% 回收未保护模板/空闲 Worker |
| 调试开关 | `gim-debug-fragments-cache`、`gim-debug-substation-early-semantic`、`gim-debug-substation-parse-copy`、`gim-debug-substation-extraction-trace`、`gim-debug-dev-instancing` 只用于诊断，不改变正式默认策略 |

完整配置代码在[features.ts](../../desktop/src/config/features.ts)；设置面板/底图选择另有持久化规则。

桌面 Three 场景使用 `SimpleRenderer` 的公开 MANUAL 模式：静止场景不重复提交，树节点增删和 IFC 分块更新使画面失效；原地修改材质、显隐或矩阵通过 `viewer/demandRendering.ts` 请求刷新。Fragments 完成事件只检查该模型公开 tile 的几何、属性版本、组、材质（含颜色、透明度、面/深度状态）和矩阵变化，忽略没有视觉变化的周期性完成通知，不扫描场景或顶点数组。连续加载时合并场景刷新，冷却间隔为上次提交耗时的三倍，最小 80 ms、最大 750 ms；相机更新、选择和窗口变化立即请求下一帧。相机与 Fragments 的更新循环继续运行，线路 MapLibre 保持自身刷新机制。DEV 实例化仍默认关闭。

## 诊断

| 入口 | 内容 |
|---|---|
| `Ctrl+Shift+D` | 数据库/诊断 JSON 与 timings；只读当前会话已采集状态 |
| `Ctrl+Shift+B` | 稳定 benchmark JSON（路径已净化）；手工验收记录，不替代 CLI 私有报告 |
| `Ctrl+Shift+C` | 线路悬链线参数审计 JSON（仅线路工程有数据） |
| `bench run --mode diagnostic --diagnostics <配置>` | 主线程/Worker 的 CPU、Allocation、Heap、Trace 与可选 GPU 采集 |
| `bench analyze` / `export-trace` | 私有报告的生命周期、阻塞链、未归因区间与 Perfetto 时间线 |
| `utils/perfTimings.ts` | 打开、IFC/DEV、工程实体、选择和缓存阶段 |

- 工程实体诊断包含来源/实体/导航缓存命中、来源完整性、整体/待归数量、Worker 传输与失败原因。
- DEV 诊断包含模板队列、Worker 阶段、缓存读取/写入、范围、LOD、失败原因和内存预算；不把 Worker 墙钟当 CPU。
- IFC 诊断包含读取/转换/源模型、远景/区域/属性、连接批次和缓存命中；阶段可重叠，不能相加为整源耗时。
- 资源诊断包含进程树 private、RSS、JS heap、GPU 资源计数和可选 WebView2 内存；采样窗口有限，不代表瞬时峰值。
- 选择诊断区分导航、属性摘要/参数、几何收集、高亮提交、下一帧；外层跨度包含调用方恢复间隙。
- WPR/PMC 系统录制入口当前关闭并返回 `authenticated-system-helper-required`；CPU/GPU Trace 与已采集 ETL 的离线 WPA 摘要仍可用，边界见 [Benchmark CLI](../benchmark.md#详细-trace-与-profile)。

导出字段与判定口径见[性能测试指南](../performance-guide.md)；Trace/Profile、WPR/PMC/WPA 与 GPU 采集的配置和边界见 [Benchmark CLI](../benchmark.md#详细-trace-与-profile)。

## 发布边界

- 当前没有离线瓦片、编辑、碰撞、算量、出图、质量验评或运维工单。
- Android 与桌面共享线路领域语义，但平台 API、缓存和性能承诺分别验收。
- 外部业务插件契约存在，但不等于已有外部插件通过真实工程验收。

## 相关文档

- 命令与工作区：[开发指南](../development.md)
- 安全相关门禁与证据：[验证](../validation.md)
- 缓存版本与失效：[缓存域](caches.md)
- 性能测量：[性能测试指南](../performance-guide.md)
