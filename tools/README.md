# GIM 辅助工具

三个独立的 Windows 桌面小工具，用于快速查看设备、识别工程实体和浏览 GIM 文件信息。它们使用 Python + PySide6，分别维护自己的运行环境和打包配置。

| 工具 | 定位 | 输入 | 主要能力 | 单文件产物 |
|---|---|---|---|---|
| [gim_device](gim_device/README.md) | 设备 GIM 简易查看器 | 设备 `.gim` 包 | 递归装配、MOD/STL 三维预览、属性、视图截图 | `gim_device/dist/GIM设备查看器.exe` |
| [gim_element](gim_element/README.md) | 简易实体识别工具 | 变电 `.gim` 包或解包目录 | 识别设备、装置性材料、构件；未归类对象单列“其他”；导出 HTML / CSV / JSON | `gim_element/dist/GIM实体盘点器.exe` |
| [gim_info](gim_info/README.md) | 简易 GIM 文件信息浏览器 | 已解包的 GIM 目录 | 浏览键值、XML、文本及二进制预览；指针跳转、反向引用、搜索和链清单导出 | `gim_info/dist/GIM信息阅读器.exe` |

所有工具都持有自己的实现与资源，运行和打包不导入、不调用、不读取 GIM Viewer 主程序。`gim_element` 自带标准索引、分类词典和 Python 识别算法，通过数据版本、共同的纯数据用例及开发者本地结果对照验证一致性。它的输出可辅助审查主程序，不能替代工程实例的人工真值。`gim_info` 默认浏览文件与指针，不建立三维模型；旧版实体界面只保留在源码的 `--legacy` 入口。

## 运行与构建

统一使用 Windows x64、Python 3.12。`gim_device` 需要完整 PySide6（包含 QtWebEngine）；另外两个工具使用 PySide6-Essentials。直接依赖版本记录在各自的 `requirements-build.txt` 中，传递依赖尚未按哈希完全锁定。

以下 PowerShell 命令从仓库根目录执行：

```powershell
# 首次构建：创建工具自己的 .venv、安装依赖、生成 EXE 并检查启动
.\tools\gim_device\build.ps1
.\tools\gim_element\build.ps1
.\tools\gim_info\build.ps1

# 环境已准备好：跳过安装
.\tools\gim_element\build.ps1 -SkipInstall

# 生成 ZIP，压缩包中只包含该工具的单文件 EXE
.\tools\gim_element\build.ps1 -SkipInstall -Publish

# 源码运行，使用各工具自己的解释器
.\tools\gim_device\.venv\Scripts\python.exe .\tools\gim_device\viewer_app.py
.\tools\gim_element\.venv\Scripts\python.exe .\tools\gim_element\element_app.py
.\tools\gim_info\.venv\Scripts\python.exe .\tools\gim_info\gim_reader.py
```

三个 `build.ps1` 都调用 [build-common.ps1](build-common.ps1)，保留整个 `tools` 目录即可重建。构建不依赖当前工作目录；也可在各工具目录运行 `./build.ps1`。

| 参数 | 适用工具 | 含义 |
|---|---|---|
| `-Python <解释器>` | 全部 | 创建虚拟环境时使用的解释器，默认 `python` |
| `-SkipInstall` | 全部 | 使用已有 `.venv`，跳过 pip；环境不存在时直接报错 |
| `-NoVenv` | 全部 | 直接使用 `-Python` 指定的现成环境，不创建 venv、不安装依赖 |
| `-Publish` | 全部 | 验证成功后生成 `dist/<工具名称>.zip` |
| `-SmokeDir <目录>` | `gim_info` | 构建后对已解包目录运行冻结版 `--smoke` |

依赖从 HTTPS PyPI 安装，只接受 wheel，不使用 pip 下载缓存，安装失败重试一次。脚本不提权、不修改 PowerShell 执行策略，也不自动改变 Windows 文件安全标签。

## 打包约定

- 打包配置作为源码保存在各工具根目录：`viewer.spec`、`element.spec`、`reader.spec`。`_build/` 只存中间产物，删除后仍能重建。
- 统一输出单文件 EXE；运行时由 PyInstaller 在用户临时目录解压依赖，退出后清理。不需要随附 `_internal/`，也不向工具根目录复制第二份 EXE。
- 三份 spec 都排除从 PATH 中误收集的无版本 ICU DLL，让 Qt 使用 Windows 原生 ICU，避免 Poppler/Conda 的同名 DLL 导致 `QtCore`“找不到指定的程序”。
- 构建先校验路径，拒绝输出目录或待处理产物中的符号链接、目录联接等 reparse point。旧产物暂存到本工具的 `_build/previous-*`；新 EXE 通过归档检查（适用时）、实际启动自检及可选冒烟后删除旧产物。构建失败会保留备份，并在错误中给出位置。
- `--self-check` 只检查启动和依赖加载，不打开正式窗口、不修改用户偏好。`gim_element` 还校验归档内嵌目录数据及 ICU 排除情况；完整功能验证使用下面的冒烟入口。
- `_build/`、`dist/`、`.venv/` 和工具生成的截图、日志不提交。发布只取当前 `dist` 产物。

## 定位与 CI

