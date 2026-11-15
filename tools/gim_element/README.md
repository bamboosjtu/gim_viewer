# GIM 实体盘点器

独立读取 GIM 文件或解包目录，输出设备、材料、构件和其他对象的清册，以及整体—部件关系、待归对象和来源证据。源码与目录包均不依赖 GIM Viewer、Node.js 或 `desktop/` 目录。

## 使用

右侧目录按类别和名称模板组织，下方列出真实实例。左侧显示名称、分类和中文部件清单。双击目录中的实体/部件或明细实例，弹出来源文件窗口，每行一个实际文件，可选择复制或复制全部；共享来源去重，IFC occurrence 的对象编号不混入文件名。明细表只显示文件数量，左侧不铺开文件列表。不显示内部 ID、规则版本、识别依据或模板统计。名称模板只汇总展示，不合并实例身份。

```powershell
python element_core.py <工程.gim或解包目录> --json 台账.json --html 报告.html --csv 清册.csv
```

CLI 与 GUI 统一使用工具内的独立 Python 标准算法；已移除旧名称优先引擎及切换参数。JSON 包含完整 `recognition.snapshot`、`entityTree`、属性引用别名和来源引用状态；HTML 可展开整体查看部件及原始父级。

## 目录与展开

唯一目录源为 `docs/engineering/catalogs/变电三维设计建模规范_实体索引表.xlsx`；工具运行和打包只读自己的 JSON 副本，不依赖 Viewer 或工作区中的 xlsx。

目录为“设备/材料/构件 → 工作簿类别 → 工作簿名称 → 名称模板 → 实体实例 → 部件名称 → 来源”。设备部件取设备模型部件名称对照表，材料和构件分别取各自索引表。建筑物下补梁、柱、钢梁、钢柱、钢结构、门、窗、屋面、结构杆件、栏杆；保护装置归设备部件“二次屏柜柜内装置”，新增单元格在工作簿标黄。普通 IFC 梁柱不自动变成钢梁钢柱。

源层级、实体身份、工程用途与目录投影分开。部件和待归集合不重复计设备台数，内部识别码仅供诊断，不显示为旧目录。词汇以维护的 xlsx 为准，不读取 PDF；未识别或歧义继续保留，名称兜底保持候选。

## 独立实现与验证

`standard_sources.py` 持有路径索引、CBM/DEV/FAM 和 IFC 外露对象解析；`standard_recognition.py` 持有分类及整体/部件归一化；`element_core.py` 编排输入与报告。IFC 产品、端口/洞口特征和资源定义分开处理，重复 GUID 不合并。IFC 复合属性解释仍有限，保留原文与未决状态，不代表 Validator 或人工真值。

本目录的 `catalog.json`、`standardCatalog.json`、`sourceVocabulary.json`、`sourceTypeAliases.json`、`catalogRules.json`、`proxyCategories.json` 都是工具自己的资产，构建直接打包这些文件。更新时同步核对版本与证据，不能通过读取主程序文件补齐缺失资源。

`tests/contracts/recognition_cases.json` 提供可移植的纯数据契约案例，由两种独立实现分别运行；通过不等于全部工程正确。算法模块可单独复制到其他目录运行。工程包与 GUI 验证仅开发者本地执行，临时数据和产物放工作区 `tmp/`、`output/`。

```powershell
python -m unittest discover -s tests/unit -p 'test_*.py'
# 来源装配与归档检查，仅开发者本地执行
python -m unittest discover -s tests/local -p 'test_*.py'
```

## 打包

```powershell
.\build.ps1 -SkipInstall
```

使用固定 PySide6 / PyInstaller / py7zr 环境。`element.spec` 将独立模块及六份词典放入目录包 `dist/GIM实体盘点器/`，不包含 Node 或主程序引擎。`verify_package.py` 检查资产及 ICU 依赖，`--self-check` 检查实际导入，`--smoke <输入> <截图>` 用于本地 GUI 检查。统一构建约定见 [tools 总览](../README.md)。

部件和组成来源在面板中以自然语言名称列出，不显示 JSON、证据地址或程序计算过程。诊断字段保留在日志和 JSON 导出，普通属性面板只呈现业务信息。

容器输入仅将 CBM/DEV/FAM/IFC 提取到内存，GIMPKG 使用原文件偏移视图，不复制 7z 载荷，不将 MOD/STL/GL 或数万个语义小文件落盘再打开。解包目录输入仍可直接读取。IFC 使用保留字符串/注释边界的单次词法扫描，只物化产品及属性/关系所需的参数；文档解析、共享属性和单对象属性键查询复用缓存。身份 SHA 仍只用于输入 scope，未增加逐来源内容校验。
