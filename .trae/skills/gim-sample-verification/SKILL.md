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
| 样本登记 | `docs/schema/00-sample-corpus.md` |
| 容器结构 | `docs/schema/01-gim-container-analysis.md` |
| 文件清单 | `docs/schema/02-gim-file-inventory.md` |
| 文件角色 | `docs/schema/03-gim-file-role-matrix.md` |
| CBM 字段 | `docs/schema/04-cbm-field-dictionary.md` + `docs/schema/cbm.md` |
| 引用完整性 | `docs/schema/05-gim-reference-integrity.md` |
| CBM/FAM 一致性 | `docs/schema/06-cbm-fam-consistency.md` + `docs/schema/fam.md` |
| 几何可达性 | `docs/schema/07-dev-phm-geometry-reachability.md` + `docs/schema/dev.md` + `docs/schema/phm.md` |
| MOD 静态分型 | `docs/schema/08-mod-static-survey.md` + `docs/schema/mod.md` |
| PHM/MOD 变换链 | `docs/schema/09-transform-chain-analysis.md` |
| 变电 XML primitive | `docs/schema/10-substation-mod-grammar.md` |
| 线路 MOD 文本格式族 | `docs/schema/11-line-mod-grammar.md` |
| STL 静态角色 | `docs/schema/12-stl-static-survey.md` |
| Geometry IR schema | `docs/schema/13-geometry-ir-schema.md` |
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
| [scripts/line-mod-grammar-deep.ps1](scripts/line-mod-grammar-deep.ps1) | Round 7 | 线路 MOD 4 类文本格式族深度分析（grammar 与 parser 边界） |
| [scripts/stl-static-survey.ps1](scripts/stl-static-survey.ps1) | Round 8 | STL 格式检测 + PHM 引用扫描 + CBM entityName 上游溯源 |

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
3. 在 `docs/schema/00-sample-corpus.md` 追加一行登记
4. 创建输出目录 `docs/schema/_generated/<sampleId>/`

### 3.3 验证

- SHA256 不与已有样本重复
- 解压后根目录应包含 CBM/DEV/PHM/MOD 四个目录（大小写不敏感）

## 4. 验证流程

按 Round 1 → Round 2 → Round 3 → Round 4 → Round 5 → Round 6 → Round 7 → Round 8 → Round 9 顺序执行。Round 1-8 为样本分析（每轮输出 CSV 到 `_generated/<sampleId>/`，最终汇总到一份 Markdown 报告），Round 9 为 IR schema 设计（输出 `docs/schema/13-geometry-ir-schema.md`）。

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

### Round 7：线路 MOD 文本格式族 grammar 与 parser 边界（仅线路样本）

#### R7.1 TEXT_HNUM_COMMA_RECORD 深度解析

**目标**：解析杆塔主体分段构件的层级结构与 P/R/G 记录字段语义。

**步骤**：
1. 提取所有 `HNum,n` 起始的 MOD 文件
2. 解析层级：HNum → H 记录 → Body 段 → P/R/G 记录 → HSubLeg/HLeg
3. 统计：
   - HNum 分布（档位总数）
   - bodyCount / legCount 分布
   - 单文件 P/R/G 记录数（min/max/mean/total）
   - R 记录 token 数分布（11/5/9 三变体）
   - G 记录 token 数分布
   - P 记录 X/Y/Z 坐标全局范围
4. 抽样 R/G 记录原文（前 3 文件，前 5 条）
5. 统计其他记录类型（HSubLeg1-N / HLeg1-N）
6. 导出 `<sampleId>-text-hnum-summary.csv`

**判定**：
- 已知 demo-line R 记录有 11/5/9 三种 token 变体：
  - 11 token（角钢，含双方向向量，占 99.79%）
  - 5 token（钢管，无方向向量，占 0.21%）
  - 9 token（罕见，仅 2 条，需弱 schema 兜底）
- G 记录恒为 6 token：`G,type,name,X,Y,Z`（type=G 地线 / C 导线）
- HSubLeg/HLeg 出现在 Body 段后，描述塔腿信息（HSubLeg 含偏移，HLeg 仅含 X/Y）
- 若新样本出现新 R token 变体，需在报告中记录

