# GIM Blender

独立的 Windows x64 变电站漫游工具。GUI 只提供三个操作：导入 GIM、删除已导入项目、启动 HTML Demo。

转换器使用 [snapshot.json](snapshot.json) 标记的工具专属冻结快照。该快照采用自己的转换契约和数据版本，不随 Viewer 或 SDK 自动同步。清单记录这份快照首次随仓库提交的版本和时间。更新快照时须更新源文件摘要和可核对的来源记录，并验证工具自己的转换结果。CI 构建独立 Node 转换器。

## 运行方式

解压完整目录，运行 `gim_blender.exe`。导入时自动缓存原 GIM 并转换为 Blender、GLB、HTML 和导航数据。重复导入同一源 SHA 会使用已有完整结果。删除只处理工具内对应缓存，保留外部原文件。

**启动 HTML Demo 只调用独立 Node 命令行服务。** GUI 不承载 HTTP，不参与浏览器渲染；关闭 GUI 后服务继续运行。窗口顶部固定显示服务状态、端口和可复制的网址。

也可完全不运行 GUI，双击 `start_demo.cmd`：

```powershell
.\start_demo.cmd
# 指定端口（占用时自动递增）
.\start_demo.cmd --port 8770
# 停止当前目录对应的独立服务
.\stop_demo.cmd
```

命令行会打印实际端口、完整地址和 PID。默认从 8765 开始寻找空闲端口，重复启动复用当前数据目录对应的服务。浏览器优先使用已安装 Chrome 的普通会话，不创建工具专用浏览器配置，也不添加 GPU、沙箱或后台调度覆盖参数；未自动打开时可复制地址到浏览器。

网页首页展示已完成项目，点击后直接导航到模拟页，不使用 iframe 宿主页，也没有二次开始确认。点击场景可锁定鼠标；WASD 行走、鼠标环顾、E 开关门、Space 跳跃、M 地图、R 回大门、Q 返回工程选择、Esc 释放鼠标。

## 目录与职责

```text
gim_blender/
├─ gim_blender.exe          # GUI 与导入命令入口
├─ _internal/              # Python、独立转换器与 IFC WASM
├─ runtime/node.exe        # 独立 Node 运行时
├─ runtime/blender/        # 可选 Blender 便携运行时
├─ server/server.cjs       # 仅 Node 内置模块的 HTTP 服务
├─ demo/                   # 独立漫游前端、Three、Draco
├─ start_demo.cmd
├─ stop_demo.cmd
└─ data/
   ├─ projects/<源SHA256>/
   │  ├─ source.gim
   │  ├─ project.json
   │  ├─ work/
   │  └─ result/
   │     ├─ project.blend
   │     ├─ project.glb
   │     ├─ manifest.json
   │     └─ web/assets/    # 场景、模型及碰撞
   ├─ service/server.json  # 当前独立服务地址与身份，协议 v1
   ├─ service/server.log   # GUI 启动的命令行输出
   └─ tmp/                 # 导入日志与临时文件
```

服务只需要 `runtime/node.exe`、`server/`、`demo/` 和已转换的 `data/`。不需要 GUI exe、Python、Blender或 `_internal/`，也不调用转换器。它只读取 v1 项目清单和网页资产，仅监听 127.0.0.1，不提供 GIM 原文件、构建目录、目录列表、模型上传或删除接口。停止命令只控制通过身份检查的本目录服务。

GUI、转换器和 HTTP 服务分别独立。服务读取程序旁 `demo/` 的当前前端和项目缓存中的几何/导航；只更新前端不需要重新转换。`result/web/` 的独立导出副本保留生成时前端版本。

## 转换边界

工程名称来自源元数据；没有工程名时用电压等级和源 SHA 前六位。CBM → DEV/PHM → MOD/STL 按真实引用、逐边矩阵和分支防环装配，IFC 按完整包内路径发现。工具自己持有解析、几何实现和字典副本，运行及构建不读取主程序、desktop 或研究目录。

默认 LOD0 浏览近似，不是施工交付精度。源空 Entity、不可表示项会保留“部分表示”，缺失引用、循环、空几何或 IFC 覆盖失败不会发布为可漫游。几何合批按实际放置位置分块，避免远端异常源参数损害正常设备的压缩精度；不修改原始源参数。派生几何算法更新需由开发者删除旧缓存重建，不维护旧开发格式迁移。

导航按工程实际范围生成，不以固定 400 米门槛拒绝大站，也不裁掉范围外设备。普通导入复用缓存时建立的源 SHA，不再次读取整份 GIM 计算身份。两套装配结果逐项对账、顶点放置探针和对照文件只在开发者显式设置 `GIM_BLENDER_VERIFY_ASSEMBLY=1` 时运行；保留实际解析、有限坐标、数组读取和来源引用所需的检查。

`demo/` 是必需的网页运行资源，须与 exe 一同保留。导入会先确认模板入口存在，再启动几何转换；发布包缺失模板时给出资源缺失提示，不回退到已废弃的 `_internal/assets/web`。删除大量缓存文件在后台执行，避免阻塞窗口。

漫游保留全量当前策略下的模型、碰撞和门交互。静态矩阵缓存、解码完成后释放 Draco 线程及低帧率物理分步只处理运行时开销；不通过删模型或降低覆盖率制造性能收益。

楼梯、台阶和踏步的源踏面在转换时写入楼面导航，人物随实际踏面升降。除了 IFC 楼梯类型，也识别“双跑U型楼梯”等代理对象名称；楼梯栏杆、扶手继续作为身体碰撞物。名称只解释当前来源对象，不用于跨对象绑定或猜测放置位置。

## 开发与打包

Windows x64、Python 3.12、Node 22+。构建入口：

```powershell
.\tools\gim_blender\build.ps1
.\tools\gim_blender\build.ps1 -SkipInstall -BlenderDirectory C:\Tools\blender-5.3.0-beta -Publish
```

目录包在 `tools/gim_blender/dist/gim_blender/`，ZIP 在 `dist/gim_blender.zip`，不包含用户 data 或 GIM。目录需可写。精简包自动检测 Blender，也可设置 GIM_BLENDER_EXE。

源代码中的独立服务可这样启动：

```powershell
node tools/gim_blender/server/server.cjs --data <数据目录> --runtime tools/gim_blender/assets/web --port 8765 --open
```

测试输入、结果和子进程临时目录必须在工作区 tmp 或 output。显式本地检查包括：

```powershell
# 先将 TEMP/TMP/TMPDIR 指向已创建的工作区临时目录
.\tools\gim_blender\.venv\Scripts\python.exe -m unittest discover -s tools/gim_blender/tests/unit -v
node tools/gim_blender/tests/unit/test_runtime.cjs
node tools/gim_blender/assets/scripts/ifc_navigation_roles.test.cjs
node tools/gim_blender/server/server.test.cjs <工作区暂存目录>
```

真实样本及浏览器路线检查在 `tests/local/`，不加入远程工程样本 CI。浏览器性能必须核对同一模型、浏览器、GPU、分辨率和路线；无法复现用户卡顿时明确报告测量缺口，不自动接受性能基线。
