# GIM Blender

独立的 Windows x64 工具。窗口只提供三个操作：

1. **导入 GIM**：缓存原文件，自动解析设备与建筑，生成 `.blend`、GLB、HTML 和漫游碰撞数据。导入完成后显示“可漫游”；相同源 SHA 的完整结果会复用。
2. **删除所选**：删除该项目的缓存和转换结果，保留用户最初选择的外部原文件。
3. **启动 HTML Demo**：启动仅监听 `127.0.0.1` 的本地服务并打开默认浏览器。在网页中选择工程即可开始第一人称漫游。关闭工具窗口会停止它自己的服务。

浏览器在独立进程中启动，不阻塞工具窗口。Windows 下按系统 HTTP 默认浏览器关联启动，并隔离冻结程序的 DLL 搜索目录。Edge、Chrome 等 Chromium 浏览器分别使用 `data/browser/msedge/`、`data/browser/chrome/` 等独立漫游会话，避免不同浏览器共享配置及已有实例的权限状态冲突。收到浏览器对首页的请求后才显示已打开；失败或超时会明确提示，服务地址仍可见并可点击重试。

工具不提供单独的转换、导出或服务器配置按钮。导入期间可查看真实阶段进度，失败原因显示在窗口中；失败项目可重新导入或删除。关闭窗口中止转换后，再导入会重建未完成结果。

导入使用工具内置的文件选择器，不调用 Windows Shell 的原生文件弹窗。目录在后台读取；可切换文件夹、返回上一级，也可在“文件名”栏粘贴完整 GIM 路径。读取慢目录时仍可取消或改选其他路径，中文名和空格路径均受支持。

## 使用

解压整个目录，运行 `gim_blender.exe`。必须保留 `_internal/` 和随包提供的 `runtime/`。目录包不向系统临时目录自解包，也不要求用户安装 Python、Node.js 或 7-Zip。

包含 Blender 的便携包可以直接转换。未包含 Blender 的精简构建会依次检查 `GIM_BLENDER_EXE`、程序旁的 `runtime/blender/blender.exe` / `blender/blender.exe`、PATH 和常见安装目录。该工具当前本地验证使用 Blender 5.3.0 beta Windows x64；不把其他版本视为已验证。

在浏览器中：WASD 行走、鼠标环顾、E 开关门、Space 跳跃、M 整站地图、R 返回整站大门、Q 返回工程选择、Esc 暂停并释放鼠标。

工程名称来自 GIM 自身元数据；没有工程名时显示“电压等级变电站#源SHA前六位”。浏览网页和切换工程均不触发重复转换。

## 数据位置

所有可写内容都在 exe 同目录的 `data/`，安装目录需可写：

```text
gim_blender/
├─ gim_blender.exe
├─ _internal/                    # Python、Node、独立转换器、IFC WASM、网页资源
├─ runtime/blender/              # 包含 Blender 的便携构建
└─ data/
   ├─ projects/<源SHA256>/
   │  ├─ source.gim              # 原文件的缓存副本
   │  ├─ project.json            # v1 状态、显示名称与转换结果摘要
   │  ├─ work/                   # 解包、解析、构建和碰撞中间文件
   │  └─ result/
   │     ├─ project.blend
   │     ├─ project.glb
   │     ├─ manifest.json
   │     └─ web/                 # HTML 漫游
   └─ tmp/                       # 导入日志及程序临时文件
```

`result/web/index.html` 通过 HTTP 使用。工具的服务只暴露已完成项目的 `web/` 和选择页，不提供原 GIM、构建目录、目录列表或远程写入接口。服务器使用系统分配的空闲端口，不占用已有的 8765 / 8785 服务。

工具服务从程序资源提供当前 JS/CSS/Three 运行时，从项目缓存提供模型和导航数据。因此控制与渲染更新无需重新转换旧项目；直接导出的独立 `result/web/` 副本则保留生成时的前端版本。

漫游运行时缓存静态模型矩阵，仅同步明确可动的门；门的交互位置随动画更新。低渲染帧率时用最多 25 ms 的物理分步推进人物，单帧最多补偿 250 ms，保留每步的完整碰撞检测。模型数量、材质、阴影和渲染分辨率不通过本优化缩减。

完整 GLB 解码结束后即终止 Draco 解码线程并释放其临时 WASM 资源；场景几何保留在渲染器中，不影响后续漫游。这是一次完整加载的场景，不在漫游阶段继续用该解码器流式加载几何。

## 独立实现和边界

