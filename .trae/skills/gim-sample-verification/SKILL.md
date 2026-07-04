---
name: "gim-sample-verification"
description: "对新 GIM 工程样本（.gim 文件）执行结构化验证：容器结构、文件清单、引用链、完整性、几何可达性、MOD 静态分类。Invoke when 用户引入新 GIM 样本、要求对照已有 demo 进行结构化诊断、或在 parser 升级后做回归验证。"
---

# GIM 样本结构验证

把新引入的 `.gim` 样本对照已沉淀的 schema 文档做结构化体检，输出符合 `docs/schema/` 既有风格的分析报告。所有检查只读、只统计、不解析几何、不写库。

## 1. 适用场景

- 用户在 `demo/` 目录放入新的 `.gim` 文件并要求"分析/验证/对照"
- parser_version 变更后需要回归验证既有样本
- 用户要求生成 `9-<sampleId>-survey.md` 之类的新样本分析报告
- 用户怀疑某样本结构与既有 schema 不一致

不适用：渲染、解压实现、几何语义解释、SQLite 入库 —— 这些不在本 skill 范围。

## 2. 工作目录与基线

工作目录：`d:\vibe-coding\gim_viewer`

### 2.1 参考文档（ground truth，验证时对照）

| 维度 | 基线文档 |
| ---- | -------- |
| 样本登记 | `docs/schema/0-sample-corpus.md` |
| 容器结构 | `docs/schema/1-gim-container-analysis.md` |
| 文件清单 | `docs/schema/2-gim-file-inventory.md` |
| 文件角色 | `docs/schema/3-gim-file-role-matrix.md` |
| CBM 字段 | `docs/schema/4-cbm-field-dictionary.md` + `docs/schema/cbm.md` |
| 引用完整性 | `docs/schema/5-gim-reference-integrity.md` |
| CBM/FAM 一致性 | `docs/schema/6-cbm-fam-consistency.md` + `docs/schema/fam.md` |
| 几何可达性 | `docs/schema/7-dev-phm-geometry-reachability.md` + `docs/schema/dev.md` + `docs/schema/phm.md` |
| MOD 静态分型 | `docs/schema/8-mod-static-survey.md` + `docs/schema/mod.md` |
| 其他格式 | `docs/schema/sld.md` / `std.md` / `sch.md` |

### 2.2 方法论文档（仅作为流程参考，不作为基线）

- `docs/schema/_generated/*.ps1` —— 已沉淀的分析脚本，可作为对照参考

### 2.3 skill 自带脚本（稳定可复用资产）

本 skill 自带完整分析脚本，位于 `scripts/` 目录，参数化设计，可对任意 GIM 样本独立执行。**这些脚本是 skill 的核心资产，独立于 `docs/schema/_generated/`，避免文档重构影响 skill 稳定性。**

| 脚本 | 对应分析 Round | 用途 |
| ---- | --------------- | ---- |
| [scripts/gim-container-verify.ps1](scripts/gim-container-verify.ps1) | Round 1.1 | GIM 头部魔数、压缩格式、偏移验证 |
| [scripts/file-inventory-text-binary.ps1](scripts/file-inventory-text-binary.ps1) | Round 1.2 + 1.3 | 文件清单 + 文本/二进制粗判 |
| [scripts/mod-static-profile.ps1](scripts/mod-static-profile.ps1) | Round 1.4 | MOD 静态分类（6 类）+ Entity/primitive 统计 |
| [scripts/ref-chain-and-integrity.ps1](scripts/ref-chain-and-integrity.ps1) | Round 2 | CBM/DEV/PHM 引用链提取 + 文件级完整性校验 |
| [scripts/geometry-reachability.ps1](scripts/geometry-reachability.ps1) | Round 3 | 几何可达性分类 + 孤儿溯源 + DEV 图分析 |
| [scripts/transform-chain-analysis.ps1](scripts/transform-chain-analysis.ps1) | Round 5 | PHM/MOD 矩阵分类 + 两级变换抽样 |
| [scripts/xml-primitive-survey.ps1](scripts/xml-primitive-survey.ps1) | Round 6.1 + 6.2 | 变电 XML primitive 类型分布 + 数值字段范围 |
| [scripts/color-analysis.ps1](scripts/color-analysis.ps1) | Round 6.3 | Color 节点 R/G/B/A 4 通道分布分析 |
| [scripts/stretched-body-deep.ps1](scripts/stretched-body-deep.ps1) | Round 6.4 | StretchedBody.Array 点序列 + Normal 向量深度分析 |

