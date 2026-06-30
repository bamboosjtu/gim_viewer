# GIM Schema Research 目录

本目录用于沉淀 GIM 文件格式研究、样本实证结论和后续解析器实现边界。

当前文档分为两类：

1. **研究分析文档**：按分析顺序编号，记录样本事实、统计结果、引用链、异常分型和实现边界。
2. **格式说明文档**：按文件类型命名，记录单类文件的字段结构和解析约定。

研究结论只代表当前样本实证结果，不直接等同于完整 GIM 标准。新增样本后，应优先复跑编号文档中的脚本，再决定是否更新解析器。

---

## 1. 研究主线

完整解析 GIM 可以拆成三层：

```text
文件容器层
  -> 工程语义层
     -> 几何 / 图纸展示层
```

当前建议的阅读与研究顺序如下。

| 顺序 | 文档 | 关注问题 | 状态 |
| ---: | ---- | -------- | ---- |
| 0 | [0-sample-corpus.md](0-sample-corpus.md) | 样本台账、样本边界、后续样本登记规则 | 持续维护 |
| 1 | [1-gim-container-analysis.md](1-gim-container-analysis.md) | `.gim` 外壳、GIMPKG 魔数、压缩格式、payload offset | 已纳入 3 个样本 |
| 2 | [2-gim-file-inventory.md](2-gim-file-inventory.md) | 解压后文件清单、目录大小写、文本/二进制粗判 | 已纳入 3 个样本 |
| 3 | [3-gim-file-role-matrix.md](3-gim-file-role-matrix.md) | CBM/FAM/DEV/PHM/MOD/STL/IFC/SCH/STD/SLD 文件角色 | 待随新样本复核 |
| 4 | [4-cbm-field-dictionary.md](4-cbm-field-dictionary.md) | CBM 字段、线路/变电差异、CBM 下游引用 | 待随新样本复核 |
| 5 | [5-gim-reference-integrity.md](5-gim-reference-integrity.md) | CBM/DEV/PHM 文件级引用完整性、IFCGUID 命中分型 | 待随新样本复核 |
| 6 | [6-cbm-fam-consistency.md](6-cbm-fam-consistency.md) | CBM -> FAM 覆盖关系、FAM 字段形态、属性 sidecar 判断 | 待随新样本复核 |
| 7 | [7-dev-phm-geometry-reachability.md](7-dev-phm-geometry-reachability.md) | DEV/PHM 递归、MOD/STL 几何目标可达性、无几何装配节点 | 待随新样本复核 |
| 8 | [8-mod-static-survey.md](8-mod-static-survey.md) | MOD 静态分型、线路/变电 MOD 格式边界、可解析性边界 | 待随新样本复核 |
| 汇总 | [gim-analysis-summary.md](gim-analysis-summary.md) | 历史阶段性总览与长文汇总 | 后续宜逐步瘦身 |

---

## 2. 文件类型说明文档

以下文档更接近“格式说明 / parser 设计输入”，不承担样本统计主线。

| 文档 | 角色 |
| ---- | ---- |
| [cbm.md](cbm.md) | CBM 工程骨架与层级关系说明 |
| [fam.md](fam.md) | FAM 属性文件说明 |
| [dev.md](dev.md) | DEV 物理模型与设备组合说明 |
| [phm.md](phm.md) | PHM 组合模型与 MOD/STL 引用说明 |
| [mod.md](mod.md) | MOD 基础几何/参数化模型说明 |
| [sch.md](sch.md) | SCH 逻辑模型说明 |
| [std.md](std.md) | STD 逻辑定义说明 |
| [sld.md](sld.md) | SLD 主接线图/图形表达说明 |

---

## 3. 新样本接入顺序

新增 GIM 样本时，先只更新文件层研究，不直接改 parser。

推荐顺序：

```text
Step 0: 更新 0-sample-corpus.md 样本台账
Step 1: 复核 1-gim-container-analysis.md 的魔数、压缩格式、offset
Step 2: 复核 2-gim-file-inventory.md 的文件清单、目录分布、文本/二进制粗判
Step 3: 复核 3/4/5 的文件角色、CBM 字段、引用完整性
Step 4: 复核 7/8 的 DEV/PHM 几何可达性与 MOD 静态分型
Step 5: 再决定是否进入 STL/MOD 渲染实现
```

---

## 4. 文档维护规则

- 编号文档按研究流程排序，不按文件类型排序。
- 文件类型说明文档按扩展名命名，不加编号。
- `_generated/` 仅存放临时 CSV、诊断表和可复跑输出，不作为人工维护文档。
- 任何结论都要区分“当前样本事实”和“候选通用规则”。
- 遇到 demo 实证与背景规范不一致时，优先记录实证结果，并标注边界。
- 在解析器实现前，先完成样本复核和诊断分型，避免把单一样本特征写死。
