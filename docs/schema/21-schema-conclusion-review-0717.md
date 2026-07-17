# docs/schema 结论复核（2026-07-17）

## 1. 复核结论

`docs/schema` 的三样本基础事实总体可信：三个 `.gim` 文件未变化，容器头、7z payload offset、解压目录数量、MOD 格式族和 STL 二进制统计均可复现。

本轮发现的问题主要不在样本统计，而在文档时间层混杂：部分研究启动时的“未实现/仅 IFC/待实施”仍被写成当前状态；部分后续实现又改变了早期设计（例如 MOD 粒度 GLB 改为 DEV 粒度）。本轮已把样本事实、历史设计和当前实现状态分开标注。

## 2. 证据等级

| 等级 | 含义 |
|---|---|
| A | 2026-07-17 直接读取原始 `.gim` 或解包样本并重新统计 |
| B | 样本 SHA-256 未变化，复核现有生成物/脚本并做针对性抽查；未全量重算所有关系表 |
| C | 对照 2026-07-17 当前源码、测试声明与常量，复核实现状态；不等同于运行时验收 |

`docs/schema/_generated/` 被 `.gitignore` 排除，里面的脚本和输出只作为本机可复跑证据。本轮对 BOM 与 KVALUE 计数逻辑的本地修正不会作为人工维护文档提交；可持久化的更正已写入 08、15 和本文。

## 3. 原始样本复核

### 3.1 样本身份

| 样本 | 大小（byte） | SHA-256 | 结果 |
|---|---:|---|---|
| `demo-line.gim` | 18,905,874 | `54394E14A3547D77276A9AA1022B4ADD6CC14A7A1E7AB7F67D330BBA876669AE` | 与 00 一致 |
| `demo-line1.gim` | 5,652,236 | `97A5699005B6A03D7C4304DA61D10B216C5804D6FC61032432A6BD72547AA829` | 与 00 一致 |
| `demo-substation.gim` | 14,381,403 | `711259814DB95999F5282AF1871DA9CB50DB4548B71626637B33038B062FC390` | 与 00 一致 |

### 3.2 容器与目录

| 样本 | Header | 7z offset | 解包文件数 | 结果 |
|---|---|---:|---:|---|
| `demo-line` | `GIMPKGT` | 784 | 62,656 | 与 01/02 一致 |
| `demo-line1` | `GIMPKGT` | 784 | 12,372 | 与 01/02 一致 |
| `demo-substation` | `GIMPKGS` | 784 | 36,112 | 与 01/02 一致 |

线路目录使用 `Cbm/Dev/Phm/Mod`，变电目录使用 `CBM/DEV/PHM/MOD`；代码和文档都不能假设固定大小写。

### 3.3 MOD

修正 `_generated/mod-static-profile-v2.ps1` 的 UTF-8 BOM 处理后重扫：

| 样本 | MOD 总数 | 格式族分布 |
|---|---:|---|
| `demo-line` | 1,807 | SECTION_KV 1300；POINT_LINE 315；KEY_VALUE 161；HNUM 31 |
| `demo-line1` | 508 | POINT_LINE 300；SECTION_KV 156；KEY_VALUE 34；HNUM 18 |
| `demo-substation` | 4,179 | XML_WITH_ENTITIES 4135；XML_EMPTY_DEVICE 44 |

变电样本共 46,250 个 Entity，14 类 primitive 的数量、Visible 分布和字段统计与 08/10 一致。

### 3.4 STL

按 binary STL 长度公式 `84 + 50 × triangleCount` 全量扫描：

| 样本 | 文件数 | binary | triangle min/max/avg | triangle 总数 |
|---|---:|---:|---|---:|
| `demo-line` | 181 | 181 | 120 / 98,204 / 4,145.33 | 750,304 |
| `demo-line1` | 82 | 82 | 120 / 11,322 / 2,904.80 | 238,194 |
| `demo-substation` | 1,803 | 1,803 | 60 / 3,112 / 463.05 | 834,874 |