- `engine/snapshot/` 保存工具自己维护的解析、装配、MOD/STL 编译实现与必要数据副本；`snapshot.json` 记录初始副本的文件身份，工具数据版本为 v1。
- `assets/scripts/` 保存工具自己的 IFC、站点画像、Blender 构建、源网格碰撞实现。`assets/web/` 自带 Three.js、Draco 和第一人称漫游代码。
- 运行和构建不读取、不调用主程序、`desktop/` 或研究目录；不启动 Viewer Worker。Node 引擎只从本工具源码和本工具 `node_modules` 打包，构建入口校验输入位于本工具内。
- 设备沿真实 CBM → DEV / PHM → MOD / STL 引用与逐边矩阵装配，保留来源 occurrence。IFC 从包内完整路径清单发现，不固定物理目录。复合检修门保留原框与原门板，身体碰撞、楼面、斜坡和动态门保持一致。
- 默认是 LOD0 浏览近似。可见几何不支持项会标为“部分表示”，不会因此宣称完整；缺失引用、循环、空几何或 IFC 覆盖失败不会发布“可漫游”结果。源模型和施工精度仍需开发者复核。
- GIM 合批按实际放置后的几何位置分块，避免源 Entity 的远端异常坐标挤占正常设备的 Draco 精度。异常源几何仍保留，不通过移动或删除源对象把异常伪装成完整模型；源空 Entity 与坐标异常需在本地验证中单列。

这是从研究实现迁出的独立工具，不是主程序 SDK，也不承担主程序的自我校核。更新工具的来源算法后，用本地样本结果对照，不能重新引入运行时主程序依赖。

派生几何算法更新后，旧导入项目需要在工具内删除对应缓存再重新导入，才能应用新的几何结果；外部原 GIM 保留。开发版缓存不做自动迁移。

## 开发和构建

从仓库根目录运行：

```powershell
# 独立安装 npm 和 Python 构建依赖，生成目录包
.\tools\gim_blender\build.ps1

# 包含已有 Blender 便携目录，生成可解压即用的 ZIP
.\tools\gim_blender\build.ps1 -SkipInstall `
  -BlenderDirectory C:\Tools\blender-5.3.0-beta -Publish

# 源码窗口（Node 引擎需已构建）
.\tools\gim_blender\.venv\Scripts\python.exe .\tools\gim_blender\app.py
```

产物：`tools/gim_blender/dist/gim_blender/gim_blender.exe` 和可选 `dist/gim_blender.zip`。构建仅消费本工具、`tools/build-common.ps1` 的路径保护函数、独立 npm/Python 环境，以及显式指定的第三方 Blender 目录。旧产物保留在工作区 `tmp/tool-build/gim-blender/previous-*`，由开发者按需要处理；构建失败不删除它们。

开发时所有样本、测试输出和子进程临时目录使用工作区 `tmp/` 或 `output/`。不要在工具源码旁运行样本测试。以下是显式本地检查，不添加到远程工程样本 CI：

```powershell
$env:TEMP = "$PWD\tmp\gim-blender-tests"
$env:TMP = $env:TEMP; $env:TMPDIR = $env:TEMP
$env:PYTHONDONTWRITEBYTECODE = '1'
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
.\tools\gim_blender\.venv\Scripts\python.exe -m unittest discover -s tools/gim_blender/tests/unit -v
node tools/gim_blender/tests/unit/test_runtime.cjs
```

真实工程验证把完整目录包复制到 `tmp/` 后，使用冻结 EXE 导入、提供服务并用 `tests/local/browser.cjs <URL> <工作区输出目录>` 复核。该浏览器脚本针对本地 110-A2-1 的已知回归位置，不能当作任意工程的通过判据。

文件选择器的本地冻结版检查可使用 `gim_blender.exe --picker-check <工作区GIM路径> --home <工作区已有项目库> --check-result <工作区JSON路径>`。该入口通过程序自己的 Tk 按钮和事件循环验证列举、选中文件、导入回调及缓存复用，不使用外部桌面自动化；只消费开发者明确暂存的样本。

首次转换与默认浏览器启动的本地检查使用 `gim_blender.exe --flow-check <工作区GIM路径> --check-result <工作区JSON路径>`，要求 exe 旁项目库为空。它走实际文件选择、导入和启动按钮，并记录系统浏览器对本地首页的真实请求。`tests/local/substation02_flow.cjs <URL> <项目缓存目录> <工作区输出目录>` 校验实际 GLB 的来源覆盖及键鼠操作；浏览器校验结束后由调用方在检查 JSON 旁创建同名 `.done` 文件结束服务。该流程不能复用已有项目库。

性能和跨工程可达性仍由开发者选择本地复核范围，工具不自动批准基线。

性能调查入口为 `tests/local/performance.cjs <工作区暂存目录> <变体列表>`；测试仅消费暂存的真实网页产物，记录 GPU、模型计数、帧耗时、JS CPU、碰撞查询及堆驻留。`tests/local/slow_frames.cjs` 复核低渲染帧率下的实际移动和关门阻挡。它们是显式本地任务，不在远程 CI 中运行；比较须保持相同模型、视角、分辨率和计时条件。
