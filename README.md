# GIM Viewer

面向电网工程信息模型的本地浏览器：变电工程提供 CBM 层级、IFC/MOD/STL 三维与属性，
线路工程提供塔位、导线、跨越对象的地图和来源浏览。
桌面端支持变电与线路；`app/` 为 Tauri 2 Android 线路端，提供现场地图、工程树、来源与定位。

## 目录

| 目录 | 内容 |
|---|---|
| [desktop](desktop/) | 桌面前端、Tauri/Rust 后端、构建和测试 |
| [app](app/) | Android 线路应用、SAF 导入、地图与本地缓存 |
| [packages](packages/) / [crates](crates/) | 跨端共享纯线路解析、插件接口、原生解压与 Android 文件导入 |
| [docs](docs/README.md) | 当前规格、架构、验证、性能、格式和未决事项 |
| [demo](demo/) | 本地 GIM 包及解包样本，大型文件由 Git 忽略 |
| [research](research/) | 原始研究材料，使用前需复核 |

## 桌面开发

```powershell
cd desktop
npm install
npm run tauri:dev
```

`npm run dev` 可启动浏览器开发模式。构建使用 `npm run build`，
桌面打包使用 `npm run tauri:build`，包含 portable ZIP 生成流程。
运行时资源和发布约束见 [架构](docs/architecture.md)，测试与严格样本门禁见 [验证](docs/validation.md)。

桌面线路默认在线底图为 OSM；桌面与本机浏览器开发预览可在根 `.env` 配置
`VITE_TIANDITU_KEY`，不要提交真实 Key。Android 安装包不携带开发密钥，用户在地图设置中手动配置；
未配置时使用 OSM。移动端构建和配置方法见 [App README](app/README.md)。
底图异常时按配置回退 OSM 或 Canvas 工程覆盖层。
解析与缓存本地运行，在线底图需要网络。

## 文档

- [桌面软件规格](docs/software-spec.md)
- [系统架构](docs/architecture.md)
- [GIM 格式与匿名样本](docs/schema/README.md)
- [正确性验证](docs/validation.md)
- [性能测量](docs/performance.md)
- [移动端状态](docs/mobile-spec.md)
- [未决事项与待开发功能](docs/open-issues.md)