线路 STL header 为空，变电 STL header 为 `name`；12 号文档的基础 STL 结论保持有效。

## 4. 文档逐组复核结果

| 文档 | 等级 | 结论 |
|---|---|---|
| 00 | A | 样本大小与哈希一致，增加最近复核日期 |
| 01 | A | `GIMPKGT/GIMPKGS`、7z、offset=784 均一致 |
| 02 | A+C | 文件数量一致；“不进入几何解析”已改为当前 parser/渲染边界 |
| 03 | B+C | 文件角色仍成立；“当前处理策略”明确改为历史基线 |
| 04-07 | B | 字段、FAM 覆盖和引用链结论保留；因样本哈希未变化，现有 CSV 证据仍对应当前样本。本轮未全量重算数千万行关系表 |
| 08 | A | 三样本 MOD 分型一致；修复 BOM 导致的变电 XML 误分型风险 |
| 09 | B+C | 完整 CBM×DEV×PHM×Entity 变换链及 20 号 PARTINDEX 更正保留；矩阵术语已统一为列主序。53.4%/87.8% 仅来自唯一变电样本，需新变电样本复核 |
| 10 | A+C | 14 类 primitive 样本统计一致；当前仅 7 类渲染，另 7 类返回 `null`，已修正文档 |
| 11 | A+C | 四类线路 grammar 对两样本成立；parser 已实现且 38 个测试通过，但没有运行时消费者 |
| 12 | A+B | STL 二进制统计已全量重算；设备映射沿用未变化样本的生成物。demo-line 工程头为 500kV，已撤销“220kV 工程”归因 |
| 13 | C | IR 设计仍可用；§1/§6 改标为历史实现基线，不能再作为当前缺陷表 |
| 14 | C | 研究边界有效；当前默认开启的实验悬链线偏离“默认禁用/直线默认/语义未确认不写死”的建议 |
| 15 | B | 样本证据保留；修正 `totalWiresWithKValue` 重复计数，正确值为 5460。全量 PowerShell 复跑超过 120 秒，本轮未宣称重新生成全部 JSON |
| 16 | C | FIX-1~4 作为修复历史保留；其 9866 实例旧结论继续服从 20 号更正 |
| 17 | C | 方案 B 和 DEV 粒度方案 C 已实现；缓存版本更新为 `geometry-cache-v2-stretched-body`，Worker/SQLite 几何表仍未实现 |
| 18a | C | 共享 Geometry 实验记录保留；属于历史实测，不外推为所有设备几何正确 |
| 18b | C | 层级树/DEV SUBDEVICE 演进记录保留；当前 parser 版本仍为 v14 |
| 18c | C | §2-§9 标记为 MOD/STL 文件粒度 v1 历史方案；§10 DEV 粒度 v2 是当前方案，运行时验收仍未完成 |
| 19a | B | F2/F3/F4 层级统计对应未变化的变电样本；属于单样本结构事实 |
| 20 | B+C | PARTINDEX 是 SUBDEVICE 语义别名、不能作为第二几何 seed 的更正继续作为当前基线 |
| `cbm/dev/fam/mod/phm.md` | B | 格式说明继续作为三样本归纳，不提升为完整 GIM 标准；修正 `project.cbm` 对地理坐标的过度概括 |
| `sch/std/sld.md` | B+C | 当前仅变电样本各 1 份、线路样本为 0；但三者 parser、索引、缓存恢复和 SLD 视图/联动均已实现，并非“仅有格式说明”。SLD 安全化仍是独立风险 |

## 5. 本轮修正的错误或过时状态

