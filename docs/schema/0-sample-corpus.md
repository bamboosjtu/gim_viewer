# GIM 样本清单

## 当前样本

| 样本 ID         | 类型 |        大小 | GIM 魔数 | 目录大小写      | hash             |
| --------------- | ---- | ------------------- | ---------: | -------- | --------------- | ---------------- |
| demo-line       | 线路 |  18,905,874 | GIMPKGT  | Cbm/Dev/Mod/Phm | 54394E14A3547D77276A9AA1022B4ADD6CC14A7A1E7AB7F67D330BBA876669AE |
| demo-substation | 变电 |  14,381,403 | GIMPKGS  | CBM/DEV/MOD/PHM | 711259814DB95999F5282AF1871DA9CB50DB4548B71626637B33038B062FC390 |
| demo-line1      | 变电 |  5,652,236  | GIMPKGT  | CBM/DEV/MOD/PHM | 97A5699005B6A03D7C4304DA61D10B216C5804D6FC61032432A6BD72547AA829 |

## 观察结论

- 当前包括 2 个线路样本和 1 个变电样本。
- 线路样本使用 PascalCase 目录：Cbm/Dev/Mod/Phm。
- 变电样本使用大写目录：CBM/DEV/MOD/PHM。
- 线路 GIM 魔数为 GIMPKGT。
- 变电 GIM 魔数为 GIMPKGS。
- 以上结论暂为样本事实，后续需用更多工程验证。

## 结论边界

当前文档只记录 `demo-line` 与 `demo-substation` 两个样本的实证结果。

- 可作为当前解析器和文档整理的样本依据。
- 不直接等同于完整 GIM 标准。
- 与内部规范描述不一致时，以 demo 实证结果单独记录，并标注为“实践偏差 / 待多样本验证”。

## 脚本

### 1. 计算 GIM 文件哈希

```powershell
Get-FileHash .\demo\demo-line.gim -Algorithm SHA256
Get-FileHash .\demo\demo-substation.gim -Algorithm SHA256

Get-Item .\demo\demo-line.gim, .\demo\demo-substation.gim |
  Select-Object Name, Length, LastWriteTime
```