执行约定：
- 所有脚本接受 `-SampleId` 与 `-SampleRoot` 参数
- 默认输出目录为 `scripts/<SampleId>/`
- 脚本可独立运行，无需依赖其他脚本
- 大型样本（27829 个 CBM）单次执行约 1-3 分钟
- 详见 [scripts/README.md](scripts/README.md)

### 2.4 已登记样本对照集

- `demo-line` —— 线路工程样本 A
- `demo-line1` —— 线路工程样本 B
- `demo-substation` —— 变电工程样本

新样本必须与同类型样本对照（线路 vs 线路，变电 vs 变电），不能跨类型直接对比。

## 3. 样本登记（Step 0）

### 3.1 输入

- `.gim` 文件路径（用户指定）
- 期望的 sampleId（用户指定或从文件名推断）

### 3.2 操作

1. 计算文件 SHA256、大小、修改时间
2. 解压到 `demo/<sampleId>/`（若已解压则跳过）
3. 在 `docs/schema/0-sample-corpus.md` 追加一行登记
4. 创建输出目录 `docs/schema/_generated/<sampleId>/`

### 3.3 验证

- SHA256 不与已有样本重复
- 解压后根目录应包含 CBM/DEV/PHM/MOD 四个目录（大小写不敏感）

## 4. 验证流程

按 Round 1 → Round 2 → Round 3 → Round 4 顺序执行。每轮输出 CSV 到 `_generated/<sampleId>/`，最终汇总到一份 Markdown 报告。

### Round 1：容器结构与文件画像

#### R1.1 容器结构验证

**目标**：确认 `.gim` 是 GIMPKG* 头部 + 7z/ZIP 压缩数据。

**步骤**：
1. 读取前 128 字节十六进制
2. 解析头部魔数（前 6 字节 ASCII）：`GIMPKGT`（线路）/ `GIMPKGS`（变电）
3. 解析头部文件名（UTF-8，零填充）
4. 在 1MB 窗口内搜索 7z 签名 `37 7A BC AF 27 1C` 或 ZIP 签名 `50 4B 03 04`
5. 记录压缩格式与偏移

**判定**：
- 魔数必须是 `GIMPKGT` 或 `GIMPKGS` 之一，否则样本异常
- 必须能在 1MB 窗口内定位到 7z 或 ZIP 签名
- **不能**得出"所有 GIM 偏移都是 784"的结论，偏移随工程名长度变化

**脚本参考**：`gim-analysis-summary.md` Section 5.2 的 `Read-HeaderHex` + `Find-SignatureOffset`。

#### R1.2 文件清单统计

**目标**：统计解压后文件类型、数量、目录分布。

**步骤**：
1. 递归列出所有文件，导出 `_generated/<sampleId>/<sampleId>-file-inventory.csv`
2. 按扩展名统计（.cbm / .fam / .dev / .phm / .mod / .stl / .ifc / .sch / .std / .sld）
3. 按顶层目录 + 扩展名交叉统计
4. 与同类型已登记样本对照规模量级

**判定**：
- 线路样本：CBM 数量应显著高于 DEV/PHM/MOD
- 变电样本：DEV/PHM/MOD 数量应一致或接近
- 目录大小写：线路为 `Cbm/Dev/Phm/Mod`，变电为 `CBM/DEV/PHM/MOD`，路径处理必须大小写不敏感
- IFC 仅在变电样本的 DEV 目录出现（线路样本无 IFC）

**脚本参考**：`gim-analysis-summary.md` Section 6.2。

#### R1.3 文本/二进制粗判

**目标**：判断各类文件是否可按文本继续字段扫描。

**步骤**：
1. 对每个文件取前 4096 字节
2. 出现零字节 → `binary-like`
3. UTF-8 解码成功且匹配 `<?xml|<\w+|=|;|,` → `text-like`
4. UTF-8 解码成功但不匹配 → `unknown-text`
5. 空文件 → `empty`
6. 导出 `_generated/<sampleId>/<sampleId>-text-binary-survey.csv`

**判定**：
- CBM/FAM/DEV/PHM 应全部 text-like（少量 FAM 可能 unknown-text，不等于二进制）
- MOD 大部分 text-like，少量 unknown-text
- STL 应为 binary-like
- IFC/SCH/STD/SLD 应为 text-like

