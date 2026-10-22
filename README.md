# GIM Viewer

面向电网工程信息模型的本地浏览器：变电工程提供 CBM 层级、IFC/MOD/STL 三维与属性，线路工程提供塔位、导线、跨越对象的地图和来源浏览。
桌面端支持变电与线路；Android 线路端，提供现场地图、工程树、来源与定位。

## 下载与安装

GIM Viewer 是一款面向电网工程信息模型（GIM）的开源本地浏览工具，提供 Windows 桌面版和 Android 移动版。当前桌面源码版本为 **v0.1.1**；下载页面以实际发布附件为准。Android 移动版仍为预览版（Preview），本轮桌面版本不改变 Android 版本。

| 平台          | 当前版本       | 下载                                                         | 主要功能                                                 |
| ------------- | -------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| Windows x64   | v0.1.1（源码） | [已发布 Portable ZIP](https://github.com/bamboosjtu/gim_viewer/releases/latest) | 变电站三维模型、输电线路地图、最近工程、工程层级与属性浏览 |
| Android ARM64 | v0.1.16 Preview | [下载 APK](https://github.com/bamboosjtu/gim_viewer/releases/download/android-v0.1.6-preview/gim-viewer-android-ae7df06cc83ebde26fc2cb17faf003d7b2fd8a2f.zip) | 输电线路地图、工程树、杆塔与导线属性、来源查看和现场定位 |

历史版本及发布说明：[GitHub Releases](https://github.com/bamboosjtu/gim_viewer/releases)

### v0.1.1 桌面变更

本版集中改进工程浏览：普通选择、搜索定位及相机靠近采用 L0/L1，DEV 和 IFC 的 L2 由属性面板“查看精细模型”主动触发；基础表示、连接线、当前视图和精化分别记录状态。DEV 调度加入 gate 唤醒、慢任务隔离与结果预算，连接线真实源几何增量显示，诊断读取复用会话状态；新增视角历史、大分支虚拟列表和内存压力反馈。

DEV 实例化仍为默认关闭的试点：原生对照已减少绘制调用，但基础表示启动存在回退。选择响应、IFC 隔离显示及选择提示仍有未关闭问题，完整冷暖/工程切换矩阵尚未通过。本版不宣称全站性能已达标，也不提供编辑、碰撞或工程校核功能。具体实现、测量和限制分别见[架构](docs/architecture.md)、[性能基线](docs/performance.md)及[问题清单](docs/open-issues.md)。

### Windows 桌面版

下载 Portable ZIP 后完整解压，运行其中的 `GIM-Reader.exe` 即可。软件随包提供 WebView2 Fixed Runtime，无须单独安装运行时。

**注意：** 请保留 `webview2-fixed-runtime` 目录，不要只提取 EXE 文件。

### Android 移动版

支持 Android 10（API 29）及以上的 ARM64 设备。

下载 APK 后，在手机上打开安装。首次安装可能需要允许浏览器或文件管理器安装来自该来源的应用。

应用通过 Android 系统文件选择器（SAF）导入本地 `.gim` 文件，支持输电线路工程管理、地图浏览、杆塔查询、原始属性与来源查看。

### 使用说明

- **本地数据**：GIM 文件解析及工程缓存在本地完成，无须登录账号。
- **最近工程**：默认不自动打开工程；可在“更多”菜单开启“启动时恢复上次工程”。最近工程路径只能来自本地数据库记录。
- **浏览器布局**：属性抽屉默认折叠，选中对象时按设置展开；“附加 IFC / 缓存 / IFC 细节”收在“更多”菜单。首个 IFC 可用后，加载进度保留在底部状态栏。
- **默认视角**：变电工程打开即整站远景全景，不再恢复上次相机；层级树展开状态仍会恢复。手动操作相机后本次会话不再自动改视角。
- **缓存诊断**：缓存管理以卡片展示每个工程的类型、版本、大小、更新时间和路径，支持打开、校验、复制诊断/摘要与删除；校验只报告有效或 miss reason，不会隐式重建。
- **模型细节**：普通浏览和选择使用 DEV/IFC 的浏览表示；“更多 → IFC 细节设置”可切换“自动（近景 30m）/ 远景（省略近景细节）”。DEV/IFC 的 L2 需在属性面板明确点击“查看精细模型”，支持取消或返回浏览表示。
- **加载进度**：工程打开前显示阶段进度条与已用秒数，每次打开从 0 开始计时；首个 IFC 后转入底部状态栏，不遮挡三维画布。
- **索引发布**：冷启动首开后状态栏显示“索引发布中 → 暖启动已就绪 · 属性补写中 → 索引已发布”；核心索引提交即可暖启动，属性在后台补写。发布完成前关闭应用不会损坏已解压缓存，下次打开会复用并继续补写。
- **属性面板**：概览首屏显示设备名称、类型 · 电压等级 · 所属系统，以及 ≤8 个关键参数（名称/电压/厂家/型号/容量/期次等）；工程标识默认折叠，全部原始字段保留在“参数/来源”页签并支持搜索。设计方案见 `research/property-panel-design.md`。
- **在线底图**：默认使用 OpenStreetMap；天地图 API Key 在“更多 → 设置”中填写，保存在本地数据库，不再从 `.env` 读取；保存后当前线路工程立即刷新卫星/地形/矢量按钮可用性。在线地图需要网络连接。
- **工程兼容性**：不同设计软件导出的 GIM 文件可能存在格式差异，当前版本仍在持续完善兼容性。
- **预览版本**：建议保留原始 GIM 文件，不要将应用内部缓存作为唯一的数据备份。

详细技术说明见[系统架构](docs/architecture.md)、[正确性验证](docs/validation.md)、[IFC/DEV 分级](docs/impl/performance-lod.md)和[GIM 特殊处理](docs/impl/gim-special-handling.md)。

## 开源协议与第三方组件

本项目源码采用 **MIT License**（见 [desktop/package.json](desktop/package.json) 的 `license` 字段）；发布版只有一个可执行文件 `GIM-Reader.exe`，7-Zip 解码器以字节资源嵌入其中，首次使用时释放到系统临时目录。第三方组件的许可文本见仓库 `desktop/src-tauri/third_party/7zip/License.txt`、`readme.txt` 及下表。

| 组件 | 用途 | 许可 |
|---|---|---|
| [7-Zip](https://www.7-zip.org/)（`7z.exe` / `7z.dll`，嵌入主程序） | 快速流式解压 GIM 内的 7z 归档 | GNU LGPL 2.1+，含 unRAR 限制；见 `third_party/7zip/License.txt` |
| [web-ifc](https://github.com/ThatOpen/engine_web-ifc) | IFC 解析与几何转换 | Mozilla Public License 2.0 |
| [That Open Engine](https://github.com/ThatOpen/engine_components)（components / fragments） | IFC 浏览与 Fragments | MIT |
| [Three.js](https://threejs.org/) | 三维渲染 | MIT |
| [MapLibre GL JS](https://maplibre.org/) | 线路地图 | BSD-3-Clause |
| [Tauri](https://tauri.app/) | 桌面运行时 | MIT 或 Apache-2.0 |
| [sevenz-rust](https://github.com/dyxmobile/sevenz-rust) | 纯 Rust 7z 解码回退 | MIT / Apache-2.0 |

7-Zip 二进制来自 7-Zip 官方发行版，未修改；对应源码可从 <https://www.7-zip.org/download.html> 获取。若不再需要嵌入，可移除 `desktop/src-tauri/third_party/7zip/` 并删除嵌入引用，应用会自动回退到纯 Rust 解码（速度较慢）。

在线底图数据：OpenStreetMap © OpenStreetMap contributors（ODbL）；天地图 © 天地图，需在设置中自行配置 API Key。

## 目录

| 目录 | 内容 |
|---|---|
| [desktop](desktop/) | 桌面前端、Tauri/Rust 后端、构建和测试 |
| [app](app/) | Android 线路应用、SAF 导入、地图与本地缓存 |
| [packages](packages/) / [crates](crates/) | 跨端共享纯线路解析、插件接口、原生解压与 Android 文件导入 |
| [docs](docs/README.md) | 当前规格、架构、验证、性能、格式、问题与限制 |
| [demo](demo/) | 本地 GIM 包及解包样本，大型文件由 Git 忽略 |
| [research](research/) | 原始研究材料，使用前需复核 |

## 桌面开发

要求 Node.js **>=22**（`camera-controls` 3.1.2 的 engines 约束）；CI 使用 Node 22。

```powershell
cd desktop
npm install
npm run tauri:dev
```

`npm run dev` 可启动浏览器开发模式。构建使用 `npm run build`，桌面打包使用 `npm run tauri:build`，包含 portable ZIP 生成流程。
运行时资源和发布约束见 [架构](docs/architecture.md)，测试与严格样本门禁见 [验证](docs/validation.md)。

桌面线路默认在线底图为 OSM；天地图 API Key 在桌面应用“更多 → 设置”中配置，保存在本机 SQLite（`app_setting` 表），不进入构建产物。Android 安装包不携带开发密钥，用户在地图设置中手动配置；未配置时使用 OSM。移动端构建和配置方法见 [App README](app/README.md)。

底图异常时按配置回退 OSM 或 Canvas 工程覆盖层。
解析与缓存本地运行，在线底图需要网络。

## 文档

- [桌面软件规格](docs/software-spec.md)
- [系统架构](docs/architecture.md)
- [GIM 格式与匿名样本](docs/schema/README.md)
- [正确性验证](docs/validation.md)
- [性能测量](docs/performance.md)
- [IFC/DEV 分级与加载性能](docs/impl/performance-lod.md)
- [GIM 特殊格式处理](docs/impl/gim-special-handling.md)
- [移动端状态](docs/mobile-spec.md)
- [问题与限制](docs/open-issues.md)
