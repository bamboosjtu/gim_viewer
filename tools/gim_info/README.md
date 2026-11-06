# gim_info —— 简易 GIM 文件信息浏览器

统一构建参数、产物约定、安全边界及 Windows 排查见 [tools 总览](../README.md)。

**只看文件、内容和指针**：打开解包后的 GIM 目录，KV 文件看键值、XML 看元素与属性、其它文本/二进制看原文，
沿 `cbm → cbm`、`cbm → dev → 几何`、`cbm → fam` 的引用一路点下去，随时退回来。

指针按 **`ptr_kinds.py` 的 4 组 9 种语义类型** 区分，
值列按类型着色、可按类型筛选，「类型谱系…」是简明对照表；分类口径见 **`指针类型谱系.md`**。

不做实体识别、不做四本账、不做业务树、不解析 IFC 实体语义——那些在 `gim_element/` 与 `05-模型树/`。本工具只回答四个问题：

1. 这个文件里有哪些键值 / XML 元素 / 原文？
2. 哪些值是指针、**属于哪一种类型**、跳到哪个文件？
3. 跳过去之后，怎么回来？
4. 谁指向了当前文件？（打开目录即自动建立反向索引）

双击 `dist/GIM信息阅读器.exe`（**单文件、无控制台、不依赖 `_internal`**），或 `python gim_reader.py <解包目录>`。

## 两种视图

工具栏「视图」切换：

**1. 引用链（默认）** —— 沿指针逐层展开：

```
工程  project.cbm
└ F1 工程  …                 层级 SUBSYSTEM
  └ F2 系统  …               层级 SUBSYSTEM0…
    └ F3 间隔  …             层级 SUBDEVICE/GROUP
      └ F4 设备  …           层级 SUBDEVICE0… → L5 部件
        ├ 模型 OBJECTMODELPOINTER → dev
        │   └ 几何 SOLIDMODELn → dev / phm → mod / stl
        └ 属性 BASEFAMILY → fam
```

- **属性表里每一个指针都有对应的链边**，不会漏：层级下钻 / 树外索引 / 模型锚点 / 几何装配 / 属性族 / IFC 挂接 / 逻辑模型等细分类型都在链上；
- dev / phm 节点展开 `SOLIDMODELn`/`SUBDEVICEn` → `.dev` / `.phm` / `.mod` / `.stl`；
- 第二列「指针类型」写细分类型名并着色（tooltip 只给键名族与指向），第三列是目标文件大小；
- 层名直接读 cbm 的 `ENTITYNAME`（`F1System`/`F2System`/`F3System`/`F4System`/`PARTINDEX`）；
- **打开时自动展开一条主链** `project → F1 → F2 → F3 → F4 → L5`，其余分支按需点开；每个 cbm 节点都带展开箭头，不会再停在 F2 看起来像叶子；
- 若引用指向的文件没有随包下载（例如样本只提供到 F2），链上仍以红色「待下载」节点列出该文件名，tooltip 给出应取路径 `CBM/xxx.cbm`。

**2. 按目录** —— CBM / DEV / PHM / MOD 四个目录平铺，按需展开（单目录最多列 3000 个，其余用搜索），适合"我就知道文件名"的场景。

## 跳转与返回

| 操作 | 效果 |
|---|---|
| 双击左树文件 | 打开该文件（进历史） |
| **单击键值表「值」列的彩色下划线链接** | 唯一目标直接跳转（进历史）；多义指针展示候选完整路径，用户选择后才跳转 |
| 工具栏「指针」下拉 | 只看某一种类型的键（9 种任选；XML/文本/二进制文件不参与过滤） |
| 「类型谱系…」 | 弹出 9 种类型的键名族 / 指向对照表（非模态，可边看边点） |
| 双击反向引用的来源行 | 跳到引用本文件的文件 |
| `Alt+←` / `Alt+→` | 后退 / 前进（历史栈） |
| 路径框 | 最近 40 条历史，可直接选 |
| 「根文件」 | 回到 `project.cbm` |
| 搜索 | 在全部键/值里找，双击结果跳转 |

## 内容显示：`content()` 的四种模式