**脚本参考**：`gim-analysis-summary.md` Section 7.2 的 `Test-TextLikeFile`。

---

### Round 2：引用链与完整性

#### R2.1 CBM 引用链提取

**目标**：从 CBM 提取所有对外引用。

**步骤**：
1. 扫描所有 `.cbm` 文件，按 `KEY=VALUE` 解析
2. 收集以下引用键：
   - `OBJECTMODELPOINTER` → DEV
   - `BASEFAMILY` → FAM
   - `SUBDEVICEn` / `SUBSYSTEMSn` / `SECTIONSn` / `STRAINSECTIONSn` / `GROUPSn` → CBM
   - `IFCFILE` + `IFCGUID` → IFC
3. 注意：部分 CBM 中 `OBJECTMODELPOINTER` 出现在 `ENTITYNAME` 之前，需两遍扫描
4. 导出 `_generated/<sampleId>/<sampleId>-cbm-refs.csv`

**脚本参考**：`gim-analysis-summary.md` Section 9-12 的 CBM 引用扫描。

#### R2.2 DEV 引用链提取

**目标**：从 DEV 提取 SOLIDMODEL/SUBDEVICE 引用。

**步骤**：
1. 扫描所有 `.dev` 文件
2. 收集：
   - `SOLIDMODELn` → PHM 或 DEV（值带扩展名决定类型）
   - `SUBDEVICEn` → DEV
3. 区分线路工程（无 SUBDEVICE，纯 SOLIDMODEL）与变电工程（SUBDEVICE 递归）
4. 导出 `_generated/<sampleId>/<sampleId>-dev-refs.csv`

**脚本参考**：`gim-analysis-summary.md` Section 13-15。

#### R2.3 PHM 引用链提取

**目标**：从 PHM 提取 SOLIDMODEL → MOD/STL 引用。

**步骤**：
1. 扫描所有 `.phm` 文件
2. 收集 `SOLIDMODELn` → MOD 或 STL
3. PHM 可引用同级 PHM（需正确识别，不要漏）
4. 导出 `_generated/<sampleId>/<sampleId>-phm-refs.csv`

**脚本参考**：`gim-analysis-summary.md` Section 16。

#### R2.4 文件级引用完整性校验

**目标**：检查所有引用目标是否真实存在。

**步骤**：
1. 对每条引用，检查目标文件是否存在于解压目录
2. 路径匹配必须大小写不敏感
3. 分类统计：
   - 命中：目标存在
   - 软缺失：目标不存在但同 basename 在别处
   - 硬缺失：目标完全不存在
4. 按 (引用方扩展名, 被引方扩展名) 分组统计
5. 导出 `_generated/<sampleId>/<sampleId>-ref-integrity.csv`

**判定**：
- 健康样本硬缺失率应趋近于 0
- 软缺失需要人工确认是否为大小写或路径差异

**脚本参考**：`gim-analysis-summary.md` Section 17-18。

#### R2.5 IFCGUID 文本命中验证（仅变电样本）

**目标**：验证 CBM 中声明的 IFCGUID 是否在对应 IFC 文件文本中真实出现。

**步骤**：
1. 收集所有 CBM 的 `IFCFILE` + `IFCGUID` 对
2. 对每对，在 IFCFILE 指定的 IFC 文件全文中搜索 IFCGUID
3. 分类：
   - 强命中：精确大小写匹配
   - 弱命中：大小写不敏感匹配
   - 硬缺失：完全未出现
4. 对硬缺失，记录上下文（哪个 CBM、哪个 IFCFILE、IFCGUID 值）

**脚本参考**：`gim-analysis-summary.md` Section 19-20。

**注意**：线路样本无 IFC，跳过此步。

#### R2.6 FAM 字段分析

**目标**：分析 FAM 文件的字段形态与一致性。

**步骤**：
1. 扫描所有 `.fam` 文件
2. 按行类型分类：
   - section header（独立行，非 `KEY=VALUE`）
   - `KEY=VALUE` 行
   - 空行
3. 统计 section 类型分布、key 分布
4. 对照 `docs/schema/6-cbm-fam-consistency.md` 与 `docs/schema/fam.md`
5. 区分变电 vs 线路 FAM 格式差异（参考 fam.md 的工程类型对比表）

**脚本参考**：`gim-analysis-summary.md` Section 22-28。

---

### Round 3：几何可达性

