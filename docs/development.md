# 开发指南

本页是开发环境、命令、工作区约定和文档维护的唯一入口。运行时结构与模块边界见[系统架构](architecture.md)及[分层与依赖](architecture/layers.md)；门禁语义与证据规则见[验证](validation.md)；Benchmark 参数见 [Benchmark CLI](benchmark.md)。

## 目录

- [环境与首次运行](#环境与首次运行)
- [日常命令](#日常命令)
- [测试与门禁命令](#测试与门禁命令)
- [Android 与 Python 工具](#android-与-python-工具)
- [工作区与临时目录](#工作区与临时目录)
- [持久化与运行时资产](#持久化与运行时资产)
- [文档维护](#文档维护)
- [相关文档](#相关文档)

## 环境与首次运行

- Windows x64 桌面开发；Node.js **>= 22**（`camera-controls` 3.1.2 的 engines 约束），CI 使用 Node 22。
- 桌面命令从 `desktop/` 执行，Android 命令从 `app/` 执行；Rust 命令可用 `--manifest-path` 从仓库根执行。
- 首次运行：

```powershell
cd desktop
npm ci
npm run tauri:dev     # Tauri 开发窗口
```

`npm run dev` 启动浏览器开发模式（Vite，不含 Tauri 原生能力）。发布构建使用 `npm run tauri:build`，会生成 Release EXE、NSIS 安装包与 portable ZIP。

## 日常命令

| 命令（在 `desktop/` 下） | 用途 |
|---|---|
| `npm run dev` | Vite 浏览器开发模式 |
| `npm run tauri:dev` | Tauri 开发窗口 |
| `npm run build` | TypeScript 检查 + Vite 生产分包 |
| `npm run tauri:build` | Release EXE、NSIS 与 portable ZIP |
| `npm run lint` | ESLint（`src`、`bridge`） |
| `npm run check:version` | npm/Cargo 版本一致性；构建前自动执行 |
| `npm run check:types` | TypeScript 检查（含测试替身的接口完整性） |
| `npm run check:engineering-boundaries` | 纯领域、来源与 Viewer 边界检查 |
| `npm run check:engineering-catalog` | 共享目录与生成索引一致；加 `--python` 同时核对参考工具 |

应用版本以 `desktop/package.json` 为准；Tauri 配置引用该文件。portable 组包还会读取 EXE 的 ProductVersion，拒绝把旧程序标成新版本。发布与资产细节见[平台、安全与发布](architecture/platform.md)。

## 测试与门禁命令

| 命令（在 `desktop/` 下） | 范围 |
|---|---|
| `npm test` | 快速单元测试（不启动 Cargo、不读工程样本） |
| `npm run test:sqlite` | 真实 SQLite 往返（构建一次 Rust harness） |
| `npm run test:engineering:worker` | 真实 Worker/Blob/缓存/取消（headless Edge，`desktop/tests/engineering/worker-check.html`，无样本） |
| `npm run local-tests:check` | 检查跟踪的 `local-tests/mini-samples.example.json` |
| `npm run test:local -- --build <原生构建清单>` | 打开开发者登记的一变、一线、一设备；skip 不计通过 |
| `npm run test:coverage` | `engineering/` 与 `gim/` 覆盖率下限 |
| `npm run test:ifc-critical` | IFC 转换、会话竞态、缓存与开洞策略 |
| `npm run test:acceptance-tools` | 验收构建、清单与探针协议 |
| `npm run test:measurement-tools` | 测量 CLI、Trace/CPU/WPA 协议与正确性规则（无工程样本） |
| `npm run test:local-contract` | 本地注册表协议 |

Windows CI 保持一个串行任务：版本、测量协议、验收工具、本地注册表、分层、类型和 lint 检查在 Rust 编译及覆盖率之前执行；随后运行 Rust 单元测试、前端覆盖率、SQLite 集成、前端构建和 Rust 编译边界。`workflow_dispatch` 才构建、校验和上传便携 Benchmark 发布包。以上步骤均不执行工程性能样本；10% 回退的提交门槛由开发者在本地人工控制。

完整命令清单与逐项门禁条件见[验证](validation.md)。远程 CI 只运行无工程样本的单元测试、静态检查和构建；真实与合成工程样本、性能矩阵只在开发者本地运行。

批量冷暖、比较与报告使用 `npm run bench -- ...`，命令、注册表与报告约定见 [Benchmark CLI](benchmark.md)；单机验收步骤见[性能测试指南](performance-guide.md)。详细 Trace、CPU/Allocation/Heap Profile 和 GPU Query 需要显式 `--diagnostics` 配置；WPR/PMC 系统录制入口当前关闭（`authenticated-system-helper-required`），离线 WPA 摘要另需本地 WPAExporter 与冻结 `.wpaProfile`，Perfetto 只用于查看导出的私有 Trace。

原生侧：

```powershell
cargo check --manifest-path desktop/src-tauri/Cargo.toml
cargo test --lib --manifest-path desktop/src-tauri/Cargo.toml
cargo test --manifest-path crates/gim-native-core/Cargo.toml
```

## Android 与 Python 工具

Android 从 `app/` 执行，环境要求（JDK 17、Android SDK 36、NDK 28+、Rust Android target）与构建步骤见 [App README](../app/README.md)：

```powershell
cd app
npm ci
npm run dev
npm run build
npm test
```

Python 工具位于 `tools/`，各自维护 `.venv` 与打包配置；构建、参数和排查见 [tools/README.md](../tools/README.md)。工具的目录归属见[项目目录](architecture.md#项目目录与模块归属)。

## 工作区与临时目录

- 测试与验证的临时输入、缓存、子进程 `TEMP/TMP/TMPDIR` 必须位于工作区 `tmp/`；权威 Benchmark 结果和 Trace/Profile 也保存在 `tmp/gim-bench/`，`output/` 默认写入匿名派生视图（显式非匿名 survey 例外）。
- 不读取、写入或清理系统目录作为测试数据；Node 测试入口通过 `scripts/with-workspace-temp.mjs` 设置临时目录。
- `demo/` 是开发者自备模型目录，不进入 Git；基础功能样本使用 [`desktop/local-tests/mini-samples.example.json`](../desktop/local-tests/mini-samples.example.json)，缺样本明确跳过。
- 性能样本按形成目的登记在 [`benchmarks/l0/`、`l1/`、`l2/`](../benchmarks/README.md)，GIM 文件不随仓库分发。
- 样本缺失导致的 skip 不是通过；本地 Benchmark 报告只代表所记录的构建、样本和运行环境。

## 持久化与运行时资产

首次正式发布前 SQLite 物理 schema 固定为 v1；开发库结构变更由开发者删除旧数据重建，不维护开发版迁移。语义、DEV 几何、IFC 等派生缓存分别按[缓存域](architecture/caches.md)失效。

`desktop/public/worker-bundle.js`、`libarchive.wasm` 和 `wasm/web-ifc*.wasm` 是运行时资产，随项目提交，由桌面脚本在 `predev`/`prebuild` 阶段准备。修改打包或缓存时，按[平台、安全与发布](architecture/platform.md)及[缓存域](architecture/caches.md)核对。

## 文档维护

长期文档只描述当前状态：

- 架构在 `docs/architecture/`，工程实体在 `docs/engineering/`，格式在 `docs/schema/`；
- 未关闭缺陷只在 [`docs/open-issues.md`](open-issues.md) 维护；
- 写作约定、文档地图与单一权威表见[文档首页](README.md)；
- 研究材料在 `research/`，复核后把稳定结论并入 `docs/`，不把研究候选写成产品事实。

需要重新生成或核对机器目录索引时，可在 `desktop/` 手动执行：

```powershell
npm run check:engineering-catalog
```

Markdown 文档不作为 CI 测试输入；事实正确性仍需对照源码和运行证据。

## 相关文档

- [系统架构](architecture.md)：系统边界、目录归属与运行时主干。
- [分层与依赖](architecture/layers.md)：目录所有权与依赖规则。
- [验证](validation.md)：证据边界、不变量与门禁选择。
- [Benchmark CLI](benchmark.md)：批量冷暖、比较与报告。
- [性能测试指南](performance-guide.md)：单机验收的 SLO 与步骤。
- [文档首页](README.md)：文档地图、写作约定与单一权威表。