**脚本**：[scripts/line-mod-grammar-deep.ps1](scripts/line-mod-grammar-deep.ps1)

#### R7.2 TEXT_POINT_LINE 深度解析

**目标**：解析经纬度点线表的格式稳定性与 CODE 业务映射。

**步骤**：
1. 提取所有含 `CODE=` / `POINTNUM=` / `LINENUM=` 的 MOD 文件
2. 统计：
   - CODE 值分布（已知 demo-line 有 201/30/31/32/33/34/35 共 7 种）
   - POINTNUM 分布
   - LINENUM 分布
   - POINT 记录 token 数（恒为 5）
   - LINE 记录 token 数（恒为 2）
   - POINT 第 5 token（type 字段）分布
   - POINT 经纬度全局范围（lat/lon/alt）
3. 导出 `<sampleId>-text-point-line-summary.csv`

**判定**：
- 已知 demo-line POINT 格式 100% 稳定：`id,lat,lon,alt,type`（5 token）
- LINE 格式 100% 稳定：`fromId,toId`（2 token）
- type 字段仅取值 13 / 42，含义未在 GIM 规范中明示
- CODE 取值与 POINTNUM/LINENUM 非一一对应，**不应在 parser 层硬编码业务含义**
- CROSS 类型由上游 CBM entityName 决定，与 CODE 无关
- 若新样本 POINT token 数 ≠ 5 或 LINE token 数 ≠ 2，需在报告中记录

**脚本**：[scripts/line-mod-grammar-deep.ps1](scripts/line-mod-grammar-deep.ps1)

#### R7.3 TEXT_SECTION_KV_RECORD 深度解析

**目标**：解析螺栓参数表的固定结构。

**步骤**：
1. 提取所有 section header 起始的 MOD 文件
2. 统计：
   - Section header 分布（已知 demo-line 100% 为 `Bolt`）
   - BoltNum 分布（已知 demo-line 仅 4 或 8）
   - Bolt 记录逗号 token 数（恒为 15）
   - Bolt 记录分号段数（恒为 2）
   - 其他 KV keys（应无）
3. 抽样 Bolt 记录原文（前 3 文件）
4. 导出 `<sampleId>-text-section-kv-summary.csv`

**判定**：
- 已知 demo-line 全部 1300 文件 section header 恒为 `Bolt`
- BoltNum 仅取 4 或 8 两种值（4 占 92%，8 占 8%）
- BoltN 记录格式 100% 稳定：`<segment1>;<segment2>`，segment1 = 15 逗号 token，segment2 = 3-4 逗号 token（含坐标 X/Y/Z）
- 螺栓 X/Y 呈对称分布（如 ±165），符合法兰盘对称布置
- 若新样本出现非 `Bolt` 的 section header 或 Bolt token 数 ≠ 15，需在报告中记录

**脚本**：[scripts/line-mod-grammar-deep.ps1](scripts/line-mod-grammar-deep.ps1)

#### R7.4 TEXT_KEY_VALUE 深度解析

**目标**：判定 Tower_Device 基础参数与 WIRE 导线参数是否可稳定分离。

**步骤**：
1. 提取所有 KV 行为主的 MOD 文件
2. 收集每个文件的 key 集合，按出现顺序形成签名
3. 按签名分组统计文件数
4. 抽样每种签名的前 12 行 KV 内容
5. 导出 `<sampleId>-text-key-value-summary.csv`

**判定**：
- 已知 demo-line 有 2 种 key set 签名：
  - 签名 1（152 文件）：`type,H1,H2,H3,H4,d,e1,e2` → Tower_Device 基础参数（小写 key）
  - 签名 2（9 文件）：`TYPE,SECTIONALAREA,OUTSIDEDIAMETER,WIREWEIGHT,COEFFICIENTOFELASTICITY,EXPANSIONCOEFFICIENTOFWIRE,RATEDSTRENGTH` → WIRE 导线参数（大写 key）