#### R3.1 DEV 引用模式分析

**目标**：统计 DEV 引用 PHM 与 DEV 的模式。

**步骤**：
1. 基于 R2.2 的 dev-refs.csv
2. 按 DEV 文件分组：
   - 仅引用 PHM 的 DEV
   - 仅引用 DEV 的 DEV
   - 同时引用 PHM 和 DEV 的 DEV
   - 无引用的 DEV
3. 统计每个 DEV 的引用数分布

**脚本参考**：`gim-analysis-summary.md` Section 29-31。

#### R3.2 DEV 根/子角色判定

**目标**：识别根 DEV 与子 DEV。

**步骤**：
1. 被 `SUBDEVICEn` 引用的 DEV 标记为子 DEV
2. 未被任何 DEV 引用的 DEV 标记为根 DEV
3. 统计根 DEV 数、子 DEV 数、最大深度
4. 检测环（DFS + visited）

**判定**：
- 当前已知样本最大深度 = 1（无递归嵌套）
- 当前已知样本无环
- 若新样本出现深度 > 1 或环，需在报告中标记为异常

**脚本参考**：`gim-analysis-summary.md` Section 32-35。

#### R3.3 CBM→DEV 入口对齐

**目标**：确认每个根 DEV 都被某个 CBM 的 OBJECTMODELPOINTER 引用。

**步骤**：
1. 收集所有 CBM 的 OBJECTMODELPOINTER 目标
2. 收集所有根 DEV
3. 集合差：
   - CBM 引用但 DEV 不存在 → 硬缺失
   - DEV 存在但未被任何 CBM 引用 → 孤儿 DEV
4. 统计两类数量

**脚本参考**：`gim-analysis-summary.md` Section 36。

#### R3.4 PHM→MOD/STL 引用模式

**目标**：分析 PHM 的 SOLIDMODEL 引用模式。

**步骤**：
1. 基于 R2.3 的 phm-refs.csv
2. 按 PHM 文件分组：
   - 引用 MOD 的 PHM
   - 引用 STL 的 PHM
   - 同时引用 MOD 和 STL 的 PHM
   - 无引用的 PHM（no-target PHM）
3. 统计每个 PHM 的引用数分布

**脚本参考**：`gim-analysis-summary.md` Section 37-39。

#### R3.5 几何可达性分类

**目标**：从 CBM 视角分类每个 DEV/PHM/MOD 的可达性。

**步骤**：
1. 从 CBM 出发，沿 `OBJECTMODELPOINTER → DEV → SOLIDMODEL → PHM → SOLIDMODEL → MOD/STL` 遍历
2. 标记每个资源的可达状态：
   - CBM 可达（被某个 CBM 链路触达）
   - CBM 不可达（孤儿）
3. 统计每类资源的可达比例

**判定**：
- 变电样本：MOD 可达率应接近 99%（demo-substation 仅 44 个 EMPTY_DEVICE_XML 孤儿）
- 线路样本：可达率取决于样本，demo-line1 存在 148 个 CBM 不可达的 TEXT_POINT_LINE 孤儿 MOD
- 若新样本可达率显著低于同类基线，需在报告中详细说明

**脚本参考**：`gim-analysis-summary.md` Section 40-43。已沉淀脚本：`docs/schema/_generated/mod-upstream-diagnostic.ps1`。

#### R3.6 孤儿资源分析

**目标**：对 CBM 不可达的资源做溯源。

**步骤**：
1. 收集所有 CBM 不可达的 DEV/PHM/MOD
2. 对每个孤儿，反向追溯：
   - 孤儿 MOD 是否被某个 PHM 引用？
   - 该 PHM 是否被某个 DEV 引用？
   - 该 DEV 是否被某个 CBM 引用？
3. 识别"全链孤儿"（DEV→PHM→MOD 都未被引用）
4. 识别"半链孤儿"（部分被引用）

**脚本参考**：`docs/schema/_generated/mod-upstream-diagnostic.ps1`。

---

### Round 4：MOD 静态分类

#### R4.1 MOD 静态分类（6 类）

**目标**：对所有 MOD 文件做静态分型。

**分类规则**：