1. `demo-line` 的 GIM header 明确为“500千伏喜苏II线”；其 FAM 同时出现 AC220kV/AC500kV 设备属性。原文把整个工程归为 220kV、并用电压等级解释 MOD 分布差异，证据不足，已更正。
2. 线路 MOD parser 不是“待实施”：`src/gim/geometry/lineModParser.ts` 已存在；真正未完成的是运行时接入和几何消费。
3. 变电 MOD 不是“全部未渲染”：XML parser 已覆盖 14 类 primitive，渲染器支持 6 类基础体和 StretchedBody；4 类复杂体与 3 类弱 schema primitive 主动跳过。
4. 13 号文档中的“当前缺陷”是 IR 设计时快照，已明确改为历史基线。
5. 14 号文档“悬链线未实现/直线默认”与代码不符；当前实验实现默认开启，但未使用 MATRIX0 挂点偏移/BLHA 高程差，hit-test 仍按直线，且 `KVALUE × L²` 语义未确认。
6. 15 号证据把一个 WIRE 的 KVALUE 错写成 P0/P1 各计一次；脚本也把数值计数重复相加。脚本、JSON 和文档均改为 5460。
7. 17/18c 仍把 GLB 方案 C 或 `geometry-cache-v1` 写成当前状态；已改为 DEV 粒度 v2 和 `geometry-cache-v2-stretched-body`，并保留 v1 为历史记录。
8. 17 号文档把 `46250 / 4135` 同时写成“约 5”和“约 11.2”；已统一为约 11.2 Entity/非空 MOD。

## 6. 仍然有效的风险边界

- 当前只有 2 个线路样本和 1 个变电样本，任何“100%”只代表登记样本，不等同于 GIM 标准强约束。
- 线路 MOD parser 尚未接入运行时；grammar 正确不代表线路杆塔、金具和跨越点已经可视化。
- 悬链线的 KVALUE 物理含义、单位和工程公式仍未确认；当前曲线只能视为视觉实验。
- 变电 7 类未支持 primitive 会被跳过，仍可能造成设备缺件。
- DEV 粒度 GLB 缓存尚缺真实运行时验收，编译通过不能替代首次生成、二次命中、位置一致性和版本失效验证。
- SQLite `geometry_cache` 表、XML parser Worker 化和 InstancedMesh 装配仍未实现；它们是长期性能路线，不应与已落地的 mergeGeometries/DEV GLB 缓存混为一谈。
- SCH/STD/SLD 只在当前唯一变电样本出现。实现已落地，但格式普适性和线路工程是否永远不含三件套仍缺跨样本证据。
- 03-07、09、15、19、20 的大规模关系统计本轮没有全部重算；它们的证据边界是“样本哈希未变化 + 现有生成物仍对应相同样本 + 针对性复核”，不应标成 2026-07-17 全量复跑。

## 7. 评审追加项复核

| 评审项 | 结论 | 处理 |
|---|---|---|
| 悬链线语义与 M5 决策 | **仍存在，但原表述需修正**：BLHA、MATRIX0 x/z 已确认；KVALUE 物理含义/公式、MATRIX0 y、WIRETYPE 来源仍未确认。代码已有默认开启的实验曲线，待定的是产品定位和工程语义，不是“有没有实现” | 更新 14/15、gim_line、dev-log；评审继续保留 P1 |
| SQLite geometry_cache / Worker / InstancedMesh | **仍存在**：源码中无对应实现；mergeGeometries 和 DEV 粒度 GLB 已落地，不能重复记为待实施 | 作为长期性能项写入评审，不列为当前发布阻断 |
| 行优先/列主序注释 | **原问题已基本解决，本轮收口**：dev.md/phm.md/parser 已是列主序；09/16 仍保留过期待办，viewer helper 名称仍误导 | 更新 09/16，并将 helper 更名为 `columnMajorToMatrix4`；不再列入剩余问题 |
| CBM/DEV 矩阵跨样本验证 | **仍存在**：53.4% 与 87.8% 都只来自 demo-substation | 明确单样本边界，作为研究验证项保留 |
| SCH/STD/SLD 仅有格式说明 | **不存在**：parser、索引、缓存恢复、视图和联动均已实现；“仅变电存在”也只是当前样本事实 | 更新 sch/std/sld；评审不新增“未实现”，保留 SLD 安全 P0 与跨样本边界 |
