# gim-sample-verification skill 脚本目录

本目录下所有脚本均参数化，可对任意 GIM 样本执行。所有脚本只读、只统计、不修改样本数据。

## 脚本清单

| 脚本 | 对应分析 Round | 用途 |
| ---- | --------------- | ---- |
| `gim-container-verify.ps1` | Round 1.1 | GIM 头部魔数、压缩格式、偏移验证 |
| `file-inventory-text-binary.ps1` | Round 1.2 + 1.3 | 文件清单 + 文本/二进制粗判 |
| `mod-static-profile.ps1` | Round 1.4 | MOD 静态分类（6 类）+ Entity/primitive 统计 |
| `ref-chain-and-integrity.ps1` | Round 2 | CBM/DEV/PHM 引用链提取 + 文件级完整性校验 |
| `geometry-reachability.ps1` | Round 3 | 几何可达性分类 + 孤儿溯源 + DEV 图分析 |
| `transform-chain-analysis.ps1` | Round 5 | PHM/MOD 矩阵分类 + 两级变换抽样 |
| `xml-primitive-survey.ps1` | Round 6.1 + 6.2 | 变电 XML primitive 类型分布 + 数值字段范围 |
| `color-analysis.ps1` | Round 6.3 | Color 节点 R/G/B/A 4 通道分布分析 |
| `stretched-body-deep.ps1` | Round 6.4 | StretchedBody.Array 点序列 + Normal 向量深度分析 |
| `line-mod-grammar-deep.ps1` | Round 7 | 线路 MOD 4 类文本格式族深度分析（grammar 与 parser 边界） |
| `stl-static-survey.ps1` | Round 8 | STL 格式检测 + PHM 引用扫描 + CBM entityName 上游溯源 |
| `stl-device-type-survey.ps1` | Round 8.5 | STL 设备类型调研（三样本）：CBM→DEV→PHM→STL 完整链反查 STL 对应的具体设备类型（变电二次柜 / 线路金具） |
| `mod-device-type-survey.ps1` | Round 8.6 | MOD 设备类型对比调研（三样本）：CBM→DEV→PHM→MOD 完整链反查 MOD 对应的设备类型（变电 XML primitive 一次设备 / 线路 4 类文本格式族） |

> Round 9 是 IR schema **设计**而非样本分析，无对应分析脚本。完成后输出 `docs/schema/13-geometry-ir-schema.md`，把 Round 1-8 的静态分析结论沉淀为统一 schema 草案。详见 [SKILL.md](../SKILL.md) §4 Round 9。

## 通用约定

- 所有脚本使用 `param` 接受 `-SampleId` 与 `-SampleRoot` 参数
- 默认输出目录为脚本目录下的 `<SampleId>/` 子目录
- 输出 CSV 使用 UTF-8 编码（`-Encoding UTF8`）
- 所有文件查找大小写不敏感（`Get-ChildItem -ieq`）
- 读取文本文件统一通过 `Read-TextFileLoose` 函数，自动处理 UTF-8 BOM
- 脚本可独立运行，无需依赖其他脚本

## 执行示例