```text
EMPTY                       文件内容为空
EMPTY_DEVICE_XML            <Device><Entities /></Device>
XML_WITH_ENTITIES           <Device> 下存在 <Entity>
TEXT_POINT_LINE             存在 CODE / POINTNUM / LINENUM
TEXT_SECTION_KV_RECORD      首行非 KV，后续是 KV 行
TEXT_KEY_VALUE              主要由 KV 行构成
TEXT_HNUM_COMMA_RECORD      首行 HNum,n，后续逗号分隔
```

**步骤**：
1. 扫描所有 `.mod` 文件，应用分类函数
2. 统计每类数量
3. 导出 `_generated/<sampleId>/<sampleId>-mod-kind.csv`

**判定**：
- 线路样本：4 类文本格式族（TEXT_SECTION_KV_RECORD / TEXT_POINT_LINE / TEXT_KEY_VALUE / TEXT_HNUM_COMMA_RECORD）
- 变电样本：2 类 XML 格式族（XML_WITH_ENTITIES / EMPTY_DEVICE_XML）
- 若新样本出现新类别，需在报告中详细记录并更新分类函数

**脚本参考**：`docs/schema/_generated/mod-static-profile-v2.ps1`。分类函数定义见脚本 `Classify-ModText`。

#### R4.2 线路文本格式族详解（仅线路样本）

**目标**：对每类线路文本格式族做字段级分析。

**步骤**：
1. 对 TEXT_SECTION_KV_RECORD：统计 section header 分布（应为 `Bolt`）、key family（`Boltn` / `BoltNum`）
2. 对 TEXT_POINT_LINE：统计稳定 key（CODE/POINTNUM/LINENUM/POINTn/LINEn）、CODE 值分布
3. 对 TEXT_KEY_VALUE：统计主要 key（type/d/e1/e2/H1-H4）、导线参数 key（COEFFICIENTOFELASTICITY 等）
4. 对 TEXT_HNUM_COMMA_RECORD：统计 HNum 值分布、token 分布（H/Body/Leg/SubLeg/P/R/G）、最大文件规模

**对照**：与 `docs/schema/8-mod-static-survey.md` Section 4 的双样本基线对比。

#### R4.3 变电 XML 格式族详解（仅变电样本）

**目标**：对 XML Entity / primitive / TransformMatrix / Visible 做字段分析。

**步骤**：
1. 解析所有 XML_WITH_ENTITIES 的 MOD
2. 统计：
   - Entity 总数
   - Visible=True / Visible=False 计数
   - primitive 类型分布（Cylinder / Cuboid / StretchedBody / ...）
   - TransformMatrix 出现频率
   - Color 出现频率
3. 对照 `docs/schema/8-mod-static-survey.md` Section 5 的变电基线

**脚本参考**：`docs/schema/_generated/mod-static-profile-v2.ps1` 的 XML 解析部分。

#### R4.4 上游 CBM→MOD 映射

**目标**：建立 CBM entityName → MOD 的对应关系。

**步骤**：
1. 扫描所有 CBM 文件（不是树遍历，是直接扫所有 .cbm 文件）
2. 提取每个 CBM 的 `ENTITYNAME` 与 `OBJECTMODELPOINTER`
3. 沿 OBJECTMODELPOINTER → DEV → SOLIDMODEL → PHM → SOLIDMODEL → MOD 追溯
4. 建立 entityName → MOD 集合的映射
5. 统计每个 entityName 的 MOD 数量

**判定**：
- 线路 entityName 应包含：`Tower_Device` / `WIRE` / `CROSS` / `Wire_Device`
- 变电 entityName 应与设备类型对应
- `Wire_Device` 在 demo-line1 出现 1953 次但不参与几何链，需特别标注

**重要**：v1 用 CBM 树遍历会漏掉叶子 CBM（经 BACKSTRING/FRONTSTRING 到达），必须用 v2 的"扫描全部 .cbm 文件"策略。

**脚本参考**：`docs/schema/_generated/mod-upstream-diagnostic.ps1`（v2 版本）。

---

### Round 5：PHM 与 MOD 变换链分析

#### R5.1 PHM 矩阵分类

**目标**：分析 PHM 中 TRANSFORMMATRIXn 的矩阵类型分布。

**步骤**：
1. 扫描所有 `.phm` 文件
2. 提取 `SOLIDMODELn` 与 `TRANSFORMMATRIXn`（验证一一对应）
3. 解析 16 个浮点数（列主序存储，平移在 m[12]/m[13]/m[14]）
4. 分类为 IDENTITY / TRANSLATION_ONLY / ROTSCALE_ONLY / TRANSLATION+ROTSCALE / OTHER / INVALID
5. 统计 SOLIDMODELn 与 TRANSFORMMATRIXn 是否一一对应

