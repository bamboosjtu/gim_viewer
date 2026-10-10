# 线路 GIM Android 应用

基于 Tauri 2、TypeScript、MapLibre 的本地线路查看应用。需求基准为
[软件规格说明](软件规格说明.md)，布局参考 [响应式设计](输电线路GIM地图应用响应式设计展示.png)。
当前实现、边界和验证口径统一见 [移动端规格](../docs/mobile-spec.md)。

## 开发与构建

```powershell
cd app
npm ci
npm run dev
npm run build
npm test
python scripts/prepare-samples.py
npm run test:sample
```

样本准备读取 `demo/line01.gim` 至 `line06.gim`，输出到忽略目录 `output/mobile-samples/`；
需要 Python `py7zr`。不覆盖 `demo/`，六包测试缺少输入会失败，不自动跳过。
浏览器开发模式有本机样本入口，使用 IndexedDB 模拟缓存；正式 Android 构建没有样本入口。
浏览器预览不能验证 SAF、Android 私有 SQLite 或定位权限。

Android 环境需要 JDK 17、Android SDK 36、NDK 28 或以上、Rust Android target。
提交的 Android 工程固定 minSdk 29 / targetSdk 36，AGP 8.13、Gradle 8.14.3、Kotlin 2.2.20。

```powershell
# 在 app/ 下；按本机路径设置环境变量
$env:JAVA_HOME='C:/Program Files/Java/jdk-17'
$env:ANDROID_HOME='D:/ProgramData/Android/Sdk'
$env:NDK_HOME='D:/ProgramData/Android/Sdk/ndk/28.2.13676358'
rustup target add aarch64-linux-android x86_64-linux-android
./scripts/android.ps1 -Task build -Debug
# 或：npm run tauri -- android build --target aarch64 --apk --debug
```

已有 `src-tauri/gen/android/` 工程可直接构建，不需要重复 init。若重新生成，需保留 SDK、
Gradle 版本、备份禁用和数据提取规则等项目配置。调试 APK 用于安装验证；正式签名和发布
需完成 [未决验收](../docs/open-issues.md#移动端验收与遗留问题)。
Release 开启 R8，并加载 Android 默认优化规则及项目的 Jackson 枚举反射保留规则；
不能仅凭 Debug 启动成功认定 Release 可用。发布 APK 需用正式 keystore 签名。
本地内部测试包使用 Android 调试证书签署优化 Release，供安装验收，不作为正式发布签名。

## 密钥与存储

Android 安装包不读取或内嵌 `.env` 密钥。首次安装的天地图密钥为空，用户在“地图设置”
中手动配置，保存在应用私有目录；未配置时使用 OSM，在线底图失败仍可查看工程图。
根目录 `.env` 的 `VITE_TIANDITU_KEY` 仅供 Vite 本机浏览器开发预览使用，开发路由不进入发布包。
旧格式设置中的密钥在升级时清除一次，避免沿用旧包自动写入的开发配置；新版手动配置正常保留。
地图请求向所选底图服务发送用户配置的密钥和瓦片范围。

工程保存于 Android 应用 filesDir 下 `projects/<sha256>/`：源 GIM、SQLite 文本来源与语义/
预览缓存、metadata。SAF 流式复制和校验，原生解压受配额约束，Worker 建立对象与索引。
删除工程会删除整个私有工程目录。定位仅在用户主动点击且授权后读取，不持久化位置。

## 共享模块

- `packages/powerline-core`：桌面/移动共用的 CBM/FAM/DEV、线路 MOD、graph 与路径解析；移动领域投影、距离和 HNum 预览也在纯模块中。
- `crates/gim-native-core`：两个平台共用的有界容器解压，移动路径输入无需经 JS 读取整包。
- `crates/tauri-plugin-gim-import`：Android SAF、ContentResolver 流式复制、SHA、取消与进度，以及 Android 系统前台定位、WindowInsets 和地图沉浸窗口控制。
- `packages/plugin-api`：中立 provider 接口；`src/plugins/host.ts` 提供注册、取消与 dispose。尚无实际外部业务插件。

应用不依赖 IFC、Three.js、桌面 Viewer 或悬链线运行时。工程覆盖层先用 Canvas 显示，
底图按设置加载，天地图失败回退 OSM，再回退 Canvas。生产解析 Worker 为普通 IIFE，
兼容 Android 10 的 WebView 74；旧 WebView 使用有界二维瓦片渲染，支持相同的天地图、
OSM 和工程交互，新版 WebView 使用 MapLibre。瓦片缓存只在内存中，最多保留 192 项。

工程树和详情面板均可通过底部导航独立打开/收起，所有屏宽均提供关闭按钮。
“地图”收起两者；选择对象打开详情，窄屏下同时关闭覆盖地图的工程树。
新工程默认收起面板，用户选择按工程保存，折叠/展开和旋转不重置；收起后地图占据释放的区域。


普通界面采用 edge-to-edge：WebView 铺满窗口，原生只发布安全区 CSS 像素，Header、底部导航
和浮动控件避让系统栏/刘海。Header 内容区为 52 CSS px，蓝色背景延伸至状态栏。
地图工具栏分别提供“显示完整工程”和“进入/退出沉浸地图”。沉浸地图覆盖整个窗口，隐藏
树、详情、底部导航及系统栏；边缘滑动临时唤回系统栏。返回键、设置、我的工程或离开前台
恢复普通界面；面板偏好与地图视角保留，全屏状态不持久化。
前台恢复、窗口尺寸变化和模式切换完成后刷新原生安全区；较新的 Insets 事件优先于过期查询。
旧 WebView 的控件安全间距在 JS 中计算，窗口高度保留 `100vh` 回退。
Android 当前最小屏宽小于 600dp 时固定竖屏；折叠展开或进入平板尺寸后解除方向限制，保留其他布局。
沉浸地图中选择对象，在左下方显示可关闭的概览浮层，与详情页共用指标来源；右侧工具可操作。
概览采用紧凑标签/值布局：窄屏（<600 CSS px）单列，每行左侧标签、右侧数值；较宽窗口双列，长关系占整行。关闭和查看详情保留 44 CSS px 点击区域。
“查看详情”退出沉浸并打开当前对象概览；浮层不挤占地图，也不加载隐藏详情的塔形预览。

选择工程根节点时，概览、属性和来源页展示私有源 GIM 的头部元信息：工程名称、设计单位、
原始单位、导出软件/时间和标准标识，并保留字节偏移及编码。只有匹配在册分段布局的头部
才赋予字段角色；未知布局展示未命名原值，空字段不补造，未确认单位不标为软件厂商或业主。
头部独立按需读取并校验源身份，不改写语义缓存版本或重新导入既有工程。