| 判定 | 表头 | 显示 |
|---|---|---|
| `KEY=VALUE` | 「键 / 值」 | GIM 键值；指针值按类型着色，单击跳转 |
| **XML**（按内容嗅探，不看后缀） | 「XML 元素 / 属性」·「值」 | 元素层级缩进 + `@属性` 逐行；蓝色加粗＝元素，灰色＝属性 |
| 其它文本 | 「行 / 文本」 | IFC/STEP、ASCII STL 等按行显示原文，等宽字体 |
| 二进制 | 「偏移 / 十六进制 · ASCII」 | 前 256 字节预览 |

- **XML 用 ElementTree 解析**：`.mod`（几何模型）、`.sld`（SVG 逻辑图形）、`.std`（系统拓扑）等不再被按等号拆成 `<?xml version` / `<Entity ID` 这类假键；同名兄弟元素加 `[1]`/`[2]` 序号，元素文本写在元素行的值列。
- XML 文件不参与键值/指针扫描（`read()` 返回空），不会产生假指针；属性值若确实是指针文件名，仍显示为可单击链接。
- 长值（如 `StretchedBody` 的 `@Array`）在表里截断到 800 字符，全文在 tooltip；文本最多 1 MB / 4000 行，XML 最多 8 MB / 4000 行，超出会明确标出截断。

打开文件后左树会自动展开并高亮它（引用链视图下沿引用路径展开）。

## 指针口径：4 组 9 种

详见 `指针类型谱系.md`。按引用目标与键名族展开为实现层的 9 种：

| 组 | 类型 | 键名族 | 指向 |
| --- | --- | --- | --- |
| 层级 | L1 层级下钻 / L2 树外索引 | `SUBSYSTEMn`/`GROUPn`/`TOWER0`… · `SUBDEVICEn`→PARTINDEX、`FILEn.DEVn` | cbm → cbm |
| 模型 | M 模型锚点 / G 几何装配 | `OBJECTMODELPOINTER` · `SOLIDMODELn`/`SUBDEVICEn` | cbm → dev → phm → mod/stl |
| 属性 | A 属性族 | `BASEFAMILY` / `BASEFAMILY1..n` | cbm / dev → fam |
| 扩展 | I IFC 挂接 / U IFC 实体标识 / S 逻辑模型 / D 材料与出图 | `IFCFILE`/`IFCn` · `IFCGUID` · `SCH`/`逻辑描述文件` · `MATERIALSHEET`/`FILEn.NAME` | → ifc / IFC 内部实体 / 逻辑文件 / xml·DGN |

- **U 与 D 不是文件指针**：`IFCGUID` 是 IFC 内部 GUID，`MATERIALSHEET`/`FILEn.NAME` 是占位或包外图号；
  界面按「标识键」灰色/琥珀色标注、不生成链接，也不会被算成悬空；
- 值以 7 种模型后缀 **+ `.sch/.sld/.std/.icd/.ipd/.cpd/.gl/.xml/.dgn`** 结尾 → 指针（s01 的
  `project.cbm → SCH=project.sch → zjx.std/zjx.sld` 以前被整体漏掉）；
- 键以 `.NUM` 结尾、`TRANSFORMMATRIXn`/`COLORn`/`BLHA` 等配套参数、以及「同 UUID 伴生文件」都**不是指针**；
- 解析顺序：**显式路径 / 相对路径 → 全库唯一同名 → 多义或悬空**，路径查找不区分大小写。后缀约定目录只提供缺失文件的下载提示，不裁决同名候选；
- 多义时 `resolve()` 返回 `Resolution(target='', status='ambiguous', candidates=(...))`。`Ptr.as_dict()` 也保留全部候选。KV、XML 属性和引用链都要求用户选择目标；候选窗口初始无选中项，取消不跳转。选择只用于本次导航，不将源指针永久改成确定归属；
- `edges()` 按 `(source, key, target)` 区分引用，同一 MOD 被 `SOLIDMODEL0` / `SOLIDMODEL1` 引用时保留两条边。配套矩阵仍可按键下标在来源文件中核对；文件清单 `chain_files()` 才按路径去重；
- KV 文件的内容区只有「键 / 值」两列：值本身就是链接，**按类型着色 + 下划线**＝可达（单击跳转），红色＝未随包下载（tooltip 给出应取路径）；XML 切到「XML 元素 / 属性 · 值」，其它非 KV 文件切到「行 / 文本」或「偏移 / 十六进制」。
- 链清单/引用链按「所有指针」生成，不再只认 `BASEFAMILY` 这个单数键——`BASEFAMILY1..4`、`IFCFILE`、`IFCn`、`SCHn` 都算；
- 跳到空文件（不少 `.fam` 只有 2 字节、0 个键）时，内容区会明说「（无键值）…跳到这里是跳转成功」，不会看起来像没反应；
- 定位高亮优先沿反向引用回溯；万一索引尚未就绪，BFS 最多扫 1.2 秒 / 6000 个节点，不会为高亮一个文件卡住整个界面。