**判定**：
- 已知三样本中 PHM 矩阵 100% 为 IDENTITY（占位符，不承担变换）
- 若新样本 PHM 出现非 IDENTITY 矩阵，需在报告中详细记录

**脚本**：[scripts/transform-chain-analysis.ps1](scripts/transform-chain-analysis.ps1)

#### R5.2 变电 MOD Entity 矩阵分析

**目标**：分析变电样本 MOD XML Entity.TransformMatrix 的分类分布。

**步骤**：
1. 解析所有 XML_WITH_ENTITIES 的 MOD 文件
2. 提取每个 `<Entity>` 的 `<TransformMatrix Value="..."/>`
3. 分类为 IDENTITY / TRANSLATION_ONLY / ROTSCALE_ONLY / TRANSLATION+ROTSCALE
4. 统计 Visible × Matrix kind 交叉分布
5. 非单位矩阵的平移分量 min/max/mean

**判定**：
- demo-substation 已知分布：IDENTITY 23.55% / TRANSLATION_ONLY 20.44% / TRANSLATION+ROTSCALE 56.00%
- 若新变电样本分布显著偏离，需进一步分析

**脚本**：[scripts/transform-chain-analysis.ps1](scripts/transform-chain-analysis.ps1)

#### R5.3 两级变换关系验证

**目标**：验证"PHM placement + MOD Entity local transform"两级变换假设。

**步骤**：
1. 抽样 20 对（PHM 矩阵 + 其引用 MOD 的第一个 Entity 矩阵）
2. 统计 PHM × MOD 矩阵组合分布：
   - PHM=Identity + MOD=Identity
   - PHM=Identity + MOD=Non-Identity
   - PHM=Non-Identity + MOD=Identity
   - PHM=Non-Identity + MOD=Non-Identity

**判定**：
- 已知三样本两级变换假设不成立（PHM 恒为单位，实际为单级变换）
- 若新样本出现 PHM=Non-Identity，假设可能成立，需详细分析

**脚本**：[scripts/transform-chain-analysis.ps1](scripts/transform-chain-analysis.ps1)

#### R5.4 线路 MOD 矩阵依赖检测

**目标**：检测线路 MOD 是否包含 TransformMatrix 字段。

**步骤**：
1. 扫描所有线路 `.mod` 文件
2. 检测矩阵字段模式：`TRANSFORMMATRIX` / `TransformMatrix` / `Matrix` / `MATRIX` / `<TransformMatrix`
3. 抽样检查 POINTn / P 字段是否含绝对坐标

**判定**：
- 已知线路 MOD 完全不依赖 TransformMatrix 字段
- 坐标以绝对值写入 POINTn（经纬度高程）或 P（笛卡尔）

**脚本**：[scripts/transform-chain-analysis.ps1](scripts/transform-chain-analysis.ps1)

---

### Round 6：变电 XML primitive 字段值范围分析（仅变电样本）

#### R6.1 primitive 类型与字段分布

**目标**：统计所有 primitive 类型的字段名分布与覆盖率。

**步骤**：
1. 解析所有 XML_WITH_ENTITIES 的 MOD 文件
2. 对每个 `<Entity>` 下的子元素（排除 TransformMatrix 与 Color），收集 primitive 名称
3. 收集每个 primitive 的所有属性（XML attributes + 子元素文本）
4. 按 primitive 类型分组统计字段名覆盖率

**判定**：
- 已知 demo-substation 有 14 种 primitive 类型（Cylinder/Cuboid/StretchedBody/PorcelainBushing/TruncatedCone/Ring/TerminalBlock/Sphere/ChannelSteel/Table/CircularGasket/RectangularFixedPlate/OffsetRectangularTable/RectangularRing）
- 若新样本出现新 primitive 类型，需在报告中记录

**脚本**：[scripts/xml-primitive-survey.ps1](scripts/xml-primitive-survey.ps1)

#### R6.2 字段值范围统计

**目标**：对每个 primitive 的数值字段做 min/max/mean/负值/零值统计。

**步骤**：
1. 基于 R6.1 收集的所有属性
2. 对每个 (primitive, field) 组合，尝试将值解析为 double
3. 统计：
   - count / min / max / mean
   - 负值数量（negatives）
   - 零值数量（zeros）
