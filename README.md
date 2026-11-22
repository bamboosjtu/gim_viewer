# GIM Viewer

在本地浏览电网工程 GIM 文件。Windows 桌面版支持变电站、输电线路和独立设备，Android 预览版面向输电线路现场查阅。

[下载 Windows 桌面版](https://github.com/bamboosjtu/gim_viewer/releases/tag/desktop-v0.2.1-preview) · [下载 Android 预览版](https://github.com/bamboosjtu/gim_viewer/releases/tag/android-v0.1.6-preview) · [全部发布](https://github.com/bamboosjtu/gim_viewer/releases)

## 界面预览

### Windows 桌面版

![Windows 桌面版显示 110 kV 通用设计变电站及工程导航](docs/screenshots/desktop-substation.png)

*110 kV 通用设计模型。工程导航提供设备材料清册、工程组成和来源视图。*

### Android 线路版

<img src="docs/screenshots/android-powerline.png" width="300" alt="Android 线路界面，关闭底图后仅显示杆塔、导线与工程坐标">

*移动界面的浏览器预览。示例线路使用虚构数据，截图采用无底图模式。*

## 下载后开始

| 平台 | 使用方法 |
| --- | --- |
| Windows x64 | 下载后完整解压 Portable ZIP，保留随包的 WebView2 运行时目录，运行 <code>GIM-Reader.exe</code>，打开本地 <code>.gim</code>。 |
| Android ARM64 | 支持 Android 10 及以上。解压发布附件并安装 APK，在应用内通过系统文件选择器导入本地线路 <code>.gim</code>。 |

## 功能

- **变电站与独立设备**　浏览 IFC、DEV/MOD/STL 的三维表示，通过工程树和搜索定位设备，查看分层属性和对应来源。
- **输电线路**　在地图上浏览杆塔、物理档和跨越对象，通过工程树与地图联动查看原始属性和来源。移动端支持现场定位、杆塔局部骨架预览和离线工程图。
- **本地工程管理**　解析、索引和缓存均在本机完成。暖开复用有效的工程缓存。在线底图需要网络，无底图模式可离线查阅工程。

产品行为与已知限制见[桌面规格](docs/software-spec.md)、[移动端规格](docs/mobile-spec.md)和[问题清单](docs/open-issues.md)。

## 性能基线

基线测量绑定源码提交 [`c50933d`](https://github.com/bamboosjtu/gim_viewer/commit/c50933db56c6442b136705758c1d13ba22810f6f)。下表记录 2026-11-22 在 Windows x64 固定 WebView2 下完成的原生测量，每个来源计划一组冷暖配对。

| 测量范围 | 记录数 | 结果 | 登记状态 |
| --- | ---: | --- | --- |
| L1 线路，6 个工程 | 12 | 12 PASS | 正式基线 |
| L1 变电，`substation01–03` | 6 | 4 PASS、2 PARTIAL | 已选定候选，待独立来源复核 |
| L1 变电，4 个工程 | 8 | 6 PASS、2 PARTIAL | 补充测量 |
| L0 通用设计与通用模型，48 个输入 | 96 | 75 PASS、8 PARTIAL、6 FAIL、1 INCONCLUSIVE、6 SKIPPED | 补充测量，保留所有状态 |

L1 线路正式基线的冷开首响应为 0.76–4.90 秒，完全结算为 5.05–16.74 秒。暖开首响应为 0.45–2.59 秒，完全结算为 4.03–6.00 秒。冷暖结算各六次，合计分别为 61.82 秒和 29.14 秒。

L1 变电三样本候选中，`substation02` 的冷暖开均记录来源几何缺口，六次运行的计时和内存采集均完整。以下为实际测量值，单位为秒。

| 样本 | 冷开首个可见几何 | 冷开完全结算 | 暖开首个可见几何 | 暖开完全结算 |
| --- | ---: | ---: | ---: | ---: |
| `substation01` | 10.06 | 39.86 | 2.71 | 12.73 |
| `substation02` · PARTIAL | 6.54 | 68.36 | 1.84 | 19.18 |
| `substation03` | 13.99 | 80.55 | 2.51 | 12.37 |

权威样本身份、原始测量与批准记录保存在开发者本地工作区。样本登记和批准流程见 [Benchmark 文档](docs/performance/benchmark.md)。

## 开发与开源

- [开发指南](docs/development.md) · [架构](docs/architecture.md) · [验证](docs/validation.md) · [GIM 格式](docs/schema/README.md)
- [Windows 桌面应用](desktop/) · [Android 应用](app/) · [独立工具](tools/README.md)

源码采用 [MIT License](LICENSE)。发布包中的 [7-Zip 解码器](desktop/src-tauri/third_party/7zip/License.txt)遵循其第三方许可，源码可从 [7-Zip 官方下载页](https://www.7-zip.org/download.html)取得。在线底图数据归 [OpenStreetMap 贡献者](https://www.openstreetmap.org/copyright)或天地图所有。
