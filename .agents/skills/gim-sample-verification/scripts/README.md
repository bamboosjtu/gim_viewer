# 样本验证脚本

这些资产用于静态调查，不修改原始样本、不写 SQLite、不创建 Viewer。
脚本会生成 CSV/统计输出；它们的分类、参数和阈值需要与当前源码核对。
方法入口见 [SKILL](../SKILL.md)，格式基线见 [Schema](../../../../docs/schema/README.md)。

## 脚本清单

| 脚本 | 用途 | 参数 |
|---|---|---|
| [gim-container-verify.ps1](gim-container-verify.ps1) | magic、SHA、压缩签名和头部调查 | GimPath |
| [file-inventory-text-binary.ps1](file-inventory-text-binary.ps1) | 清单和文本/二进制粗判 | SampleId,SampleRoot,OutDir |
| [mod-static-profile.ps1](mod-static-profile.ps1) | MOD 分型、Entity/primitive 和键调查 | 同上 |
| [ref-chain-and-integrity.ps1](ref-chain-and-integrity.ps1) | CBM/DEV/PHM 引用及文件完整性 | 同上 |
| [geometry-reachability.ps1](geometry-reachability.ps1) | 可达性、孤立来源和 DEV 图 | 同上 |
| [transform-chain-analysis.ps1](transform-chain-analysis.ps1) | PHM/Entity 矩阵与链抽样 | 同上 |
| [xml-primitive-survey.ps1](xml-primitive-survey.ps1) | XML 类型与数值字段范围 | 同上 |
| [color-analysis.ps1](color-analysis.ps1) | 四通道颜色统计 | 同上 |
| [stretched-body-deep.ps1](stretched-body-deep.ps1) | 截面点和 Normal 调查 | 同上 |
| [line-mod-grammar-deep.ps1](line-mod-grammar-deep.ps1) | 四类线路文本 grammar | 同上 |
| [stl-static-survey.ps1](stl-static-survey.ps1) | STL 格式、引用和上游来源 | 同上 |

变电/线路脚本按实际内容选用，不能仅看有没有 IFC 推定工程类型。
原有 `demo-substation/` CSV 为保存资产，不能在新分析中覆盖；其统计不自动代表全部在册样本。

## 参数与例子

从仓库根运行，路径按当前环境解析：

```powershell
$sampleId = 'substation03'
$sampleRoot = Join-Path (Get-Location) 'demo/substation03'
$surveyOut = Join-Path (Get-Location) 'output/sample-verification/substation03'
powershell -NoProfile -ExecutionPolicy Bypass -File .agents/skills/gim-sample-verification/scripts/ref-chain-and-integrity.ps1 -SampleId $sampleId -SampleRoot $sampleRoot -OutDir $surveyOut
powershell -NoProfile -ExecutionPolicy Bypass -File .agents/skills/gim-sample-verification/scripts/transform-chain-analysis.ps1 -SampleId $sampleId -SampleRoot $sampleRoot -OutDir $surveyOut
powershell -NoProfile -ExecutionPolicy Bypass -File .agents/skills/gim-sample-verification/scripts/gim-container-verify.ps1 -GimPath ./demo/substation03.gim
```

除容器脚本外，省略 OutDir 通常写入脚本目录的 SampleId 子目录。
使用新的显式 OutDir；不要把默认行为称为完全没有写入。
脚本使用 PowerShell；编码、目录枚举和大小写规则以脚本实际实现为准。

## 输出解释

输出包括文件/文本粗判清单、MOD 分型、各类引用、完整性、可达性、
primitive/颜色/截面、四类线路记录及 STL 来源表。
每次输出同时登记源 SHA、样本根、参数、计数排除项和阈值。
全文件数、根可达数、唯一模板数和实例数不能相互替代。

[Python 调研目录](../../../../desktop/scripts/gim_survey/) 提供批量容器、清单、引用、
类型和矩阵调查。部分脚本默认写 `docs/schema/_generated/`，运行前确认样本集合和输出路径。
默认生成位置不是正文证据永久存在的保证，文档不要链接未生成的文件。

脚本原始方法保留，未经核验不改其行为。固定字段布局、矩阵阈值、
同下标关联或分类差异应按 [open-issues](../../../../docs/open-issues.md) 的证据要求处理。