## 反向引用与体检

**打开目录即自动在后台建立索引**（s01 3.6 万文件约 5 秒，16 线程），右下角同步显示扫描进度；
索引完成后自动刷新，直接列出**指向当前文件的所有来源**（双击跳过去）。
工具栏「重建索引」用于重新扫描；不需要手动点任何按钮才能看反向引用。

- 索引期间右下角显示进度而不是「索引未建立」；若某文件确实没有来源，显示「（没有文件指向它）」；
- 状态栏给出体检：文件数 / 指针数 / 可达 / 跨目录 / 多义 / 悬空；`--smoke` 另打印 9 种类型各自条数与标识键数；
- 索引同时让跳转定位从「从根 BFS」变成「沿反向引用回溯」，毫秒级完成。
- `back_refs()` 只返回唯一解析的引用；多义候选单列于 `possible_back_refs()`，界面标为“多义候选，未确认”，不用于确定的主链或归属回溯。

## 导出引用链清单

「导出链清单…」按当前文件沿引用链递归收集（9 种类型全覆盖），导出 CSV：

```
序号, 深度, 指针类型, 大类, 键, 文件, 大小, 状态
```

`指针类型` 是细分类型名（层级下钻 / 树外索引 / 模型锚点 / …），`大类` 是层级/模型/属性/扩展，
按链下载时可以只挑某一类。

- 清单不截断（s01 全量 36,067 行，覆盖 36,112 个文件中的绝大多数），`文件` 就是解包目录里的相对路径，按它去取即可；
- `状态=待下载` 的行是引用链上还没随包提供的文件——样本只下载到 F2 时，F3/F4/PARTINDEX 及后续 dev/几何都会以红色节点出现在树里，并带 `CBM/xxx.cbm` 这样的准确路径列在清单里，照单继续下载；
- 状态栏会提示导出行数与待下载数量。

## 命令行

```bash
python gim_reader.py <解包目录>            # 打开浏览器
python gim_reader.py --smoke <目录>        # 无 Qt：文件表 / 指针体检 / 主链
python gim_reader.py --guitest <目录>      # 界面自检：跳转/返回/自动索引/文本与 XML 显示，截图 _chain_view.png、_browse.png、_xml_view.png
python gim_reader.py --legacy <目录>       # 旧界面（实体四本账 / 融合树），仅源码运行
```

自动化入口显式将 stdout/stderr 设为 UTF-8，兼容英文 Windows 及冻结解释器忽略 `PYTHONUTF8` 的情况。`--smoke`、`--guitest`、`--self-check` 的异常返回非零状态并记录日志，避免弹出冻结版错误对话框而阻塞 CI。CI 将本轮运行日志写入证据目录的 `info-runtime.log`；普通运行仍使用 `%TEMP%/gim_reader.log`。

`--smoke` 输出示例（s01）：

```
文件: {'CBM': 17581, 'DEV': 8370, 'MOD': 5982, 'PHM': 4179} 合计 36112
指针: 文件 36112 · 指针 49234 · 可达 30554 · 跨目录 18680 · 多义 0 · 悬空 0
按后缀: {... '.sch': 1, '.std': 1, '.sld': 1 ...}
指针类型（9 种 / 4 大类）:
   L1 层级下钻    4805    L2 树外索引    8539    M 模型锚点    4179
   G 几何装配   14011    A 属性族     13313    I IFC 挂接    4384
   U IFC 实体标识    0 · 标识键 4645 条（不跳转）    S 逻辑模型       3
   D 材料与出图    0 · 标识键 184 条（不跳转）
   标识/占位键（不跳转）: 4945 条
主链: project.cbm → F1System → F2System → F3System → F4System → PARTINDEX → fam
引用链清单: 36067 行 · 已下载 36067 · 待下载 0
```

线路样本 line04 用同一套分类统计得到 `L1=779`、`M=343`、`A=547`
（另有 `G=7842` 条几何装配，早期口径把它并入模型链未单列）。

## 模块

