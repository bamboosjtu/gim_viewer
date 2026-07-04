# GIM 样本清单

## 当前样本

| 样本 ID | 类型 | 大小 | hash |
| --- | --- | ---: | --- |
| demo-line | 线路 | 18,905,874 | 54394E14A3547D77276A9AA1022B4ADD6CC14A7A1E7AB7F67D330BBA876669AE |
| demo-line1 | 线路 | 5,652,236 | 97A5699005B6A03D7C4304DA61D10B216C5804D6FC61032432A6BD72547AA829 |
| demo-substation | 变电 | 14,381,403 | 711259814DB95999F5282AF1871DA9CB50DB4548B71626637B33038B062FC390 |

## 当前研究对象

当前样本包括：

```text
demo-line       脱敏后的线路工程样本
demo-line1      脱敏后的线路工程样本
demo-substation 脱敏后的变电工程样本
```

当前阶段的目标不是直接完成 GIM 标准定义，而是基于多个实际样本建立可复查、可复跑、可扩展的 schema analysis 流程。

## 工作计划

完整解析 GIM 可以拆成三层：

```text
文件容器层
  -> 工程语义层
     -> 几何 / 图纸展示层
```

当前研究按以下顺序推进：

| 阶段 | 目标 | 对应文档 |
| --- | --- | --- |
| Step 00 | 登记样本、记录样本边界 | `00-sample-corpus.md` |
| Step 01 | 检查 GIM 外壳、魔数、压缩格式、payload offset | `01-gim-container-analysis.md` |
| Step 02 | 统计解压目录、文件类型、文本/二进制粗判 | `02-gim-file-inventory.md` |
| Step 03 | 建立文件角色矩阵，区分 CBM/FAM/DEV/PHM/MOD/STL/IFC/SCH/STD/SLD | `03-gim-file-role-matrix.md` |
| Step 04 | 分析 CBM 字段与线路/变电差异 | `04-cbm-field-dictionary.md` |
| Step 05 | 校验 CBM/DEV/PHM 文件级引用完整性 | `05-gim-reference-integrity.md` |
| Step 06 | 分析 CBM -> FAM 属性覆盖关系 | `06-cbm-fam-consistency.md` |
| Step 07 | 分析 DEV/PHM/MOD/STL 几何目标可达性 | `07-dev-phm-geometry-reachability.md` |
| Step 08 | 分析 MOD 静态格式族和 parser 边界 | `08-mod-static-survey.md` |
| Step 09 | 分析 PHM 与 MOD 变换链 | `09-transform-chain-analysis.md` |
| Step 10 | 分析变电 XML primitive 字段值范围 | `10-substation-xml-primitive.md` |

详细目录入口见 `README.md`。

## 结论边界

- 当前结论只代表已登记样本的实证结果。
- 当前结论不直接等同于完整 GIM 标准。
- 与内部规范描述不一致时，以 demo 实证结果单独记录，并标注为“实践偏差 / 待多样本验证”。
- 新增样本后，应优先复跑文件层分析，再决定是否更新工程语义或几何解析结论。

## 脚本

### 计算 GIM 文件哈希

```powershell
$sampleId = "demo-<xxx>"
$gimPath = ".\demo\$sampleId.gim"

Get-FileHash $gimPath -Algorithm SHA256
Get-Item $gimPath | Select-Object Name, Length, LastWriteTime
```