4. 导出 `_generated/<sampleId>/<sampleId>-primitive-summary.csv`

**判定**：
- 几何字段（如 R/H/L/W）应为正数，出现 0 或负数需标记异常
- 颜色字段（如 Color Value）应为 0-255 整数或 hex 字符串

**脚本**：[scripts/xml-primitive-survey.ps1](scripts/xml-primitive-survey.ps1)

#### R6.3 Color 字段分析

**目标**：分析 Color 节点的 R/G/B/A 4 通道分布。

**步骤**：
1. 解析所有 XML_WITH_ENTITIES 的 MOD 文件
2. 提取所有 `<Color R="..." G="..." B="..." A="..."/>` 节点
3. 统计 R/G/B/A 各通道分布（top 20）
4. 统计 RGB 组合 top 20
5. 统计各通道范围（min/max/mean/out-of-range）
6. 导出 `<sampleId>-color-attrs.csv`

**判定**：
- 已知 demo-substation Color 使用 R/G/B/A 4 个独立属性（不是单一 Value）
- R/G/B 应在 0-255 范围内
- A 实际取值 40 或 100（百分制透明度）
- 若新样本 Color 为 hex 或 RGB 元组格式，需在报告中记录

**脚本**：[scripts/color-analysis.ps1](scripts/color-analysis.ps1)

#### R6.4 StretchedBody 复合字段深度分析

**目标**：解析 StretchedBody.Array 与 Normal 两个复合字段，确认其编码格式与值分布。

**步骤**：
1. 提取所有 StretchedBody 节点
2. 解析 Array 字段：
   - 格式 = 分号分隔的 "x,y,z" 点序列，末尾保留分号
   - 统计点数分布（3-46 点）
   - 统计全局 X/Y/Z 坐标范围
3. 解析 Normal 字段：
   - 格式 = "x,y,z" 3 个浮点数
   - 计算向量长度分布（已知 demo-substation 100% 长度=304.8）
   - 统计 X/Y/Z 分量分布 top 10
4. 导出 `<sampleId>-stretched-body-summary.csv`

**判定**：
- 已知 demo-substation Normal 长度恒为 304.8（疑似 1 英尺 = 304.8 mm）
- 若新样本 Normal 长度不同，需在报告中记录
- Array 解析失败率应为 0

**脚本**：[scripts/stretched-body-deep.ps1](scripts/stretched-body-deep.ps1)

---

## 5. 关键判断清单

完成 Round 1-6 后，对照下表逐项确认：

| # | 检查项 | 期望 | 异常处理 |
| - | ------ | ---- | -------- |
| 1 | GIM 头部魔数 | `GIMPKGT` 或 `GIMPKGS` | 标记样本异常，停止分析 |
| 2 | 压缩签名定位 | 1MB 窗口内找到 7z 或 ZIP | 标记样本异常 |
| 3 | 解压目录结构 | CBM/DEV/PHM/MOD 四目录 | 标记样本异常 |
| 4 | 目录大小写 | 线路 PascalCase，变电大写 | 路径处理必须大小写不敏感 |
| 5 | 文件类型分布 | 与同类型基线量级一致 | 显著偏离需在报告说明 |
| 6 | 文本/二进制分类 | CBM/FAM/DEV/PHM text-like，STL binary-like | 异常需说明 |
| 7 | 引用完整性硬缺失率 | 趋近于 0 | 显著大于 0 需列明细 |
| 8 | DEV 最大深度 | 当前已知 = 1 | > 1 需标记异常 |
| 9 | DEV 是否有环 | 无 | 有环需标记异常 |
| 10 | CBM→DEV 入口对齐 | 根 DEV 都被 CBM 引用 | 孤儿 DEV 需列明细 |
| 11 | MOD 静态分类 | 与同类型基线格式族一致 | 新格式族需更新分类函数 |
| 12 | CBM→MOD 可达率 | 与同类型基线接近 | 显著偏低需做孤儿溯源 |
| 13 | IFCGUID 命中（变电） | 强命中率应高 | 硬缺失需列明细 |
| 14 | PHM 矩阵分类 | 已知 100% IDENTITY | 非 IDENTITY 需详细分析 |
| 15 | PHM × MOD 两级变换 | PHM=Identity 占主导 | PHM=Non-Identity 需详细分析 |
| 16 | 线路 MOD 矩阵依赖 | 不应含 TransformMatrix 字段 | 出现需标记异常 |
| 17 | 变电 primitive 字段类型 | 几何字段应为正数，无 0 无负值 | 0/负值需标记异常 |
| 18 | Color 字段格式 | R/G/B/A 4 个独立属性，0-255 整数，A 取 40 或 100 | 非 R/G/B/A 格式需记录 |
| 19 | StretchedBody.Normal 长度 | 恒为 304.8（1 英尺） | 长度不同需记录 |
| 20 | StretchedBody.Array 解析失败率 | 应为 0 | > 0 需检查格式异常 |

