# GIM 实体盘点器

盘点器独立读取 GIM 文件或解包目录，生成设备、材料、构件和其他对象的清册。CLI 和 GUI 使用同一套 Python 识别实现与随包 JSON 配置，工作簿用于人工对照。

## 使用

右侧按目录类别和名称模板列实体，二次屏柜下各类柜子模板平级排列。选择分类或模板可查看实例列表，点击具体实例后左侧显示名称、分类和部件。名称模板只汇总展示，每个实例保留自己的身份。双击实例可查看或复制来源文件路径。

待归集合在状态栏提示，详细结果保留在 JSON 和 HTML 导出中。JSON 提供完整的识别快照、组成和来源引用，HTML 可展开整体查看部件及原始父级，CSV 用于汇总清册。

```powershell
python element_core.py "<工程.gim 或解包目录>" --json 台账.json --html 报告.html --csv 清册.csv
```

## 实现与验证

`standard_sources.py` 按真实引用读取 CBM、DEV、FAM 及 IFC 外露对象，`standard_recognition.py` 解释目录与整体归属，`element_core.py` 编排输入和报告。归档输入仅物化识别所需的语义文本。具体分类、别名和归属条件见[目录识别规则](../../docs/engineering/catalogs/reference-gaps.md)。

`tests/contracts/recognition_cases.json` 由盘点器和 SDK 分别执行。单元测试覆盖识别规则，本地测试另检查来源装配、归档和 GUI。

```powershell
python -m unittest discover -s tests/unit -p 'test_*.py'
python -m unittest discover -s tests/local -p 'test_*.py'
```

## 打包

```powershell
.\build.ps1 -SkipInstall
```

构建使用本目录的 PySide6、PyInstaller 和 py7zr 环境，产物位于 `dist/GIM实体盘点器/`。目录包包含独立实现和 `element.spec` 列出的七份 JSON 资产。构建流程检查归档内容、ICU 依赖和启动导入。可用 `--smoke <输入> <截图>` 在本地检查打包应用打开工程的行为，并将截图路径放在工作区 `tmp/` 或 `output/`。Smoke 设置随截图保存在相邻的 `.settings.ini`。构建与环境约定见 [tools 总览](../README.md)。