- 两签名 key 集合无重叠，可按"key 大小写"或"是否含 SECTIONALAREA"100% 稳定分离
- 注意：Tower_Device 签名未含 `D`，但实测全部 152 文件均有 D 字段（与 d 同值），parser 应将 D 列为可选字段
- 若新样本出现新签名，需保留 `Record<string, string>` 弱 schema 兜底

**脚本**：[scripts/line-mod-grammar-deep.ps1](scripts/line-mod-grammar-deep.ps1)

---

### Round 8：STL 静态角色与 MOD 关系分析

#### R8.1 STL 格式检测

**目标**：判定 STL 是 ASCII 还是 binary，统计三角面数与文件规模。

**步骤**：
1. 读取每个 STL 前 84 字节
2. 取偏移 80 处 4 字节 int32 LE = N（声称的三角面数）
3. 验证文件大小 == 84 + 50 * N → binary STL
4. 否则检查首 5 字节是否 "solid" → ASCII STL
5. 统计 format / size / triangles 的 min/max/mean/total
6. 抽样前 3 个 STL 的 header 内容
7. 导出 `<sampleId>-stl-summary.csv`

**判定**：
- 已知三样本 2066 个 STL 全部为 binary STL（100%）
- 线路样本 header 全空白（0x20 填充）
- 变电样本 header 内容为 "name"（前 4 字节，后接 0x00 填充）
- 若新样本出现 ASCII STL 或 header 异常内容，需在报告中记录

**脚本**：[scripts/stl-static-survey.ps1](scripts/stl-static-survey.ps1)

#### R8.2 PHM → STL 引用扫描

**目标**：判定 STL 是否全部被 PHM 引用，分析 STL 复用模式。

**步骤**：
1. 扫描所有 PHM 的 `SOLIDMODELn` 字段，提取 `.stl` / `.mod` 引用
2. 统计 PHM 引用模式：
   - PHM with ONLY STL（仅引用 STL，无 MOD）
   - PHM with STL + MOD（同时引用两者）
   - PHM with MOD only（仅引用 MOD）
   - PHM with no SOLIDMODEL ref（无几何引用）
3. 统计 STL 覆盖率：被 PHM 引用的 STL 数 / STL 总数
4. 统计 STL 复用分布：每个 STL 被 N 个 PHM 引用的次数分布
5. 导出 `<sampleId>-stl-phm-refs.csv`

**判定**：
- 已知三样本 STL 覆盖率均为 100%（无孤儿 STL）
- 已知三样本 STL 完全不复用（每个 STL 仅被 1 个 PHM 引用）
- 与 MOD 复用模式形成对比（MOD 最大复用 70 次）
- 若新样本出现 STL 复用或孤儿 STL，需在报告中记录

**脚本**：[scripts/stl-static-survey.ps1](scripts/stl-static-survey.ps1)

#### R8.3 CBM entityName × STL 上游溯源

**目标**：建立 entityName → STL 的映射关系，判定 STL 服务哪些设备类型。

**步骤**：
1. 扫描所有 CBM 提取 (entityName, OBJECTMODELPOINTER) 对
2. 递归收集 DEV → DEV → PHM（处理 SUBDEVICE 嵌套，加 visited 防环）
3. 从 PHM 收集 STL 与 MOD 引用
4. 按 entityName 聚合：
   - hasSTL（CBM refs 触达 STL 的数量）
   - STL-only（仅触达 STL，无 MOD）
   - STL+MOD（同时触达 STL 和 MOD）
   - MOD-only（仅触达 MOD，无 STL）
5. 按 entityName × MOD-kind 组合聚合（含 uniqueSTLs/uniqueMODs 计数）
6. 导出 `<sampleId>-stl-upstream.csv`

**判定**：
- 线路样本 entityName → STL 映射：
  - Wire_Device → 100% STL（小模型，平均 7-8 KB / 144-159 三角面，金具/绝缘子串）
  - Tower_Device → 62-75% STL + 25-38% MOD（分流：STL 为整体塔几何，MOD 为参数化）
  - CROSS → 0% STL（100% TEXT_POINT_LINE）
  - WIRE → 0% STL（100% TEXT_KEY_VALUE）
