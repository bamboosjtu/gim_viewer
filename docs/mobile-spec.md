# 移动端当前规格

`app/` 实现 Android 输电线路查看应用，基于 Tauri 2、TypeScript/Vite 和 MapLibre。
需求与验收基准是 [软件规格说明](../app/软件规格说明.md)，UI 参考
[响应式设计](../app/输电线路GIM地图应用响应式设计展示.png)。当前 minSdk 29、targetSdk 36。
构建方法见 [App README](../app/README.md)。剩余验收统一列于 [未决事项](open-issues.md#移动端验收与遗留问题)。

## 当前能力

| 能力 | 当前实现 |
|---|---|
| 导入与工程管理 | SAF 选择 `.gim`，ContentResolver 流式复制与 SHA，原生校验 GIMPKGT、有界解压、SQLite 入库；重复 SHA 复用，取消/失败清理，删除整个工程目录 |
| 共享解析 | 桌面与移动引用同一 `packages/powerline-core`；原生解压共用 `crates/gim-native-core`；桌面路径提供兼容出口 |
| 领域对象 | 工程、线路、耐张段、唯一杆塔、物理档、实际 CROSS 与 RawWire；共享塔多段 occurrence，导线按端点聚合，同塔跳线不进入地图物理档 |
| 树与搜索 | 虚拟列表、结构/唯一对象视图、分类筛选、塔号/塔型/线路/耐张段/跨越搜索，选择自动展开定位 |
| 地图 | Canvas 工程覆盖层优先；天地图影像/矢量/地形与标注，OSM 与 Canvas 回退；平移、缩放、全工程范围和对象点击；旧 WebView 二维瓦片，新 WebView MapLibre |
| 详情与来源 | 概览、原始属性、关系、按需单文件来源；源长度与几何估算分别展示，原始 FAM 行与键保留 |
| 杆塔预览 | 按需 HNum Worker 解析；Body 内部点标识，X/Z 等比例 SVG、拖动缩放重置，按 SHA/MOD/预览版本缓存；无数据明确降级 |
| 定位 | 用户主动点击、中文说明与前台权限后读取一次系统位置；支持精确/近似权限，15 秒超时，离开前台取消；精度、时间、目标塔水平直线距离；位置仅保留在当前会话 |
| 响应式 | <600、600–839、≥840 CSS px 布局，≥1200 三栏；工程、相机、选择、树展开与页签保持；Android configChanges 防普通旋转重建 |
| 外部扩展 | 中立 Plugin API 和 Host 注册/取消/dispose；当前没有实际外部 provider 或 DCP 接入 |

## 数据与缓存契约

原始文件事实、唯一业务对象和树中的 occurrence 分开保存。PhysicalSpan 按相同杆塔端点
或无歧义的坐标端点聚合多相、地线和 OPGW；保留每条 RawWire 及其原始端点/跳线字段。
空 CROSS 容器产生诊断，不能生成虚构跨越物。没有坐标的真实对象仍可在树与来源页访问。

属性投影限于业务对象自身 CBM、DEV 及其 FAM；装配体子零件保留完整来源引用，
不把螺栓/金具属性混入杆塔属性。原始 FAM 文本仍可逐文件查阅。
`Tower_Device` 也用于基础和绝缘子；杆塔自身设备优先按 `TOWER*` 引用确定，
缺少该引用时使用声明的 DEV 类型或 HNum 能力证据，不能仅凭实体名合并其属性。

缓存身份包含 SHA、大小及 parser 契约，HNum 预览使用独立契约；
有效版本集中维护于 [当前缓存域](architecture.md#当前缓存域)。
版本变动不修改桌面 parser 标记。原生 SQLite 保存文本 entries、语义 JSON 与预览 JSON，
事务提交后才设置完成标记。启动清理未完成导入；“我的工程”只列已完成工程。
打开缓存检查 SQLite 语义表完整性、版本、源身份、对象 ID 唯一性及数量。语义无效时重新投影；
SQLite 缺失或损坏时校验私有原包 SHA，再有界解压重建数据库。原包身份不符时明确失败，
不覆盖原包。重建完成前不替换正式数据库。

```text
filesDir/projects/<sha256>/
  source/original.gim
  cache/project.sqlite       # entries、semantics、previews
  cache/semantic/
  cache/previews/
  metadata.json
```

来源文件按关联路径从 SQLite 单条读取。MOD/STL 大几何不进入移动三维场景。
生产 Worker 使用普通 IIFE，前端编译目标为 Chrome 74。旧 Chromium 或 GL 初始化失败时使用
二维瓦片，保持相机、选择、覆盖层和定位；瓦片仅在内存中有界保留，不实现离线底图下载。
输入限额：256 MiB 源包、100000 条目、单条 64 MiB、总解压 512 MiB、压缩比 200。
路径、大小、SHA、magic、语义缓存身份错误拒绝提交；局部缺文件保留 WARNING 和来源。

## 隐私与运行边界

无账号、服务器、遥测或云同步。Android 备份和设备传输排除私有工程；不申请后台定位。定位使用 Android LocationManager，不依赖 Google Play Services；GNSS 可离线使用，近似权限取系统网络来源。
前台定位仅用于当前会话的标记与 Haversine 水平直线距离，不代表道路或步行距离。
地图服务接收所请求瓦片范围，天地图请求按协议携带 key；GIM 正文和 GPS 不主动上传。

`.env` 默认 key 通过 Rust build script 读取，前端 bundle 不内嵌 key。用户可在私有设置
中覆盖；默认 key 包含于原生安装包，因此不将该安装包当作公开密钥保管机制。
调试信息仅包含对象计数、finding 数和耗时，不含 key、GPS 或原始文件正文。

## 验证口径

共享投影的六样本测试检查对象唯一性、树可达性、跳线排除、物理档聚合、来源和预览，
并检查 JSON 恢复等价；输入缺失直接失败。原生六包测试独立执行源 SHA、7z 文件计数、
SQLite、重复身份和目录删除。两类结果分别支持语义与存储，不能代替 Android UI 验收。

手机和展开布局、真实天地图、P8 选择、属性和骨架已用浏览器预览核验。
API 36 模拟器已通过六包实际 SAF 导入，检查工程计数、原始来源、系统返回和大屏尺寸切换。
API 29 手机、原装 WebView 74 已通过 line04/line02 实际 SAF、语义计数、缓存打开、
P8 属性与 HNum 预览/缩放/重置、天地图二维底图、窗口变化、权限拒绝和受控底图回退。
模拟位置注入验证了系统前台权限、精度/时间和距离显示；受控定位来源验证了
15 秒超时、系统位置关闭和离开前台取消，包括权限结果较晚的请求入口保护。受控网络失败验证了
天地图→OSM→Canvas 后工程对象和选择保持。这些结果不代替真实 GNSS 和折叠屏设备验收。
浏览器、Windows 原生测试和 Android 模拟器时间不能证明 X Fold5 冷/暖达标。
优化 native 的 API 36 诊断构建测得 line02 一次冷导入 10.715s、两次已有工程打开 1.264s/1.031s；
这是一组模拟器记录，未包含 X Fold5 多次运行、完整响应监测和内存验收。
Release APK 另通过启动、缓存恢复和真实 SAF 重复导入检查，使用内部测试证书签名。
具体测试方法见 [验证](validation.md#移动端验证)，剩余设备与错误路径见未决事项。
