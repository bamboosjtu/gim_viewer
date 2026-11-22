# 运行时与数据库模块

本页说明大型运行时文件内部的职责归属。层间依赖遵循[分层规则](layers.md)，缓存契约和版本以[缓存域](caches.md)为准。

## 稳定入口

| 入口 | 保留职责 | 实现位置 |
|---|---|---|
| `features/substation/application/substationRuntime.ts` | 工程冷/暖打开、核心语义发布、各后台阶段接线 | `features/substation/runtime/*`、`features/substation/presentation/substationPresentation.ts` |
| `features/powerline/application/openPowerlineProject.ts` | 线路冷暖打开与会话视图交接 | `features/powerline/runtime/`、`features/powerline/presentation/` |
| `features/equipment/application/openEquipmentProject.ts` | 独立设备来源准备、导航发布与节点选择 | `features/equipment/runtime/`、`features/equipment/presentation/` |
| `services/geometryOnlyRuntime.ts` | 基于已发布来源树启动纯 DEV 场景、相机与首帧观察 | 独立设备和纯 DEV 变电共同使用 |
| `services/devLodRuntime.ts` | 相机/选择、occurrence、场景提交、坐标锚点和会话关闭 | `devLodTemplateStore.ts`、`devLodArtifactWriter.ts`、`devLodSourceWorkset.ts`、`devLodReadiness.ts` |
| `src-tauri/src/db.rs` | 数据库连接、共享版本和基础查询、命令/DTO 导出 | `src-tauri/src/db/*.rs` |

调用方可以继续从既有入口导入公开函数和类型；内部模块直接引用实际实现和小型契约，不反向依赖入口文件。Tauri 命令名、IPC 数据结构、缓存键和版本不因文件拆分而改变。

## Worker 通信

`infrastructure/workers` 持有工程 Worker 的创建、消息协议、传输编解码与请求释放。`SessionScope` 取消时，客户端解除监听、清除待处理请求及其定时器并终止 Worker。工程服务继续负责同一工程内的构建替换与结果发布。工程、线路与变电 Spatial Worker 复用 `WorkerRequests`，各业务保留自己的计算和回退。

## 纯 DEV 启动

纯 DEV 启动复用 Viewer 与 DEV LOD 管线。LOD 运行时从创建起就归当前工程会话持有，切换工程时同步释放 Worker、定时器和场景资源。相机命令和坐标锚点按对应的发布实例释放，设备导航由独立设备 Feature 通过端口登记。

## 暖启动核心

缓存校验通过后，`substationWarmCore.publishSubstationWarmCore()` 负责恢复索引、物化工程来源文件并发布 core navigation；`substationRuntime` 只保留工作流协调、冷回退和后台阶段接线。SessionScope 守卫、迟到会话返回和失败释放仍由 Runtime 统一处理。

## 巨型函数拆分队列

以下函数仍以单函数承担多个阶段，按“输入/输出、会话守卫、资源释放”先拆纵向流程，再考虑文件搬迁。函数长度只作定位，不设行数门禁。

| 归属 | 当前函数 | 先拆出的阶段 |
|---|---|---|
| 变电打开 | `openSubstationProject` | 暖缓存恢复已移至 `substationWarmCore`；剩余冷回退编排与后台接线 |
| IFC 加载 | `loadAllIfcFiles` | 队列规划、逐模型装载、区域批次与终态诊断 |
| IFC Spatial | `parseIfcModel` | 关系投影、空间对象投影、元数据/placement |
| GLB 缓存 | `serializeDevToGlbDetailed` | 场景遍历、几何编码、诊断/预算 |
| 工程实体 | `beginEngineeringBuild` | 输入准备、结果发布和快照缓存；Worker 请求通过会话绑定的基础设施客户端执行 |
| 线路导航 | `buildLineNavigationIndex` | 来源、塔位与档距索引已单独准备，投影负责业务行及来源回指 |
| 线路 UI | `renderLineMap` | 图层装配、交互绑定、生命周期释放 |
| CBM 来源树 | `buildCbmTree` | 物理树、名称/DEV 关联、展示映射 |

迁移以有实际消费者的完整工作流为单位，先确认资源所有者、接口和释放点。每个拆分保持现有读取次数、对象数量和结果形状，入口接入对应 feature 的生产流程后再移动下一条工作流。

## 变电生命周期

```mermaid
flowchart TD
  Open[openSubstationProject] --> UI[substationPresentation]
  Open --> Spatial[substationSpatialRuntime]
  Open --> Docs[substationDocumentRuntime]
  Open --> IFC[substationIfcRuntime]
  IFC --> DEV[substationDevRuntime]
  Spatial --> UI
  Docs --> UI
  IFC --> UI
  DEV --> UI
```