- 变电样本 entityName → STL 映射：
  - F4System → 37% has STL（30 STL-only + 76 STL+MOD 并存）/ 63% MOD-only
  - PARTINDEX → 0.3% has STL（仅 10 个 STL+MOD 并存）/ 99.7% MOD-only
- 若新样本出现 entityName 与 STL 的新组合，需在报告中记录

**脚本**：[scripts/stl-static-survey.ps1](scripts/stl-static-survey.ps1)

#### R8.4 STL 与 MOD 关系判定

**目标**：判定 STL 与 MOD 是互斥、并列还是 fallback 关系。

**步骤**：
1. 基于 R8.2 的 PHM 引用模式统计
2. 计算四种模式的占比：
   - PHM ONLY STL
   - PHM STL + MOD
   - PHM MOD only
   - PHM no ref
3. 按工程类型对照：
   - 线路样本预期：STL 与 MOD 互斥（0 PHM 同时引用两者）
   - 变电样本预期：STL 与 MOD 可并列共存（部分 PHM 同时引用两者）

**判定**：
- 线路样本：PHM 级完全互斥（demo-line / demo-line1 均 0 PHM 同时引用 STL+MOD）
  - STL 与 MOD 是"分流"关系，由 PHM 决定走哪条路径
  - 无 fallback 关系（MOD 解析失败不会回退到 STL）
- 变电样本：86 个 PHM 同时引用 STL+MOD（2.1%）
  - STL 与 MOD 可并列共存
  - 30 个 PHM 仅引用 STL（0.7%，可能是不可参数化的复杂设备）
  - 需进一步评估 86 个并列 PHM 是否描述同一几何（潜在重复风险）
- 若新样本偏离上述模式，需在报告中详细记录

**脚本**：[scripts/stl-static-survey.ps1](scripts/stl-static-survey.ps1)

---

### Round 9：统一 Geometry IR schema 设计

> Round 9 是 IR schema **设计**而非样本分析，无对应分析脚本。完成后输出 `docs/schema/13-geometry-ir-schema.md`，把 Round 1-8 的静态分析结论沉淀为统一 schema 草案，作为后续 viewer 层渲染与属性展示的统一对接接口。

#### R9.1 IR 范围与边界

**目标**：把 Round 1-8 的全部静态分析结论沉淀为统一的 Geometry IR schema 草案。

**输入**：Round 1-8 的分析报告（00-12 号文档）
**输出**：`docs/schema/13-geometry-ir-schema.md`

**设计原则**：
- IR 是纯数据结构，不绑定 UI、Three.js 或 OBC
- 联合类型分发，避免巨型 interface
- 每个 kind 自带最小必要字段，不复制原始文件内容
- 大字段保留 path 引用，由 viewer 按需读取
- none 分支显式表达"无几何"，避免 null 散落
- SQLite schema 变更不在 IR 范围（正式 DDL 另起 14-geometry-cache-schema.md）

#### R9.2 顶层联合类型设计

**目标**：定义 `GimGeometrySource` 联合类型，覆盖 Round 1-8 已识别的全部几何来源。

**步骤**：
1. 梳理 5 种几何来源 kind：
   - `ifc`：既有 IFC 主路径（变电 IFC）
   - `xml-mod`：变电 XML primitive 体系（Round 6，14 类 primitive）
   - `line-text-mod`：线路 4 类文本格式族（Round 7，LineModFormat 枚举）
   - `stl`：STL 三角网格（Round 8，100% binary）
   - `none`：无几何分支（EMPTY_DEVICE_XML / 14 个空 PHM / 缺失引用）
2. 为每个 kind 定义详细 interface（最小必要字段 + path 引用）
3. **顶层联合类型引用各 kind 的 interface**，避免 inline union 字段与详细 interface 不一致
4. 定义 `NoneReason` 枚举，区分：
   - `phm-no-solidmodel`：PHM 无 SOLIDMODEL 字段（底层事实状态）
   - `assembly-node-without-own-geometry`：装配节点自身无几何但子设备几何完整（变电 14 个 PHM）
   - 其他 6 种 reason（empty-device-xml / phm-missing-target / cbm-no-objectmodelpointer / dev-no-solidmodel / parser-unsupported / parse-failed / unknown）

**对照基线**：`docs/schema/13-geometry-ir-schema.md` §2-§3

