# GIM 样本清单

> **最近复核：2026-08-24 全量扩样。** `demo/` 目录现有 10 个 `.gim` 文件（4 变电 + 6 线路）。
> 原 3 个登记样本中 2 个经哈希比对确认为同一样本（demo-substation=变电站01、demo-line1=线路01）；
> 原 demo-line（某500kV线路）已不在 demo 目录。
>
> **匿名化约定**：对外文档一律使用中性编号——变电 `变电站01..04`、线路 `线路01..06`；
> 磁盘文件名与解压目录使用对应 ASCII ID（`substation01.gim`/`substation01`…、`line01.gim`/`line01`…，
> 其中历史遗留 ID `demo-substation`=变电站01、`demo-line1`=线路01 保持不变以兼容旧文档）。
> 样本的真实工程名、建设单位、设计单位、内部编号等标识信息**不得写入本仓库任何文档**。
> 容器层验证结果见 [01-gim-container-analysis.md](01-gim-container-analysis.md) 与 `_generated/container-survey.csv`。

## 当前样本

### 变电工程（4 个）

| 样本 ID | 原始文件名 | 大小 | SHA-256 | 导出软件 | payload offset |
| --- | --- | ---: | --- | --- | ---: |
| demo-substation | 变电站01.gim | 14,381,403 | 711259814DB95999F5282AF1871DA9CB50DB4548B71626637B33038B062FC390 | JinQu_GRevitTools | 784 |
| substation02 | 变电站02.gim | 34,176,631 | A1C0990162E769F678F2FE5EEB275B1266FB8640776399289197D1998D372F29 | Bentley Substation (2021) | 776 |
| substation03 | 变电站03.gim | 71,831,575 | 3197C03EF2C6C423CBB85447F71491A4112DB0F9A8CEA0C9F72F0B410B8175AB | BIMBase电力套件 | 776 |
| substation04 | 变电站04.gim | 11,789,608 | 00B7746D5EA6AB3B92C215C1E42FFC7EEC5A9F0517C1C555FA27A596D4D800DC | 变电数字化设计平台 (SDDP) | 784 |

### 线路工程（6 个）

| 样本 ID | 原始文件名 | 大小 | SHA-256 | 导出软件 | payload offset |
| --- | --- | ---: | --- | --- | ---: |
| demo-line1 | line01.gim | 5,652,236 | 97A5699005B6A03D7C4304DA61D10B216C5804D6FC61032432A6BD72547AA829 | SLW3D 7.0.2026.0204 | 784 |
| line02 | line02.gim | 10,804,308 | 89BD14B15BC89BFC3FB0D916965A36A294CAC7288647132C1D9AB35D97D05FD4 | SLW3D 7.0.2026.0525 | 784 |
| line03 | line03.gim | 7,308,960 | 67695245738FC5A5577656D182115942BC7D5C9997210458F1A9D20E3163C32F | 输电线路数字化勘测设计系统 | 784 |
| line04 | line04.gim | 1,439,639 | CDEC033A76BADB4086FA3A912350F52C08B65DC7BC0CB7F85BD985AB6A1F64D5 | SLW3D 7.0.2026.0701 | 784 |
| line05 | line05.gim | 8,674,709 | 4074CE6020316B858B61C37C9092E36F3DBB5158C2435352433939BA302FD217 | SLW3D 7.0.2026.0701 | 784 |
| line06 | line06.gim | 2,443,777 | F1618C11B228CD059CB382AC246982E6A92FA3CB108691855E272B68686A97F0 | SLW3D 7.0.2026.0204 | 784 |

### 已退出样本

| 样本 ID | 状态 |
| --- | --- |
| demo-line（某500kV线路，18,905,874 B，54394E14…9AE） | 文件已不在 demo/ 目录；其历史结论降级为"历史样本证据"，跨样本结论以在册样本为准 |

## 样本身份变更记录

| 变更 | 说明 |
| --- | --- |
| demo-substation 改名 | 哈希与原登记一致，确认为同一样本；内部 header 工程名为 `内部编号-变电站01-竣工图-日期.gim` |
| demo-line1 改名 | 哈希一致，同一样本；header 工程名与新文件名一致 |
| 新增 8 个样本 | 2026-08-24 引入，覆盖 4 种变电导出软件和 2 种线路导出软件 |

## 关键研究价值

本轮扩样的核心意义是**导出软件多样化**：

| 软件 | 样本 | 影响 |
| --- | --- | --- |
| JinQu_GRevitTools | demo-substation | 此前唯一变电样本的产出工具 |
| Bentley Substation | substation02 | 全新生产链路；offset=776 的唯一样本之一 |
| BIMBase电力套件 | substation03 | 全新生产链路；国产 BIM 平台 |
| 变电数字化设计平台 SDDP | substation04 | 全新生产链路 |
| SLW3D | 5 个线路样本 | 线路主力工具，版本跨度 0204→0701 |
| 输电线路数字化勘测设计系统 | line03 | 非 SLW3D 线路工具 |

此前所有"变电 = demo-substation 单样本"结论（变换链矩阵分布、primitive 统计、STL 设备类型等）
在本轮都要回答同一个问题：**是 GIM 格式规则，还是JinQu 工具的导出习惯。**

## 结论边界

- 当前结论只代表已登记样本的实证结果。
- 当前结论不直接等同于完整 GIM 标准。
- 与内部规范描述不一致时，以 demo 实证结果单独记录，并标注为"实践偏差 / 待多样本验证"。
- 新增样本后，应优先复跑文件层分析，再决定是否更新工程语义或几何解析结论。

## 脚本

### 批量容器验证（推荐）

```bash
python desktop/scripts/gim_survey/container_verify.py
```

输出 `docs/schema/_generated/container-survey.csv`：SHA-256、大小、魔数、头部元数据字段、payload 格式与偏移。

### 计算单个 GIM 文件哈希

```powershell
Get-FileHash .\demo\<file>.gim -Algorithm SHA256
Get-Item .\demo\<file>.gim | Select-Object Name, Length, LastWriteTime
```
