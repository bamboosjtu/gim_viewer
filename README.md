# GIM Viewer

面向电网工程信息模型的本地浏览器：变电工程提供 CBM 层级、IFC/MOD/STL 三维与属性，线路工程提供塔位、导线、跨越对象的地图和来源浏览。
桌面端支持变电与线路；Android 线路端，提供现场地图、工程树、来源与定位。

## 下载与安装

GIM Viewer 是一款面向电网工程信息模型（GIM）的开源本地浏览工具，提供 Windows 桌面版和 Android 移动版。目前均为预览版本（Preview）。

| 平台          | 当前版本       | 下载                                                         | 主要功能                                                 |
| ------------- | -------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| Windows x64   | v0.0.1 Preview | [下载 Portable ZIP](https://github.com/bamboosjtu/gim_viewer/releases/download/desktop-v0.0.1-preview/GIM-Reader_0.0.1_x64_portable.zip) | 变电站三维模型、输电线路地图、工程层级与属性浏览         |
| Android ARM64 | v0.1.5 Preview | [下载 APK](https://github.com/bamboosjtu/gim_viewer/releases/download/android-v0.1.5-preview/GIM-Viewer-Android-v0.1.5-arm64.apk) | 输电线路地图、工程树、杆塔与导线属性、来源查看和现场定位 |

历史版本及发布说明：[GitHub Releases](https://github.com/bamboosjtu/gim_viewer/releases)

### Windows 桌面版

下载 Portable ZIP 后完整解压，运行其中的 `GIM-Reader.exe` 即可。软件随包提供 WebView2 Fixed Runtime，无须单独安装运行时。

**注意：** 请保留 `webview2-fixed-runtime` 目录，不要只提取 EXE 文件。

### Android 移动版

支持 Android 10（API 29）及以上的 ARM64 设备。

下载 APK 后，在手机上打开安装。首次安装可能需要允许浏览器或文件管理器安装来自该来源的应用。

应用通过 Android 系统文件选择器（SAF）导入本地 `.gim` 文件，支持输电线路工程管理、地图浏览、杆塔查询、原始属性与来源查看。

### 使用说明

- **本地数据**：GIM 文件解析及工程缓存在本地完成，无须登录账号。
- **在线底图**：默认使用 OpenStreetMap；天地图密钥可在应用设置中自行配置。在线地图需要网络连接。
- **工程兼容性**：不同设计软件导出的 GIM 文件可能存在格式差异，当前版本仍在持续完善兼容性。
- **预览版本**：建议保留原始 GIM 文件，不要将应用内部缓存作为唯一的数据备份。

详细技术说明见[系统架构](docs/architecture.md)、[正确性验证](docs/validation.md)和[移动端规格](docs/mobile-spec.md)。

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

`npm run dev` 可启动浏览器开发模式。构建使用 `npm run build`，桌面打包使用 `npm run tauri:build`，包含 portable ZIP 生成流程。
运行时资源和发布约束见 [架构](docs/architecture.md)，测试与严格样本门禁见 [验证](docs/validation.md)。

桌面线路默认在线底图为 OSM；桌面与本机浏览器开发预览可在根 `.env` 配置`VITE_TIANDITU_KEY`，不要提交真实 Key。Android 安装包不携带开发密钥，用户在地图设置中手动配置；未配置时使用 OSM。移动端构建和配置方法见 [App README](app/README.md)。

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