#### R9.3 解析管道与实例化

**目标**：定义 CBM → GimGeometrySource 的 5 层解析管道，附加 TransformMatrix + Color 形成 `GimGeometryInstance`。

**步骤**：
1. 5 层管道分层：
   - CBM → OBJECTMODELPOINTER 提取
   - DEV → 递归收集 SOLIDMODEL → PHM / child DEV（加 visited 防环，最大深度 1）
   - PHM → 提取 SOLIDMODELn + TRANSFORMMATRIXn + COLORn
   - SOLIDMODEL → 按扩展名分发到 GimGeometrySource（.ifc / .mod / .stl）
   - 实例化 → 附加 TransformMatrix + Color 形成 GimGeometryInstance[]
2. CBM 节点级聚合为 `CbmGeometryBundle`（包含 instances + ifcModelIds）
3. 解析器入口签名：`GeometryParser.resolveBundle` / `resolveBundles`

**对照基线**：`docs/schema/13-geometry-ir-schema.md` §4

**关键约束**：
- PHM TransformMatrix 已知 100% IDENTITY（Round 5），IR 设计保留两级字段（结构保留 + 实际单级变换），避免未来样本出现非 IDENTITY 时返工
- MOD 在线路样本最大复用 70 次，需要 GimGeometryInstance 表达"同 source 多 instance"
- 内存优化策略（如 InstancedMesh）由 viewer 层决定，不在 IR 范围

#### R9.4 缺陷对照表与补齐优先级

**目标**：把 gim_viewer 当前展示能力的 15 项缺陷与 IR 补齐路径对照，按 P0/P1/P2 排期。

**步骤**：
1. 列出 gim_viewer 当前缺陷（变电几何/属性、线路几何/属性、缓存命中、节点联动）
2. 每项缺陷对应 IR 补齐路径（kind + format + Loader）
3. 按 P0/P1/P2 分级：
   - P0（MVP 必补）：xml-mod 渲染、text-hnum 渲染、Bolt 属性面板、KV 属性面板、属性按 format 分发
   - P1（MVP 可选）：STL 渲染、PHM COLOR 应用
   - P2（体验补齐）：none 提示、CROSS 3D、PHM TransformMatrix 应用、缓存回放、节点联动

**对照基线**：`docs/schema/13-geometry-ir-schema.md` §6

#### R9.5 与既有代码的兼容性

**目标**：确认 IR 设计不破坏现有 IFC 主路径、CbmNode 类型和 AppState。

**步骤**：
1. 现有 IFC 路径：CBM → ifcFile/ifcGuid → ifcLoader → OBC Fragments
2. IR 兼容路径：CBM → irBuilder → CbmGeometryBundle → instances.find(isIfcSource) → 复用 ifcLoader
3. CbmNode 类型保留 ifcFile/ifcGuid 字段（IR 不替代，仅消费 path/entityName/devPath）
4. AppState 新增可选字段：geometryBundles / cachedGeometryPaths（向后兼容）

**对照基线**：`docs/schema/13-geometry-ir-schema.md` §9

#### R9.6 落地路径与风险点

**目标**：把 IR schema 落地分解为 7 个阶段，并标注 7 个已知风险点。

**步骤**：
1. 7 阶段实施：
   - 阶段 1：IR schema 落地（src/gim/geometry/ir.ts）
   - 阶段 2：xml-mod 渲染（P0）
   - 阶段 3：line-text-mod 属性面板（P0）
   - 阶段 4：text-hnum-comma-record 渲染（P0）
   - 阶段 5：stl 渲染（P1）
   - 阶段 6：缓存命中回放（P2）
   - 阶段 7：none 分支提示（P2）
2. 7 个风险点：
   - 9 类低样本 primitive 字段未完全拆解（需 Round 6.5 补充）
   - R 记录 9 token 变体样本不足（2 条）
   - 86 个变电 STL+MOD 并存 PHM 是否重复（需 Round 8.5 采样）
   - PHM TransformMatrix 已知 100% IDENTITY（保留字段但阶段 2-5 可忽略）
   - PARSER_VERSION 升级失效缓存
   - 内存占用（建议按需懒加载）
   - Wire_Device 11773 CBM refs 实际仅 8 unique STL（需几何缓存池）