| 文件 | 职责 |
|---|---|
| `ptr_kinds.py` | **指针类型唯一真源**：9 种类型表、`classify()`、3 类排除项、自检用例 |
| `指针类型谱系.md` | 分类依据与方言差异、三样本实测对照 |
| `gimbrowse.py` | 文件表、`content()` 内容识别（KV / **XML 元素树** / 文本 / 二进制）、指针解析、类型标注、反向索引、**全指针引用链** `edges()`、链清单 `chain_files` |
| `browse_gui.py` | PySide6 界面：引用链/按目录双视图、KV / XML / 文本 / 二进制四种内容视图、按类型着色与筛选、类型谱系对话框、自动索引、历史导航、导出 |
| `cli.py` | 入口：默认浏览器；`--smoke` / `--guitest` / `--legacy` |
| `diag.py` | 诊断日志（`%TEMP%\gim_reader.log`） |
| `build.ps1` / `requirements-build.txt` / `reader.spec` | 单文件打包发布脚本、直接依赖版本、onefile spec |
| `gim_gui.py` / `btv_*.py` / `dev_inst.py` / `fusion.py` / `ifc_*.py` / `bay_infer.py` / `gim_core.py` | **旧版（实体识别与融合树）**，保留但默认入口不再引用；`--legacy` 可打开旧界面 |

## 打包与发布

**产物只有一个 `dist/GIM信息阅读器.exe`**，不需要同目录的 `_internal/` 或任何 DLL，拷贝单个文件即可分发。
用 `build.ps1`（PowerShell，前台执行 PyInstaller）：

```powershell
# 首次：自动建 .venv 并装 requirements-build.txt，然后打包
.\build.ps1

# 已有依赖的机器：跳过虚拟环境，直接用指定解释器
.\build.ps1 -NoVenv -Python "C:\Python312\python.exe"

# 打包 + 冻结版冒烟 + 生成可分发 zip
.\build.ps1 -SkipInstall -SmokeDir "D:\gim-samples\unpacked" -Publish
```

| 参数 | 作用 |
|---|---|
| `-Python` | 建 venv（或 `-NoVenv` 时直接打包）所用的解释器，默认 `python` |
| `-NoVenv` | 不建 `.venv`，直接用 `-Python` 指定的解释器，需已装 PyInstaller + PySide6 |
| `-SkipInstall` | venv 已存在时跳过 pip install（与 `-NoVenv` 无冲突） |
| `-SmokeDir` | 打包后对指定解包目录跑一次冻结版 `--smoke`，失败即报错 |
| `-Publish` | 额外生成 `dist/GIM信息阅读器.zip`，**压缩包内只有 exe** |

脚本通过 `../build-common.ps1` 暂存旧产物，再按工具根目录的 `reader.spec` 打 onefile，
校验 exe 存在、大小正常、没有 `_internal`，并实际运行 `--self-check`。全部成功后删除旧产物，失败时保留备份。直接依赖版本固定在 `requirements-build.txt`（PyInstaller 6.22.3 / PySide6-Essentials 6.12.0）。

onefile 的运行时机制：首次启动会把内嵌的 Python 与 Qt 插件解压到 `%TEMP%\_MEIxxxxxx`，退出时自动删除，
所以**启动比 onedir 略慢**，且 exe 所在目录无需写权限以外的大量空间；这是正常的临时解压，不是发布依赖。

浏览器只依赖 `gimbrowse.py` + `ptr_kinds.py` + `browse_gui.py`，不再需要 `--paths ../gim_element`；旧的 btv/dev_inst 模块不会被打进包。

## 已知边界

- **非 KV 文件按各自格式显示**：XML 只做元素/属性展开（含 DOCTYPE 的 SVG 也不加载外部 DTD），不做 IFC 实体解析、不建几何；文本最多读 1 MB / 4000 行，XML 最多 8 MB / 4000 行，二进制只看前 256 字节；搜索功能只覆盖 KV 键值，不全文检索 IFC / XML；
- **引用链默认展开一条主链**（工程 → F1 → F2 → F3 → F4 → L5），其余分支按需点开，避免一次建上万节点；
- **孤立 cbm**：没有任何父引用的 cbm 在建索引后单独列在树尾，避免漏文件；
- **同名文件**：没有显式或相对路径证据时保留全部同名候选；多义引用不自动进入文件下载清单，需要先核对路径；
- **未下载文件**：只列文件名与期望路径，不能跳转、不解析内容。
