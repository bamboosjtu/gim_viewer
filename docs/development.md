# 开发与本地验证

本页记录开发入口、样本和工作区文件约定。运行时结构与模块边界见[架构](architecture.md)及[分层与依赖](architecture/layers.md)，正确性门禁见[验证](validation.md)。

## 工作区和测试

- 从 `desktop/` 执行桌面 npm 命令；Android 命令从 `app/` 执行。Node.js 版本要求见根目录 [README](../README.md#桌面开发)。
- 测试和验证的临时输入、缓存、子进程 `TEMP/TMP/TMPDIR` 位于工作区 `tmp/`，可分享的报告位于 `output/`。不把系统目录作为测试输入、输出、暂存或清理目标。
- `demo/` 是开发者自备模型目录，不进入 Git。基础功能样本使用 [`desktop/local-tests/mini-samples.example.json`](../desktop/local-tests/mini-samples.example.json)；缺样本明确跳过。性能样本按形成目的登记在 [`benchmarks/l0/`、`l1/`、`l2/`](../benchmarks/README.md)，GIM 文件不随仓库分发。
- 远程 CI 只运行无工程样本的单元测试、静态检查和构建；不运行真实或合成工程样本、性能矩阵。开发者自行建立样本和对照基线；[performance.md](performance.md) 只代表作者注明环境下的结果。

## 常用命令

```powershell
cd desktop
npm run dev
npm test
npm run test:sqlite
npm run test:engineering:worker
npm run check:engineering-boundaries
npm run build
npm run bench -- build
```

开发者样本的正确性回归使用 `npm run local-tests:check` 和 `npm run test:local -- --build <原生构建清单>`；批量冷暖与报告使用 `npm run bench -- batch ...`，参数见 [Benchmark](benchmark.md)。`test:engineering:worker` 使用 `desktop/tests/engineering/worker-check.html` 功能页，不读取工程样本，也不代替原生性能验收。

## 持久化与运行时资产

首次正式发布前 SQLite 物理 schema 固定为 v1。开发库结构变更由开发者删除旧数据重建，不维护开发版迁移；语义、DEV 几何和 IFC 等派生缓存分别按[缓存域](architecture/caches.md)失效。

`desktop/public/worker-bundle.js`、`libarchive.wasm` 和 `wasm/web-ifc*.wasm` 是运行时资产，随项目提交；桌面脚本负责准备。修改打包或缓存时，按[平台与发布](architecture/platform.md)及[缓存域](architecture/caches.md)核对。

## 文档位置

长期文档描述当前契约：架构放在 `docs/architecture/`，工程实体在 `docs/engineering/`，格式在 `docs/schema/`；尚未关闭的产品缺陷记入 [`docs/open-issues.md`](open-issues.md)。研究材料需复核后使用，不把真实工程名或地理归属写进 `docs/schema/`。