**对照基线**：`docs/schema/13-geometry-ir-schema.md` §7

#### R9.7 当前不能得出的结论

**目标**：明确 IR 设计阶段无法得出结论的 8 个开放问题，留待实施阶段补充。

**步骤**：
1. 列出 8 个开放问题：
   - xml-mod 9 类低样本 primitive 的精确字段
   - 86 个变电 STL+MOD 并存 PHM 是否描述同一几何
   - text-hnum-comma-record R 记录 9 token 变体字段语义
   - text-point-line CODE 字段业务含义
   - 缓存命中时 geometry_source 表 schema 设计（应另起 14-geometry-cache-schema.md）
   - IR 是否需要支持几何变换的"组合"
   - line-text-mod 的 records 字段是否应强类型化
   - none 分支的 reason 是否需要扩展

**对照基线**：`docs/schema/13-geometry-ir-schema.md` §8

---

## 5. 关键判断清单

完成 Round 1-9 后，对照下表逐项确认：

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
| 21 | TEXT_HNUM_COMMA_RECORD R token 变体 | 11/5/9 三种（11 占 99%） | 新变体需记录并加弱 schema |
| 22 | TEXT_POINT_LINE POINT/LINE token 数 | POINT=5, LINE=2（恒定） | ≠ 5 或 ≠ 2 需标记异常 |
| 23 | TEXT_SECTION_KV_RECORD section header | 恒为 `Bolt`，BoltNum=4 或 8 | 新 header 或 BoltNum 需记录 |
| 24 | TEXT_KEY_VALUE 签名 | 2 种（Tower_Device 小写 / WIRE 大写） | 新签名需加弱 schema 兜底 |
| 25 | STL 格式 | 100% binary（84 + 50*N 公式匹配） | ASCII 或公式不匹配需记录 |
| 26 | STL PHM 引用率 | 100%（无孤儿 STL） | < 100% 需记录孤儿 STL |
| 27 | 线路 STL 与 MOD 在 PHM 级 | 互斥（0 PHM 同时引用） | 出现并列 PHM 需详细分析 |
| 28 | 变电 STL 与 MOD 在 PHM 级 | 部分并列（86 PHM 同时引用） | 出现大量并列 PHM 需评估重复风险 |
| 29 | IR 顶层联合类型 | 引用各 kind 的 interface，非 inline union | inline union 与详细 interface 字段不一致需修正 |
| 30 | IR NoneReason 区分 | `phm-no-solidmodel`（底层事实）vs `assembly-node-without-own-geometry`（装配节点） | 缺失区分需补 reason |
| 31 | IR 两级变换表述 | 结构保留两级字段，明确 PHM 100% IDENTITY，实际单级变换 | 表述为"两级变换"但未注明 IDENTITY 需修正 |
| 32 | IR SQLite 范围 | 仅给字段建议，正式 DDL 另起 14-geometry-cache-schema.md | IR 文档内包含正式 DDL 需拆出 |
| 33 | IR 缺陷对照表 | 15 项缺陷全部对应 kind/format/Loader 路径 | 缺项需补 |
| 34 | IR 兼容性 | 不破坏现有 IFC 路径、CbmNode 类型、AppState | 破坏需重新设计 |

## 6. 输出报告结构

为新样本生成一份分析报告，命名 `docs/schema/<N>-<sampleId>-survey.md`（N 为下一个序号）。

**报告骨架**（参考 `08-mod-static-survey.md` 风格，分析报告而非过程流水账）：

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

**风格要求**（与 `08-mod-static-survey.md` 一致）：
- 分析报告格式，不是过程流水账
- 每个分析维度直接对比新样本与同类型基线
- 所有 PowerShell 脚本集中到文末附录 A
- 数据表格用 Markdown 表格
- 关键数字需校验加和一致（如 MOD 总数 = 各 kind 之和）
- 工程类型对比用"变电工程 vs 线路工程"分栏

### 6.1 IR schema 文档骨架（Round 9 输出）