三个工具独立交付，保留各自的 Python 实现。它们的分类和解析结果限于各自规则，不作为 Viewer、未来 SDK 或 Validator 的权威真值；跨实现一致性仍需开发者本地真实来源复核。工具不依赖主程序或未来的 SDK 抽取，Benchmark 继续由独立的测量契约执行。

CI 只运行 `tests/test_pure.py` 中的纯函数契约，以及构建路径安全、实际 onefile 构建和启动检查。纯函数检查不构造 GIM 包、不生成工程目录、不读取真实或合成工程样本。矩阵、IFC 文本和编码等普通值测试使用工作区临时目录作为所有子进程 TEMP/TMP/TMPDIR；错误退出即失败。

现有 `test_core.py`、指针目录测试及冻结版工程 smoke 属于开发者本地任务，不加入远程 CI。它们仍可用下面命令显式运行。构建成功的单文件 EXE 以原文件名上传；CI 不声称工程正确性或性能验收通过。

## 验证

```powershell
# 构建路径越界、目录联接及失败时保留旧产物的回归
powershell.exe -NoProfile -File .\tools\tests\build-safety.ps1

# 每个工具的合成输入测试（分别运行，避免同名 gim_core 模块互相覆盖）
.\tools\gim_device\.venv\Scripts\python.exe -m unittest discover -s tools/gim_device/tests -v
.\tools\gim_element\.venv\Scripts\python.exe -m unittest discover -s tools/gim_element/tests -v
.\tools\gim_info\.venv\Scripts\python.exe -m unittest discover -s tools/gim_info/tests -v

# 先用 -Publish 构建；以下命令核对 ZIP 并运行真正的冻结 EXE
.\tools\gim_device\.venv\Scripts\python.exe tools/tests/smoke_tool.py --tool gim_device --out output/tools-ci/gim_device
.\tools\gim_element\.venv\Scripts\python.exe tools/tests/smoke_tool.py --tool gim_element --out output/tools-ci/gim_element
.\tools\gim_info\.venv\Scripts\python.exe tools/tests/smoke_tool.py --tool gim_info --out output/tools-ci/gim_info

# 冻结版实体识别：自动构造 GIM/7z 夹具，检查截图、目录数据与识别回执
.\tools\gim_element\.venv\Scripts\python.exe .\tools\gim_element\smoke_packaged.py

# 文件浏览器：不启动 Qt 的指针分类自检与目录扫描
.\tools\gim_info\.venv\Scripts\python.exe .\tools\gim_info\ptr_kinds.py
.\tools\gim_info\.venv\Scripts\python.exe .\tools\gim_info\gim_reader.py --smoke D:\gim-samples\unpacked
```

设备查看器提供 `viewer_app.py --smoke <设备.gim> <输出.png>`，实体工具提供 `element_app.py --smoke <gim或目录> <输出.png>`；对应 EXE 接受相同参数。文件浏览器的 `--guitest <目录>` 会自检跳转、返回、索引和内容视图，并在当前目录生成截图。

设备查看器的 `tools/test_html_safety.py` 使用 Playwright + Edge 检查模型文本不能注入 HTML；`tools/test_render.py` 用于浏览器渲染回归。它们是开发辅助脚本，需要额外安装 Playwright。

## Windows 启动排查

### 脚本未签名或 EXE 无法创建临时目录

先检查执行策略、下载标记及完整性标签：

```powershell
Get-ExecutionPolicy -List
Get-Item .\tools\gim_element\build.ps1 -Stream *
icacls .\tools\gim_element
icacls .\tools\gim_element\dist\GIM实体盘点器.exe
```

`Zone.Identifier` 是下载来源标记，确认脚本来源后可用 `Unblock-File` 解除。Windows 的 **Low Mandatory Level（低完整性）标签是另一项文件属性**，`Unblock-File` 不会清除它。低完整性 EXE 会以低完整性运行，无法写入普通用户的 `%TEMP%`，可能出现 `Could not create temporary directory!`；带低完整性标签的脚本也可能被 Windows PowerShell 5.1 判为 Internet 区域。

只有确认整个工具目录中的代码和二进制可信、且确实存在误加的低完整性标签时，才对该工具目录恢复普通用户的 Medium 标签，例如：

```powershell
icacls .\tools\gim_element /setintegritylevel '(OI)(CI)M' /T /Q
```

该命令调整指定工具目录及其内容的完整性标签，不修改系统执行策略。Windows 的规则见 [Mandatory Integrity Control](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control)。

### QtCore 找不到指定的程序

使用各自的干净 `.venv` 和根目录 spec 重建，检查 EXE 是否误带 `icuuc.dll`、`icuin.dll`、`icudt.dll` 或 `icu.dll`。不要手工从 PATH、Poppler 或 Conda 复制 DLL 到产物旁边。构建的 `--self-check` 会实际加载 Qt 组件，加载失败会使构建失败。

## 输入安全边界

设备查看器对模型名称、属性和类型等写入 HTML 的文本进行转义；QtWebEngine 禁止本地内容访问远程 URL。文件浏览器将 XML 作为结构化文本展示，不把 SVG/XML 当作网页运行。

`gim_device` 和 `gim_element` 目前直接使用 Python ZIP/7z 解包，尚未接入主应用的有界解压配额。它们适合查看受信来源的样本，不能据此声称具备主应用对压缩炸弹和资源耗尽的完整防护。打开大型包及 IFC/MOD 仍可能占用较多内存和磁盘。
