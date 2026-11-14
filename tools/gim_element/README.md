# GIM 实体盘点器

独立读取 GIM 文件或解包目录，输出设备、装置性材料、构件和其他对象的清册，以及整体—部件关系、待归对象和来源证据。源码与单文件 EXE 均不依赖 GIM Viewer、Node.js 或 `desktop/` 目录。

## 使用

界面左侧按类别和名称模板组织，右侧列出真实实例。选中实例可以查看 entityId、规则版本、部件类型、归属依据和原始父级。名称模板只汇总展示，不合并实例身份。

```powershell
python element_core.py <工程.gim或解包目录> --json 台账.json --html 报告.html --csv 清册.csv
```

默认 `--engine standard` 使用工具内的 Python 标准算法；`--engine legacy` 保留旧名称优先盘点口径，仅供历史对照。GUI 默认使用标准算法。JSON 包含完整 `recognition.snapshot`、`entityTree`、属性引用别名和来源引用状态；HTML 可展开整体查看部件及原始父级。

## 标准与分类

依据《变电三维设计建模规范_索引表类.xlsx》及 Q/GDW 11810.1—2023 原文核对的索引：表1设备 52 项、表8材料 39 项、表10建构筑物及其他设施 30 项。表8第40行为续表表头，末尾拆开的英文列按原文合并。每条词汇保留单元格、页码、工作簿 SHA 和版本。表2部件词汇、常用 IFC 产品类型及属性分类用于补充识别。

目录编码 `E*` / `M*` / `C-*` 是项目映射，不是 NB/T 编码。设备类型、工程用途、整体边界与成员归属分别解释；名称兜底是候选，未知编码不按前缀猜测。支柱绝缘子与穿墙套管属于设备；独立端子箱、灯具、箱类和安装钢材按索引归材料，实际内嵌部件另保留成员角色。

优先使用明确 TYPE、属性及宿主标识，再结合真实 DEV 装配。原始层级不决定整体粒度。标准部件可凭明确宿主编码、工程中名称或带编号的名称找到唯一宿主；无整体来源时，只有明确的宿主声明可以建立候选整体。多候选、用途冲突及无法证明的归属继续待归，不按同名、同模板或空间邻近归并。

PARTINDEX 在实际装配范围匹配属性目标，唯一、歧义和未匹配分别保留。未匹配可保留逻辑属性来源，不创建物理根。属性赋值与物理表示匹配分别解释。独立端子箱与本体端子箱、中性点待归集合与已归主变附件分别统计；待归附件不计作已并入本体。

## 独立实现与验证

`standard_sources.py` 持有路径索引、CBM/DEV/FAM 和 IFC 外露对象解析；`standard_recognition.py` 持有分类及整体/部件归一化；`element_core.py` 编排输入与报告。IFC 产品、端口/洞口特征和资源定义分开处理，重复 GUID 不合并。IFC 复合属性解释仍有限，保留原文与未决状态，不代表 Validator 或人工真值。

本目录的 `catalog.json`、`standardCatalog.json`、`sourceVocabulary.json`、`sourceTypeAliases.json`、`catalogRules.json`、`proxyCategories.json` 都是工具自己的资产，构建直接打包这些文件。更新时同步核对版本与证据，不能通过读取主程序文件补齐缺失资源。

`tests/recognition_cases.json` 提供可移植的纯数据契约案例，由两种独立实现分别运行；通过不等于全部工程正确。算法模块可单独复制到其他目录运行。工程包与 GUI 验证仅开发者本地执行，临时数据和产物放工作区 `tmp/`、`output/`。

```powershell
python -m unittest discover -s tests
```

## 打包

```powershell
.\build.ps1 -SkipInstall
```

使用固定 PySide6 / PyInstaller / py7zr 环境。`element.spec` 将独立模块及六份词典打进单文件 `GIM实体盘点器.exe`，不包含 Node 或主程序引擎。`verify_package.py` 检查资产及 ICU 依赖，`--self-check` 检查实际导入，`--smoke <输入> <截图>` 用于本地 GUI 检查。统一构建约定见 [tools 总览](../README.md)。