- `runtime/spatial/substationSpatialWorkflow` 负责暖开恢复或重建的共享启动，以及后台准入。`substationSpatialRuntime` 发布 Spatial 索引，并在来源发布屏障后写缓存。
- `runtime/spatial/substationSpatialWorkerClient` 将专用 Worker 登记到当前 `SessionScope`，由会话失效或任务完成释放。Worker 仍复用共享请求协议和 Spatial 编码器。
- `substationIfcQueue` 负责 IFC 顺序准入、连接预览批次和交接已登记模型。`substationIfcModelLoad` 管理单条目的源读取、进度、会话取消和装载失败清理。`substationIfcRuntime` 接收场景对象，独立处理首个可用模型、首帧观察和后台阶段。
- `substationDevRuntime` 负责 IFC 后的 DEV LOD 启动。
- `substationDocumentRuntime` 负责可选 STD/SLD 的解析与缓存恢复。
- `substationPresentation` 协调导航、选择回调和加载提示，DOM 由 UI 实现。与 IFC 阶段共享的提示标志放在 `substationLoadingState`，IFC 加载开始时重置。
- `substationRuntimeTelemetry` 负责会话守卫下的资源采样和 Spatial parser observer。

这些模块仍属于桌面服务编排层；领域分类留在 `engineering/`，来源适配留在 `gim/engineering/`。

## MOD/STL 与 DEV LOD 的所有权

| 模块 | 负责 | 生命周期约束 |
|---|---|---|
| `modGeometryScene` | 创建并复用 MOD/STL 图层根节点 | 图层随场景释放；放置与范围校验由 DEV LOD 运行时及 Viewer 的几何工具负责 |
| `modGeometrySourceFiles` | 为当前会话建立共享的设备来源文件索引 | 读请求沿真实引用链触发；会话失效后拒绝读取 |
| `devLodTemplateStore` | 请求去重、缓存输入预算、模板校验/编译、L1 demand 和 LRU | 与一个工程会话绑定；取消时关闭 reader、拒绝排队请求；移除场景使用者后释放模板 |
| `devLodArtifactWriter` | 缓存准备、写入准入、并发槽和写入诊断 | 取消未准入写入；已开始的原生写入继续持有预算，完成后释放 |
| `devLodSourceWorkset` | 有界预取、部分缓存缺失后的来源恢复 | 使用当前会话及压力回调；不抢占几何计算槽 |
| `devLodReadiness` | occurrence 状态增量计数和可选审计 | 无 IO、场景创建或 DOM 依赖 |
| `devLodDiagnostics` / `devLodTypes` | 诊断形状和内部共享类型 | 诊断实例由会话共享；类型模块只使用类型导入 |

`DevLodRuntime` 组合这些组件，向它们提供会话有效性、Worker、来源准备、诊断发布和就绪刷新回调。组件不接收整个运行时实例，也不通过类型断言访问其私有状态。普通选择、自动 LOD 和显式 L2 的策略仍由运行时协调。

## 原生持久化

| 模块 | 职责 |
|---|---|
| `db/schema.rs` | 建表与迁移 |
| `db/projects.rs` | 源身份登记、项目记录和 SHA 守卫 |
| `db/substation_index.rs` | 变电索引、属性、几何引用及语义补写事务 |
| `db/line_index.rs` | 线路图与属性的分块事务和查询 |
| `db/cache_paths.rs` | 路径约束、reparse point 检查、staging 与目录所有权 |
| `db/cache_protocol.rs` | 二进制 IPC envelope、批量结果编码与传输配额 |
| `db/cache_transport.rs` | 受权的源缓存读写命令 |
| `db/semantic_pack.rs` | 线路/变电来源包、索引和有界读取 |
| `db/geometry_cache.rs` | DEV GLB/LOD 文件、manifest 和发布标记 |
| `db/cache_validation.rs` | 分域缓存有效性及来源/属性完整性检查 |
| `db/diagnostics.rs` | 只读缓存诊断 |
| `db/project_cache.rs` | 设置、最近工程、打开受权和缓存删除 |
| `db/validation_profile.rs` | 调用级校验计时 |

实现模块按具体依赖导入相邻模块；文件安全、二进制协议和数据库事务分别维护。内部辅助函数只在 `db` 范围可见，`db.rs` 导出公开命令与 DTO，`lib.rs` 集中注册 Tauri 命令。

数据库测试位于 `db/tests.rs`；真实 SQLite 交换入口继续使用 `db::substation_sqlite_tests::substation_sqlite_exchange`。

## 验证入口

- `npm test`：工程打开、LOD、缓存预算、取消、选择和几何等快速测试。
- `npm run test:sqlite`：生产 Rust 保存/查询路径的真实 SQLite 往返。
- `cargo test --lib --manifest-path src-tauri/Cargo.toml`：原生路径安全、语义包、缓存协议及事务测试；临时文件应使用可写的隔离目录。
- `npm run check:engineering-boundaries`：层间依赖、运行时组件反向依赖入口与模块内循环检查。
- `npm run build` 与 `cargo check --manifest-path src-tauri/Cargo.toml`：前端生产分包、类型检查和 Tauri 命令注册兼容性。

## 相关文档

- [分层与依赖](layers.md)
- [缓存域](caches.md)
- [打开与生命周期](lifecycle.md)
- [DEV 几何运行时](dev-geometry.md)
- [平台、安全与发布](platform.md)