完成 Round 1-8 后，如需更新统一 IR schema，输出 `docs/schema/13-geometry-ir-schema.md`（参考现有 13 号文档风格）：

```text
# 统一 Geometry IR 草案

## 1. 目标与背景
   1.1 现状缺陷（gim_viewer 当前展示能力缺陷表）
   1.2 设计目标（5 条原则，含两级变换表述）
   1.3 不在 IR 范围（SQLite DDL 另起 14-geometry-cache-schema.md）

## 2. 顶层 IR 联合类型
   2.1 GimGeometrySource（引用各 kind 的 interface，非 inline union）
   2.2 NoneReason 枚举（含 assembly-node-without-own-geometry）
   2.3 LineModFormat 枚举（4 类文本格式族）

## 3. 各 kind 详细 schema
   3.1 ifc（IfcGeometrySource，含 cachedPath）
   3.2 xml-mod（XmlModEntity + XmlModPrimitive 联合 + XmlModColor）
   3.3 line-text-mod（LineTextModGeometrySource，records: unknown）
   3.4 stl（StlGeometrySource，含 header）
   3.5 none（NoneGeometrySource，含 detail）

## 4. 上游 CBM → GeometrySource 解析管道
   4.1 管道分层（5 层）
   4.2 GimGeometryInstance（附加 TransformMatrix + Color）
   4.3 CbmGeometryBundle（CBM 节点级聚合）
   4.4 解析器入口签名

## 5. 类型守卫与消费方约定
   5.1 类型守卫
   5.2 消费方约定（Viewer / UI / 缓存层）

## 6. 现有 gim_viewer 缺陷与 IR 补齐路径
   6.1 缺陷对照表（15 项）
   6.2 补齐优先级（P0/P1/P2）

## 7. 实现路径建议
   7.1 分阶段实施（7 阶段）
   7.2 风险点（7 个）

## 8. 当前不能得出的结论（8 个开放问题）

## 9. 与既有代码的兼容性

## 10. 附录 A：完整 TypeScript schema 草案

## 11. 附录 B：Round 1-8 关键发现汇总

## 12. 附录 C：与既有文档的引用关系
```

**风格要求**：
- IR schema 是设计文档，不是分析报告
- 顶层联合类型必须引用详细 interface，不能 inline
- NoneReason 必须区分 `phm-no-solidmodel` 和 `assembly-node-without-own-geometry`
- 两级变换表述必须明确"PHM 100% IDENTITY，实际单级变换"
- SQLite DDL 不在 IR 范围，仅给字段建议

## 7. 执行约定

- **路径**：所有路径大小写不敏感，不能硬编码单一目录大小写
- **脚本**：复用 `docs/schema/_generated/*.ps1` 已沉淀脚本，新脚本放同目录
- **CSV 输出**：`docs/schema/_generated/<sampleId>/<sampleId>-*.csv`
- **报告输出**：`docs/schema/<N>-<sampleId>-survey.md`
- **样本登记**：完成后更新 `docs/schema/00-sample-corpus.md`
- **PowerShell CLIXML 污染**：脚本写入文件后用 `powershell -ExecutionPolicy Bypass -File` 执行，避免 RunCommand 输出 CLIXML
- **CBM 树遍历陷阱**：v1 用 project.cbm 树遍历会漏叶子 CBM，必须用 v2 的"扫描全部 .cbm 文件"策略
- **OBJECTMODELPOINTER 顺序**：部分 CBM 中 OBJECTMODELPOINTER 出现在 ENTITYNAME 之前，需两遍扫描
- **不解析几何**：本 skill 只做静态结构验证，不解析 STL/MOD 几何、不解释坐标系
- **不入库**：不写 SQLite，不修改 parser_version

## 8. 完成标准

- 报告 `docs/schema/<N>-<sampleId>-survey.md` 已生成
- 关键判断清单 34 项全部有结论
- 所有异常项已在报告 Section 8 列出
- `docs/schema/00-sample-corpus.md` 已追加新样本登记
- `_generated/<sampleId>/` 下有完整 CSV 产物
- 若执行 Round 9：`docs/schema/13-geometry-ir-schema.md` 已更新（IR schema 设计文档）
