# AGENTS.md — 编码助手工作约定

本项目是 GIM 文件浏览器：`desktop/` 为 Tauri 2 桌面端（变电、线路、独立设备），`app/` 为 Android 线路端。当前运行面、目录所有权和依赖方向见[架构](docs/architecture.md)与[分层](docs/architecture/layers.md)；格式事实见[Schema](docs/schema/README.md)。不要把研究材料直接当成已验证契约。

## 工作区和证据

- 测试与验证只使用工作区 `tmp/` 和 `output/`。不得读取、写入或清理系统目录作为测试数据；子进程 `TEMP/TMP/TMPDIR` 也必须指向工作区。命令与本地样本规则见[开发指南](docs/development.md)及[验证](docs/validation.md)。
- 工程样本和对照基线由开发者自行构建。远程 CI 不运行真实或合成工程样本及性能矩阵；缺样本的跳过不是通过。`docs/performance.md` 只代表作者所述环境的结果。
- `demo/`、`tmp/`、`output/` 不随仓库分发。L0/L1/L2 注册表位于 `benchmarks/`，CLI 和报告契约见[Benchmark](docs/benchmark.md)。报告默认匿名；不要将真实工程名、地理归属或原始 profile 写入可分享文档。

## 代码边界

- `desktop/src/engineering/` 是纯领域；`gim/` 做来源解析与适配；`services/` 编排；`viewer/` 管理渲染；`ui/` 管理 DOM；`measurement/` 是探针和只读证据。测量核心在 `packages/measurement-core/`，不得依赖 DOM、Tauri 或 Three。新跨端能力先确认是否属于现有 `packages/` 或 `crates/` 契约。
- `gim/` 不依赖 services/viewer/ui；`viewer/` 不依赖 services/ui；`ui/` 不直接访问数据库或原生 IPC。入口与打开服务不能静态引入 Three、web-ifc、MapLibre。变更后运行 `desktop/` 下的 `npm run check:engineering-boundaries`。
- 源 SHA 和 magic 决定输入身份，缓存不能覆盖源事实。工程实体、来源 occurrence 与几何表示保持独立；表示只按来源 ID 绑定，不靠同名、邻近或数组序号补配。会话、几何批次和选择请求均须拒绝旧结果提交。具体语义见[架构](docs/architecture.md)及[验证不变量](docs/validation.md)。
- 全包路径/引用索引按源文件 Map 共享。逐节点、逐 DEV/PHM、逐属性或逐几何请求不得重新枚举整包；文件物化仅替换值，路径键集合变化使用新 Map。相关变更用扫描/读取次数回归验证，不使用绝对耗时阈值。
- IFC 物理目录不能写死；CBM 引用使用全局 entry resolver。路径大小写和分隔符兼容，歧义保留。DEV/PHM/MOD 装配按真实引用递归、逐边矩阵和分支防环，失败按来源局部隔离。

## 持久化和文档

- 首次正式发布前 SQLite 物理 schema 固定 v1；开发库结构变化由开发者删除重建，不增加迁移分支。语义、几何等派生缓存独立失效，权威版本契约见[缓存域](docs/architecture/caches.md)。
- 长期文档只描述当前状态；架构在 `docs/architecture/`，工程实体在 `docs/engineering/`，格式在 `docs/schema/`，未关闭产品缺陷在 `docs/open-issues.md`。`docs/schema/` 不写真实工程名或地理归属。
- 运行时资产和开发命令由[开发指南](docs/development.md)维护。源码和生成报告、测试夹具、独立 Python 工具的目录归属见[项目目录](docs/architecture.md#项目目录与模块归属)。
