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

根目录 `.env` 的 `VITE_TIANDITU_KEY` 在本机 native build 时读取，首次启动作为默认配置，
之后由地图设置保存在应用私有目录。密钥没有写入前端源文件或前端构建常量；原生安装包
包含默认配置，安装包应按私有分发范围管理。地图请求向所选底图服务发送密钥和瓦片范围。

工程保存于 Android 应用 filesDir 下 `projects/<sha256>/`：源 GIM、SQLite 文本来源与语义/
预览缓存、metadata。SAF 流式复制和校验，原生解压受配额约束，Worker 建立对象与索引。
删除工程会删除整个私有工程目录。定位仅在用户主动点击且授权后读取，不持久化位置。

## 共享模块

- `packages/powerline-core`：桌面/移动共用的 CBM/FAM/DEV、线路 MOD、graph 与路径解析；移动领域投影、距离和 HNum 预览也在纯模块中。
- `crates/gim-native-core`：两个平台共用的有界容器解压，移动路径输入无需经 JS 读取整包。
- `crates/tauri-plugin-gim-import`：Android SAF、ContentResolver 流式复制、SHA、取消与进度，以及 Android 系统前台定位。
- `packages/plugin-api`：中立 provider 接口；`src/plugins/host.ts` 提供注册、取消与 dispose。尚无实际外部业务插件。

应用不依赖 IFC、Three.js、桌面 Viewer 或悬链线运行时。工程覆盖层先用 Canvas 显示，
底图按设置加载，天地图失败回退 OSM，再回退 Canvas。生产解析 Worker 为普通 IIFE，
兼容 Android 10 的 WebView 74；旧 WebView 使用有界二维瓦片渲染，支持相同的天地图、
OSM 和工程交互，新版 WebView 使用 MapLibre。瓦片缓存只在内存中，最多保留 192 项。
