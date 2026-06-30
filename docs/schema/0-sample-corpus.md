# GIM 样本清单

## 当前样本

| 样本 ID         | 类型 | 大小       |                                                             hash |
| --------------- | ---- | ---------- | ---------------------------------------------------------------: |
| demo-line       | 线路 | 18,905,874 | 54394E14A3547D77276A9AA1022B4ADD6CC14A7A1E7AB7F67D330BBA876669AE |
| demo-substation | 变电 | 14,381,403 | 711259814DB95999F5282AF1871DA9CB50DB4548B71626637B33038B062FC390 |
| demo-line1      | 线路 | 5,652,236  | 97A5699005B6A03D7C4304DA61D10B216C5804D6FC61032432A6BD72547AA829 |

## 工作计划

完整解析 GIM”拆成三层：
- 文件容器
- 工程语义
- 几何/图纸展示

整个分析流程：
- Step1: 登记新样本并检查 GIM 外壳
-

## 结论边界

- 可作为当前解析器和文档整理的样本依据。
- 不直接等同于完整 GIM 标准。
- 与内部规范描述不一致时，以 demo 实证结果单独记录，并标注为“实践偏差 / 待多样本验证”。

## 脚本

### 1. 计算 GIM 文件哈希

```powershell
Get-FileHash .\demo\demo-<xxx>.gim -Algorithm SHA256

Get-Item .\demo\demo-<xxx>.gim | Select-Object Name, Length, LastWriteTime
```