## 6. 输出报告结构

为新样本生成一份分析报告，命名 `docs/schema/<N>-<sampleId>-survey.md`（N 为下一个序号）。

**报告骨架**（参考 `8-mod-static-survey.md` 风格，分析报告而非过程流水账）：

```text
# <sampleId> 样本结构分析报告

## 1. 分析目标与范围
   1.1 目标
   1.2 分析对象（样本清单 + 基线对照集）
   1.3 分析范围
   1.4 核心判断（3-5 条要点）

## 2. 容器结构
   2.1 头部魔数与文件名
   2.2 压缩格式与偏移
   2.3 与基线对照

## 3. 文件清单
   3.1 扩展名分布
   3.2 顶层目录分布
   3.3 与同类型基线对照

## 4. 文本/二进制粗判
   4.1 分类结果
   4.2 异常项说明

## 5. 引用链与完整性
   5.1 CBM 引用链
   5.2 DEV 引用链
   5.3 PHM 引用链
   5.4 文件级引用完整性
   5.5 IFCGUID 命中（仅变电）
   5.6 FAM 字段分析

## 6. 几何可达性
   6.1 DEV 引用模式
   6.2 DEV 根/子角色与图结构
   6.3 CBM→DEV 入口对齐
   6.4 几何可达性分类
   6.5 孤儿资源溯源

## 7. MOD 静态分类
   7.1 分类结果
   7.2 线路文本格式族详解（仅线路）
   7.3 变电 XML 格式族详解（仅变电）
   7.4 上游 CBM→MOD 映射

## 8. 与基线对照总结
   8.1 一致项
   8.2 差异项
   8.3 异常项

## 9. 当前结论

## 10. 后续建议

## 附录 A：分析脚本
   A.1 容器结构脚本
   A.2 文件清单脚本
   A.3 引用链脚本
   A.4 完整性校验脚本
   A.5 MOD 分类脚本
```

**风格要求**（与 `8-mod-static-survey.md` 一致）：
- 分析报告格式，不是过程流水账
- 每个分析维度直接对比新样本与同类型基线
- 所有 PowerShell 脚本集中到文末附录 A
- 数据表格用 Markdown 表格
- 关键数字需校验加和一致（如 MOD 总数 = 各 kind 之和）
- 工程类型对比用"变电工程 vs 线路工程"分栏

## 7. 执行约定

- **路径**：所有路径大小写不敏感，不能硬编码单一目录大小写
- **脚本**：复用 `docs/schema/_generated/*.ps1` 已沉淀脚本，新脚本放同目录
- **CSV 输出**：`docs/schema/_generated/<sampleId>/<sampleId>-*.csv`
- **报告输出**：`docs/schema/<N>-<sampleId>-survey.md`
- **样本登记**：完成后更新 `docs/schema/0-sample-corpus.md`
- **PowerShell CLIXML 污染**：脚本写入文件后用 `powershell -ExecutionPolicy Bypass -File` 执行，避免 RunCommand 输出 CLIXML
- **CBM 树遍历陷阱**：v1 用 project.cbm 树遍历会漏叶子 CBM，必须用 v2 的"扫描全部 .cbm 文件"策略
- **OBJECTMODELPOINTER 顺序**：部分 CBM 中 OBJECTMODELPOINTER 出现在 ENTITYNAME 之前，需两遍扫描
- **不解析几何**：本 skill 只做静态结构验证，不解析 STL/MOD 几何、不解释坐标系
- **不入库**：不写 SQLite，不修改 parser_version

## 8. 完成标准

- 报告 `docs/schema/<N>-<sampleId>-survey.md` 已生成
- 关键判断清单 13 项全部有结论
- 所有异常项已在报告 Section 8 列出
- `docs/schema/0-sample-corpus.md` 已追加新样本登记
- `_generated/<sampleId>/` 下有完整 CSV 产物