```powershell
# 单样本验证（推荐通过 SKILL.md 主入口执行）
$sampleId = "demo-substation"
$sampleRoot = "D:\vibe-coding\gim_viewer\demo\$sampleId"

# Round 1.1
powershell -NoProfile -ExecutionPolicy Bypass -File `
  ".trae/skills/gim-sample-verification/scripts/gim-container-verify.ps1" `
  -GimPath "$sampleRoot.gim"

# Round 1.2 + 1.3
powershell -NoProfile -ExecutionPolicy Bypass -File `
  ".trae/skills/gim-sample-verification/scripts/file-inventory-text-binary.ps1" `
  -SampleId $sampleId -SampleRoot $sampleRoot

# Round 1.4
powershell -NoProfile -ExecutionPolicy Bypass -File `
  ".trae/skills/gim-sample-verification/scripts/mod-static-profile.ps1" `
  -SampleId $sampleId -SampleRoot $sampleRoot

# Round 2
powershell -NoProfile -ExecutionPolicy Bypass -File `
  ".trae/skills/gim-sample-verification/scripts/ref-chain-and-integrity.ps1" `
  -SampleId $sampleId -SampleRoot $sampleRoot

# Round 3
powershell -NoProfile -ExecutionPolicy Bypass -File `
  ".trae/skills/gim-sample-verification/scripts/geometry-reachability.ps1" `
  -SampleId $sampleId -SampleRoot $sampleRoot

# Round 5
powershell -NoProfile -ExecutionPolicy Bypass -File `
  ".trae/skills/gim-sample-verification/scripts/transform-chain-analysis.ps1" `
  -SampleId $sampleId -SampleRoot $sampleRoot

# Round 6（仅变电样本，三个子脚本）
powershell -NoProfile -ExecutionPolicy Bypass -File `
  ".trae/skills/gim-sample-verification/scripts/xml-primitive-survey.ps1" `
  -SampleId $sampleId -SampleRoot $sampleRoot

powershell -NoProfile -ExecutionPolicy Bypass -File `
  ".trae/skills/gim-sample-verification/scripts/color-analysis.ps1" `
  -SampleId $sampleId -SampleRoot $sampleRoot

powershell -NoProfile -ExecutionPolicy Bypass -File `
  ".trae/skills/gim-sample-verification/scripts/stretched-body-deep.ps1" `
  -SampleId $sampleId -SampleRoot $sampleRoot

# Round 7（仅线路样本）
powershell -NoProfile -ExecutionPolicy Bypass -File `
  ".trae/skills/gim-sample-verification/scripts/line-mod-grammar-deep.ps1" `
  -SampleId $sampleId -SampleRoot $sampleRoot

# Round 8（线路+变电均可用）
powershell -NoProfile -ExecutionPolicy Bypass -File `
  ".trae/skills/gim-sample-verification/scripts/stl-static-survey.ps1" `
  -SampleId $sampleId -SampleRoot $sampleRoot

# Round 8.5（三样本：STL 设备类型调研）
powershell -NoProfile -ExecutionPolicy Bypass -File `
  ".trae/skills/gim-sample-verification/scripts/stl-device-type-survey.ps1" `
  -SampleId $sampleId -SampleRoot $sampleRoot

# Round 8.6（三样本：MOD 设备类型对比调研）
powershell -NoProfile -ExecutionPolicy Bypass -File `
  ".trae/skills/gim-sample-verification/scripts/mod-device-type-survey.ps1" `
  -SampleId $sampleId -SampleRoot $sampleRoot
```

## 输出产物

每个脚本运行后会在 `<SampleId>/` 目录下生成 CSV 与文本统计：

```text
scripts/
  <SampleId>/
    <SampleId>-file-inventory.csv
    <SampleId>-text-binary-survey.csv
    <SampleId>-mod-kind.csv
    <SampleId>-cbm-refs.csv
    <SampleId>-dev-refs.csv
    <SampleId>-phm-refs.csv
    <SampleId>-ref-integrity.csv
    <SampleId>-geometry-reachability.csv
    <SampleId>-orphan-trace.csv
    <SampleId>-primitive-attrs.csv          （仅变电，Round 6.1+6.2）
    <SampleId>-primitive-summary.csv         （仅变电，Round 6.1+6.2）
    <SampleId>-color-attrs.csv               （仅变电，Round 6.3）
    <SampleId>-stretched-body-summary.csv     （仅变电，Round 6.4）
    <SampleId>-text-hnum-summary.csv            （仅线路，Round 7.1）
    <SampleId>-text-point-line-summary.csv     （仅线路，Round 7.2）
    <SampleId>-text-section-kv-summary.csv      （仅线路，Round 7.3）
    <SampleId>-text-key-value-summary.csv       （仅线路，Round 7.4）
    <SampleId>-stl-summary.csv                  （Round 8.1，STL 格式+三角面）
    <SampleId>-stl-phm-refs.csv                 （Round 8.2，PHM STL/MOD 引用模式）
    <SampleId>-stl-upstream.csv                 （Round 8.3，entityName × STL 映射）
    stl-device-type-survey-<sampleId>.json       （Round 8.5，STL 设备类型聚合 JSON）
    mod-device-type-survey-<sampleId>.json      （Round 8.6，MOD 设备类型聚合 JSON）
```

## 注意事项

- 脚本运行需要 PowerShell 5.1+（Windows 自带）
- 变电样本（含 IFCFILE 的 CBM）会触发 Round 6 primitive 分析
- 线路样本会触发 Round 7 文本格式族深度分析
- 线路+变电样本均可触发 Round 8 STL 分析（线路 181-82 STL / 变电 1803 STL）
- Round 8.5/8.6 设备类型调研支持三样本分发：变电走 F4System/PARTINDEX + SYSCLASSIFYNAME/PARTNAME，线路走 Tower_Device/Wire_Device/CROSS/WIRE/F4System + NAME/CLASSIFYNAME/DEVICETYPE/TOWERTYPE
- 线路样本在 Round 5 会自动跳过 MOD XML Entity 分析，转而检测是否含 TransformMatrix 字段
- 大型样本（如 demo-line 27829 个 CBM）单次执行可能耗时 1-3 分钟
- 所有脚本不修改源文件、不写 SQLite、不创建 Viewer
- Round 9 是 IR schema 设计而非样本分析，无脚本产出。完成后输出 `docs/schema/13-geometry-ir-schema.md`
