# 线路悬链线参数研究（M4 阶段沉淀）

> 本文档沉淀 M4-B1 / B2 / B3 / B3A / B3B / B3C 阶段的全部研究方法论、审计流程、样本证据与决策路径。
>
> - **demo-line 全量静态分析证据与字段语义确认结论**已沉淀至 [15-wire-catenary-evidence.md](15-wire-catenary-evidence.md)
> - **已证实的结论**已归纳至 [../gim_line.md](../gim_line.md) §11 WIRE 拓扑分类与悬链线候选字段
> - **仍待决策的暂缓项**已归纳至 [../dev-log.md](../dev-log.md) §8 M4 悬链线暂缓项
> - 本文档聚焦研究方法、审计服务 API 与决策路径，不重复结论性事实
>
> 与 [13-geometry-ir-schema.md](13-geometry-ir-schema.md) 的边界：13号文档定义几何 IR 的统一 schema（含 `line-text-mod` kind），14号文档聚焦线路 WIRE 节点悬链线候选字段的研究方法与待核验问题，两者互不重叠。

> **2026-07-17 当前状态**：样本研究和“工程语义未确认”的结论仍有效，但代码已存在默认启用的实验性示意悬链线（`ENABLE_CATENARY=true`）。当前实现以 `KVALUE × L²` 或 `3% × L` 估算弧垂，在屏幕 Y 方向下移，未使用 MATRIX0 挂点偏移/BLHA 高程差，且 hit-test 仍按直线弦段计算。它不满足本文“默认禁用、直线段为默认”和“不要把未确认语义写死”的建议，应视为待收口的实验实现，而非工程语义悬链线。

---

## 1. 研究背景与目标

### 1.1 阶段总览

M4 围绕"线路导线几何与悬链线候选字段"展开递进式审计：

| 阶段 | 主题 | 产出 |
|---|---|---|
| M4-B1 | 线路几何与导线语义审计 | 字段清单 / 悬链线候选字段 / 缺口与 B2 建议 |
| M4-B2 | 导线属性增强 + 样式分层 | WireSemanticInfo / 属性面板 / 档距近似 / hit-test |
| M4-B3 | 悬链线参数语义验证 | 字段覆盖率 / 样本分布 / 语义假设 / 阻塞问题 |
| M4-B3A | 用户核验导出包 | Ctrl+Shift+C 导出 payload + Markdown 摘要 |
| M4-B3B | 档距聚合与 MATRIX0 平移分量验证 | spanKey 规则 / MATRIX0 解析 / 一档多线统计 |
| M4-B3C | WIRE 拓扑分类收口 | same-point / inter-point / missing-endpoint 分类 + 决策 |

### 1.2 MVP 范围与边界

> **范围调整**（2026-07-11）：原 M4 阶段将悬链线、3D 线路、MOD 解析标注为"不实现"。经用户确认，悬链线渲染和线路 MOD 解析纳入 MVP 范围，需要研究补充并实施。以下保留原 M4 阶段的历史记录，新增 MVP 实施标注。

**原 M4 不实现（历史记录）**：

- ~~悬链线渲染、弧垂计算~~ → **MVP 范围内，需研究补充并实施**
- ~~真实 3D 线路、MOD 解析~~ → **MVP 范围内，需研究补充并实施**
- SQLite schema 扩展、GIM 解析改动
- 底图扩展、坐标转换（GCJ-02 等）
- 将未确认字段语义写死进渲染逻辑

**MVP 实现状态（2026-07-17 更新）**：

- 悬链线渲染：已有默认开启的 2D 实验实现，但未满足本文语义和交互边界，仍待修正/验收
- 线路 MOD 解析：四类文本格式族 parser 已实现并有单测，尚未接入运行时渲染
- 3D 线路渲染：尚未实现

**M4 保留（已实施）**：

- 直线段导线渲染（按 WIRETYPE 着色）
- Ctrl+Shift+C 审计导出（作为后续研究工具）
- 所有审计服务代码（纯内存、不影响渲染）

### 1.3 研究目标

回答以下问题，为后续 M5 或专项任务保留依据：

1. 一个档距内有多少 WIRE？规律如何？
2. 如何按 wireType / SPLIT / KVALUE / MATRIX0 分组？
3. MATRIX0 的 x/y/z 是否解释相位 / 分裂 / 高度？
4. BLHA 是档距端点还是挂点？
5. KVALUE 是否存在分布规律？
6. same-point 与 inter-point 在悬链线候选上是否需要分离？

---

## 2. WIRE 节点字段审计

### 2.1 已解析字段清单

| 字段 | 来源 | 当前用途 | 是否入库 | 后续价值 |
|---|---|---|---|---|
| `BLHA` | TOWER/CROSS F4 rawProps | 塔位/跨越点坐标 | ✅ raw_props_json | 高程可用于 3D 弧垂 |
| `POINT0.BLHA` | WIRE rawProps | 导线起点坐标 | ✅ raw_props_json | 悬链线起点 |
| `POINT1.BLHA` | WIRE rawProps | 导线终点坐标 | ✅ raw_props_json | 悬链线终点 |
| `WIRETYPE` | WIRE / F4(WIRE) rawProps | 导线类型分类 | ✅ raw_props_json | 类型样式分层 |
| `KVALUE` | WIRE rawProps | 属性面板高亮显示 | ✅ raw_props_json | **悬链线张力参数候选** |
| `SPLIT` | WIRE rawProps | 属性面板高亮显示 | ✅ raw_props_json | **分裂导线渲染候选** |
| `POINT0.MATRIX0` | WIRE rawProps | 属性面板高亮显示 | ✅ raw_props_json | **悬链线参数候选（语义待确认）** |
| `POINT1.MATRIX0` | WIRE rawProps | 属性面板高亮显示 | ✅ raw_props_json | **悬链线参数候选（语义待确认）** |
| `BACKSTRING` | WIRE rawProps | 端点兜底反查塔位 | ✅ raw_props_json | 起止塔关联展示 |
| `FRONTSTRING` | WIRE rawProps | 端点兜底反查塔位 | ✅ raw_props_json | 起止塔关联展示 |
| `TRANSFORMMATRIX` | 所有节点 rawProps | 属性面板展示 | ✅ raw_props_json | 节点变换（导线几何用） |
| `GROUPTYPE` | F4System rawProps | 节点类型分流 | ✅ raw_props_json | 已使用 |
| `STRING<i>.GPOINT` | TOWER F4 rawRefs | 挂点名（如"前导6"） | ✅ line_cbm_ref (rawRefs) | 相别/挂点信息 |
| `N0` / `TOWERNO` 等 | FAM 属性 | 杆塔编号 | ✅ line_fam_property | 已使用 |
| `TOWERTYPE` 等 | FAM 属性 | 塔型 | ✅ line_fam_property | 已使用 |
| `TOWERHEIGHT` 等 | FAM 属性 | 呼高 | ✅ line_fam_property | 已使用 |
| `TURNANGLE` 等 | FAM 属性 | 转角 | ✅ line_fam_property | 已使用 |
| `DEVICETYPE` | DEV 属性 | 塔型兜底（耐张/直线） | ✅ line_dev_property | 已使用 |

> **关键结论**：所有 rawProps 均已序列化为 JSON 入库（`line_cbm_node.raw_props_json`），数据齐备，缺的只是"提取 + 使用"环节。

### 2.2 悬链线相关候选字段

#### KVALUE

- **位置**：WIRE 节点 `rawProps.KVALUE`
- **当前用途**：属性面板高亮显示
- **推测语义**：张力系数 / 弧垂参数候选
- **覆盖度**：审计服务可输出 `KVALUE 出现 N/M 次`
- **风险**：未在 GIM 标准文档中确认语义，需 M4-B2 人工核验样本值
- **静态分析结论**（demo-line 全量）：见 [15-wire-catenary-evidence.md](15-wire-catenary-evidence.md) §2 — 已确认为数值类型参数字段（覆盖率 100%，零值占 55%），具体物理含义与公式仍待决策

#### SPLIT

- **位置**：WIRE 节点 `rawProps.SPLIT`
- **当前用途**：属性面板高亮显示 + 样式加粗（SPLIT>1 时线宽 2.5px）
- **推测语义**：分裂导线数（如 4 分裂、6 分裂、8 分裂）
- **用途**：M4-B2 可做分裂导线渲染（同一档距画 N 条平行线）

#### POINT0 / POINT1

- **位置**：WIRE 节点 `rawProps.POINT0.BLHA` / `POINT1.BLHA`
- **当前用途**：导线端点坐标（已使用）
- **悬链线用途**：悬链线起点 / 终点
- **覆盖度**：审计服务可输出 `hasPoint0Blha` / `hasPoint1Blha` 命中率

#### MATRIX0

- **位置**：WIRE 节点 `rawProps.POINT0.MATRIX0` / `POINT1.MATRIX0`
- **当前用途**：属性面板高亮显示（注释标记"悬链线计算用"）
- **推测语义**：端点变换矩阵（可能是挂点高度偏移 / 绝缘子串长度）
- **风险**：未确认具体语义，需 M4-B2 人工核验
- **静态分析结论**（demo-line 全量）：见 [15-wire-catenary-evidence.md](15-wire-catenary-evidence.md) §3 — 已确认 100% 为 4x4 矩阵，z=挂点高度（24-81m）、x=横担偏移（±16m）、单位米；y 分量与坐标系局部性仍待核验

#### BLHA 高程分量

- **位置**：TOWER F4 / WIRE 的 `BLHA` 第 3 段（`纬度,经度,高程,方位角`）
- **当前用途**：TowerMarker.elev，tooltip 展示
- **悬链线用途**：两端高程差影响弧垂曲线
- **覆盖度**：BLHA 已解析，elev 字段已存在
- **静态分析结论**（demo-line 全量）：见 [15-wire-catenary-evidence.md](15-wire-catenary-evidence.md) §4 — 已确认 BLHA 为塔位中心坐标（interPoint + samePoint 端点 100% 命中 TOWER），挂点偏移由 MATRIX0 提供

#### 其他候选字段

| 字段 | 推测语义 | 当前状态 |
|---|---|---|
| `ISJUMPER` | 跳线标志 | 已用于虚线样式 |
| `MATERIALSHEET` | 材料表 | 未解析 |
| `TRANSFORMMATRIX` | 节点变换矩阵 | 已入库未用于几何 |

### 2.3 当前缺口

#### 字段缺失

- **电压等级**：未在 F1/F2/F3 rawProps 中显式提取（数据可能在 `raw_props_json`，但未结构化）
- **回路号**：未识别字段
- **相别**：`STRING<i>.GPOINT` 已捕获到 rawRefs，但未结构化解析
- **导线型号**：未识别字段（可能在 FAM 属性或 WIRE rawProps）
- **档距**：未计算（可由两端 BLHA 反算，M4-B2 已补 Haversine 近似）
- **弧垂**：未计算（依赖 KVALUE/SPLIT 语义确认）

#### 字段未解析

- `POINT0.MATRIX0` / `POINT1.MATRIX0` 已在 rawProps 但语义未确认
- `STRING<i>.GPOINT` 已捕获但未结构化为"相别 / 挂点序号"
- `TRANSFORMMATRIX` 已入库但未用于几何变换

#### 字段无法确认含义

- `KVALUE`：可能是张力系数、弧垂系数、应力，需对照 GIM 标准文档或样本工程人工核验
- `SPLIT`：可能是分裂导线数，但未确认是否为数值字段（实际样本取值 1 / 4）
- `MATRIX0`：可能是 4x4 变换矩阵的某一行的逗号分隔值，语义未确认

---

## 3. 档距聚合与拓扑分类

### 3.1 档距聚合必要性

#### 现象

实际线路样本中，多个 WIRE 节点共享同一对 `POINT0.BLHA + POINT1.BLHA`：

- 同一档距内可能包含：导线（CONDUCTOR）+ 地线（GROUNDWIRE）+ OPGW
- 同一导线类型可能因分裂导线（SPLIT=4）产生 4 条独立 WIRE 记录
- 跳线（ISJUMPER=1）可能跨档，但仍以两端 BLHA 标识

#### 必要性

- 若直接按 WIRE 节点渲染悬链线，会出现"一档多线"重叠
- 需要先按档距聚合，理解每档 WIRE 数的分布规律（固定值 vs 动态值）
- 才能决定 M4-B4 是按"固定档距结构"建模（每档复用同一弧垂参数组）还是按"动态档距结构"建模

#### 不做档距聚合的后果

- 弧垂参数张冠李戴（A 档的 KVALUE 用到 B 档）
- 渲染重叠（同档 4 分裂导线被画成 4 条悬链线）
- 无法对照样本工程核验 MATRIX0 平移分量的物理含义

### 3.2 spanKey 规则

#### 规则定义

```ts
function buildSpanKey(p0: string, p1: string): string {
  if (!p0 || !p1) return 'missing-endpoint';
  const a = p0.trim();
  const b = p1.trim();
  return a <= b ? `${a} -> ${b}` : `${b} -> ${a}`;
}
```

#### 设计要点

| 要点 | 说明 |
|---|---|
| 端点来源 | `POINT0.BLHA` + `POINT1.BLHA`（WIRE.rawProps） |
| 去方向 | `A -> B` 与 `B -> A` 视为同一档距（按字典序排序） |
| 缺失处理 | 任一端点缺失 → `'missing-endpoint'`（不参与样本统计） |
| 空白处理 | 去除两端空白，避免 `'1,2,3'` 与 `'1, 2, 3'` 产生不同 key |
| 不使用 | BACKSTRING / FRONTSTRING（保持本轮范围聚焦） |
| 保留原始 | 报告中 `point0Blha` / `point1Blha` 字段保留原始 BLHA 字符串 |

#### 局限性

- BLHA 第 4 段方位角差异不影响 spanKey（前 3 段相同即视为同档）
- 同塔不同挂点（横担）若 BLHA 相同，会被聚合到同一档距 → 需要 MATRIX0 区分挂点

### 3.3 MATRIX0 解析

#### 解析规则

```ts
function parseMatrixTranslation(matrix: string | null): MatrixTranslation
```

| 输入长度 | 解析方式 | likelyFormat |
|---|---|---|
| 16 | 4x4 矩阵，平移分量为 `values[12]` / `values[13]` / `values[14]` | `4x4-matrix` |
| 12 | 3x4 矩阵（行优先），平移分量为 `values[3]` / `values[7]` / `values[11]` | `3x4-matrix` |
| 9 / 6 / 4 / 3 / 1 | 不解析平移，仅记录长度与格式 | `3x3-matrix` / `6-tuple` / `quaternion` / `triplet` / `scalar` |

#### 分隔符

- 优先逗号（`,`），过滤空字符串
- 若按逗号分割后元素数 ≤ 1，回退空格分隔（`\s+`）

#### 输出字段

```ts
interface MatrixTranslation {
  x: number | null;     // 4x4: values[12]，疑似横担偏移
  y: number | null;     // 4x4: values[13]，疑似横担偏移
  z: number | null;     // 4x4: values[14]，疑似高度层级
  rawLength: number | null;
  likelyFormat: string;
}
```

#### 重要约束

- **不确认**单位（米？毫米？）
- **不确认**坐标系（局部？世界？相对塔位？）
- **仅称**"疑似平移分量"
- 实际样本显示为 16 元素 4x4 矩阵，平移在 `[12][13][14]`

#### 待用户核验

| 假设 | 验证方式 | 静态分析结论 |
|---|---|---|
| x/y 是横担偏移 | 对比同档不同 wireType 的 x/y 是否差异 | ✅ x 已确认（±16m，横担长度合理）；y 仍待核验（值很小） |
| z 是挂点高度 | 对比 CONDUCTOR vs OPGW 的 zRange 是否分层 | ✅ z 已确认（24-81m，与塔高吻合，单位米） |
| 单位为米 | 对比 zRange 量级与塔位 BLHA 高程差 | ✅ 已确认（米） |
| 坐标系为局部 | 对比同塔不同档距的 x/y 是否方向一致 | ⏳ 未做交叉验证（基于 BLHA=塔位中心推论疑似局部） |

> 全量静态分析证据见 [15-wire-catenary-evidence.md](15-wire-catenary-evidence.md) §3。

### 3.4 聚合统计项

#### 每个档距组（SpanGroupSample）的统计字段

| 字段 | 说明 |
|---|---|
| `spanKey` | `min(p0, p1) -> max(p0, p1)` |
| `groupKind` | 拓扑分类：`same-point` / `inter-point` / `missing-endpoint`（M4-B3C 新增） |
| `blhaDistanceMeters` | Haversine 距离（same-point=0，missing=null，inter=Haversine 近似）（M4-B3C 新增） |
| `point0Blha` / `point1Blha` | 原始 BLHA 字符串 |
| `wireCount` | 该档距 WIRE 数 |
| `wireTypeCounts` | 按导线类型计数（CONDUCTOR / GROUNDWIRE / OPGW / UNKNOWN） |
| `splitCounts` | 按 SPLIT 值计数 |
| `kValueStats` | min / max / zeroCount / nonZeroCount / distinctSampleValues（≤20） |
| `point0TranslationStats` | POINT0.MATRIX0 平移分量 x/y/z 的 min/max 范围 |
| `point1TranslationStats` | POINT1.MATRIX0 平移分量 x/y/z 的 min/max 范围 |
| `wireSamples` | 该档距的 WIRE 样本（≤20） |

#### 档距组大小统计（spanGroupSizeStats）

| 字段 | 说明 |
|---|---|
| `min` / `max` / `avg` | 每档 WIRE 数的最小 / 最大 / 平均值 |
| `topSizes` | WIRE 数 Top 5 档距（按 wireCount 降序） |

#### 拓扑分类统计（M4-B3C 新增）

| 字段 | 说明 |
|---|---|
| `groupKindCounts` | 按分类的组数（same-point / inter-point / missing-endpoint） |
| `groupKindWireCounts` | 按分类的 WIRE 总数 |
| `groupKindSizeStats` | 按分类的 min/max/avg/Top 档距 |
| `samePointGroupSamples` | same-point 样本（≤10） |
| `interPointSpanSamples` | inter-point 样本（≤10） |
| `missingEndpointGroupSamples` | missing-endpoint 样本（≤10） |

#### 样本上限

| 上限 | 值 |
|---|---|
| `MAX_SPAN_GROUP_SAMPLES` | 20（整体档距组样本数） |
| `MAX_WIRE_SAMPLES_PER_GROUP` | 20（每档内 WIRE 样本数） |
| `MAX_DISTINCT_KVALUES` | 20（distinct KVALUE 原始值样本） |
| per-kind samples | 10（每类拓扑分类样本数） |

### 3.5 WIRE 拓扑分类（M4-B3C）

#### 分类规则

实际线路样本显示 Top 档距组中存在大量 `POINT0.BLHA == POINT1.BLHA`，说明当前 `spanKey = POINT0.BLHA + POINT1.BLHA` 会把"同点内部连接"和"真实跨塔档距"混在一起。M4-B3C 新增拓扑分类：

| 分类 | 判定规则 | 说明 |
|---|---|---|
| `same-point` | POINT0.BLHA 归一化后等于 POINT1.BLHA | 同点内部连接候选（不应直接进入悬链线渲染） |
| `inter-point` | 两端 BLHA 不同 | 真实跨点档距候选（未来悬链线候选） |
| `missing-endpoint` | POINT0.BLHA 或 POINT1.BLHA 缺失 | 端点缺失 |

归一化规则：按逗号分割后逐段 trim 再 join（`'1, 2, 3'` → `'1,2,3'`）。

#### 距离计算

- `inter-point`：Haversine 近似（仅 lat/lng，不含高程，不引入坐标转换 / GCJ-02）
- `same-point`：返回 0
- `missing-endpoint`：返回 null
- 仅用于审计分类，不用于渲染

#### 观察项自动生成

M4-B3C 在 `observations` 中自动输出：

1. same-point group 占比（组数 / 百分比）
2. inter-point span 占比（组数 / 百分比）
3. 最大 same-point group 的 WIRE 数
4. 最大 inter-point span 的 WIRE 数
5. same-point 是否集中出现 KVALUE=0
6. inter-point 中 KVALUE 是否更像弧垂候选参数
7. MATRIX0 zRange 在 same-point / inter-point 中的表现差异（P0 / P1 分开）

### 3.6 观察 / 阻塞 / 建议自动生成规则

| 类型 | 自动生成条件 |
|---|---|
| 观察 | wireCount / spanGroupCount / minSize===maxSize / wireType 分布 / SPLIT 分布 / zRange 非零 / KVALUE=0 占多数 / OPGW vs CONDUCTOR 差异 |
| 阻塞问题 | spanGroupCount=0 / minSize!==maxSize / MATRIX0 坐标系未确认 / KVALUE=0 含义 / BLHA 是端点还是挂点 |
| 建议 | 每档固定 WIRE 数 → 固定档距结构 / 动态 → 动态结构 / z 非零 → 可作挂点高度 / BLHA+MATRIX0 假设 |

---

## 4. 审计服务 API

### 4.1 悬链线参数审计（M4-B3）

文件：`src/services/lineGeometryAuditService.ts`

```ts
export interface LineCatenaryParamAuditReport {
  wireCount: number;
  coverage: Record<string, {
    count: number;
    ratio: number;
    sampleValues: string[];
  }>;
  matrix0FormatSamples: Matrix0FormatSample[];
  kValueSamples: KValueSample[];
  splitSamples: SplitSample[];
  blhaElevationSamples: BlhaElevationSample[];
  semanticHypotheses: string[];
  blockingQuestions: string[];
  recommendations: string[];
}

export function buildLineCatenaryParamAuditReport(args: {
  graph: unknown;
  mapData: unknown;
}): LineCatenaryParamAuditReport;
```

#### 候选字段全覆盖清单

```ts
const CATENARY_CANDIDATE_FIELDS = [
  'KVALUE', 'SPLIT',
  'POINT0.BLHA', 'POINT1.BLHA',
  'POINT0.MATRIX0', 'POINT1.MATRIX0',
  'ISJUMPER', 'MATERIALSHEET', 'TRANSFORMMATRIX',
  'BACKSTRING', 'FRONTSTRING',
];
```

#### 样本上限

`MAX_CATENARY_SAMPLES = 20`（高于通用 MAX_SAMPLES，便于格式判断）。

#### 覆盖率判定规则

| 字段 | 统计方式 | 判定规则 |
|---|---|---|
| `KVALUE` | 遍历 WIRE 节点 rawProps，统计非空值 | ratio > 0.5 视为高覆盖 |
| `SPLIT` | 同上 | ratio > 0.5 视为高覆盖 |
| `POINT0.BLHA` | 同上 | ratio > 0.8 视为必备 |
| `POINT1.BLHA` | 同上 | ratio > 0.8 视为必备 |
| `POINT0.MATRIX0` | 同上 | ratio > 0.3 视为有参考价值 |
| `POINT1.MATRIX0` | 同上 | 同上 |
| `ISJUMPER` | 同上 | ratio > 0 视为可用 |
| `MATERIALSHEET` | 同上 | ratio > 0.3 视为有参考价值 |
| `TRANSFORMMATRIX` | 同上 | ratio > 0.3 视为有参考价值 |

#### 样本类型

```ts
interface KValueSample {
  path: string;
  wireType: string;       // CONDUCTOR / GROUNDWIRE / OPGW
  kValue: string | null;
  numericValue: number | null;  // parseFloat 结果
}

interface SplitSample {
  path: string;
  split: string | null;
  numericValue: number | null;
  isInteger: boolean;     // 是否为正整数
}

interface Matrix0FormatSample {
  path: string;
  point0Matrix0: string | null;
  point1Matrix0: string | null;
  parsedLength: number | null;  // 元素数量
  likelyFormat: string;        // 4x4-matrix / 3x4-matrix / triplet / scalar / unknown
}

interface BlhaElevationSample {
  path: string;
  point0Elevation: number | null;  // POINT0.BLHA 第 3 段
  point1Elevation: number | null;  // POINT1.BLHA 第 3 段
  elevationDelta: number | null;   // point1 - point0（米）
}
```

#### KVALUE 判定规则

- 若 `numericValue !== null` 且分布在合理区间（如 0.001 ~ 100），疑似为系数
- 若分布为大整数（如 10000+），疑似为编码或 ID
- 若完全无法 parseFloat，疑似为字符串编码

#### SPLIT 判定规则

- `isInteger === true` 且值在 {1, 2, 3, 4, 6, 8} 中，疑似为分裂导线数
- `isInteger === false`，需进一步核验

#### MATRIX0 格式推断规则（guessMatrix0Format）

| 元素数 | 推断格式 |
|---|---|
| 16 | 4x4-matrix |
| 12 | 3x4-matrix |
| 9 | 3x3-matrix |
| 6 | 6-tuple |
| 4 | quaternion |
| 3 | triplet |
| 1 | scalar |
| 其他 | unknown(N) |

分隔符识别：优先识别逗号分隔，回退空格分隔。

### 4.2 档距聚合审计（M4-B3B/B3C）

文件：`src/services/lineSpanGroupingAuditService.ts`

```ts
export function buildLineSpanGroupingAuditReport(args: {
  graph: unknown;
  mapData: unknown;
}): LineSpanGroupingAuditReport;
```

完整报告结构见 [../gim_line.md](../gim_line.md) §11 + §3.4 聚合统计项。

#### 关键内部函数

- `buildSpanKey(p0, p1)`：档距键构造（去方向）
- `classifySpanGroup(spanKey)`：拓扑分类判定
- `normalizeBlha(blha)`：BLHA 归一化（逗号分割 + trim + join）
- `parseMatrixTranslation(matrix)`：MATRIX0 平移分量解析（模块私有）

#### 调用约束

- 只读内存数据，不读 DB、不读 GIM 文件
- 不影响渲染、不修改 state
- 样本数量限制（避免报告体积爆炸）
- 入参使用 unknown 类型，由本服务内部进行类型收窄
- 字段含义全部以"疑似 / 候选 / 待确认"措辞，不写成结论

### 4.3 导线语义信息（M4-B2）

文件：`src/services/lineWireSemanticService.ts`

```ts
export interface WireSemanticInfo {
  wireType: string;           // CONDUCTOR / GROUNDWIRE / OPGW / UNKNOWN
  layerKey: string;           // conductor / groundwire / opgw / unknownWire
  isJumper: boolean;          // ISJUMPER 命中 1/true/TRUE/yes
  split: number | null;       // SPLIT 转数字
  kValue: string | null;
  point0Blha: string | null;
  point1Blha: string | null;
  point0Matrix0: string | null;
  point1Matrix0: string | null;
  backString: string | null;
  frontString: string | null;
  spanMeters: number | null;  // Haversine 档距近似（米）
  warnings: string[];
}

export function buildWireSemanticInfo(args: {
  wire: unknown;
  rawProps?: Record<string, string>;
}): WireSemanticInfo;
```

- 只读 wire + rawProps，不读 DB、不改 schema
- `spanMeters` 用 Haversine 公式（地球半径 6371000m），端点缺失返回 null + warning

### 4.4 审计导出服务（M4-B3A）

文件：`src/services/lineCatenaryAuditExportService.ts`

- `buildLineCatenaryAuditExportPayload()`：构建 JSON payload（含 `report` + `spanGroupingReport`）
- `formatLineCatenaryAuditMarkdown()`：Markdown 摘要（§1-§11）

#### 不修改的文件

- `src/gim/lineMapData.ts`（不改地图数据提取）
- `src/ui/lineMapView.ts`（不改渲染）
- `src/ui/lineProjectView.ts`（不改 UI；payload 通过 `buildLineCatenaryAuditExportPayload` 自动包含）
- `src/app/bootstrap.ts`（不改快捷键；Ctrl+Shift+C 自动包含新字段）
- `src-tauri/src/db.rs`（不改 schema）

---

## 5. 用户核验流程（M4-B3A）

### 5.1 导出方式

1. 打开线路 GIM 工程（仅线路工程有数据；变电工程 / 清空场景按 Ctrl+Shift+C 会提示无数据）
2. 等待地图渲染完成（OSM 底图加载或 Canvas fallback 均可）
3. 按 `Ctrl + Shift + C`
4. JSON 自动复制到剪贴板（含 `report` + `spanGroupingReport`）
5. Console 输出 Markdown 摘要（前 5 条样本，便于快速浏览）
6. 顶部 loading 显示 `悬链线参数审计 JSON 已复制`（约 2.5 秒）

#### 实现文件

- `src/services/lineCatenaryAuditExportService.ts`：`buildLineCatenaryAuditExportPayload()` + `formatLineCatenaryAuditMarkdown()`
- `src/ui/lineProjectView.ts`：`latestCatenaryAuditPayload` 模块级状态 + `getLatestCatenaryAuditPayload()` / `formatLatestCatenaryAuditMarkdown()` 导出
- `src/app/bootstrap.ts`：`Ctrl+Shift+C` 快捷键处理器（Tauri 模式）

#### 冲突说明

若与系统或 DevTools 的 Ctrl+Shift+C 冲突，可改为 Ctrl+Alt+C（需同步更新 `bootstrap.ts` 与 [../dev-log.md](../dev-log.md)）。

### 5.2 KVALUE 核验

检查 JSON 中 `report.coverage.KVALUE` 与 `report.kValueSamples`：

- 是否每条 WIRE 都有 KVALUE（看 `coverage.KVALUE.ratio`，> 0.5 视为高覆盖）
- KVALUE 是否为数值（看 `kValueSamples[].numericValue !== null` 占比）
- 数值范围是否像系数、张力、弧垂参数，还是编码（看 `numericValue` 量级）
- 不同导线类型 KVALUE 是否有明显差异（按 `wireType` 分组对比）

### 5.3 SPLIT 核验

检查 `report.coverage.SPLIT` 与 `report.splitSamples`：

- 是否为正整数（看 `splitSamples[].isInteger`）
- 是否落在常见分裂数：1 / 2 / 4 / 6 / 8（看 `numericValue` 分布）
- 是否与导线类型匹配（CONDUCTOR 常见 4 分裂 / 6 分裂；GROUNDWIRE 常见 1；OPGW 常见 1）

### 5.4 MATRIX0 核验

检查 `report.coverage.POINT0.MATRIX0` / `POINT1.MATRIX0` 与 `report.matrix0FormatSamples`：

- 元素数量是 16 / 12 / 9 / 6 / 4 / 3 / 1（看 `parsedLength`）
- 推断格式是否一致（看 `likelyFormat`，是否全部为 `4x4-matrix` 或 `triplet`）
- 是否像变换矩阵（4x4 矩阵末行常为 `0,0,0,1`）
- 是否包含平移量（前 3 行第 4 列）
- 单位疑似米还是毫米（看数值量级）

### 5.5 BLHA 高程核验

检查 `report.coverage.POINT0.BLHA` / `POINT1.BLHA` 与 `report.blhaElevationSamples`：

- 第 3 段是否稳定表现为高程（看 `point0Elevation` / `point1Elevation` 非 null 比例）
- 两端高差是否合理（看 `elevationDelta`，应在合理范围如 ±50m）
- 是否与塔位高程或地形高程相符

### 5.6 档距聚合核验

检查 `spanGroupingReport.spanGroupSizeStats`：

- **每档 WIRE 数是否固定**：看 `min === max`
  - 固定 → 疑似结构化分裂导线 + 地线 + OPGW 共档
  - 不固定 → 疑似转角塔 / 分支塔 / 跳线档差异
- **avg 是否接近整数**：avg ≈ 12 / 16 / 24 → 疑似标准塔型结构
- **Top 5 是否包含特殊档距**：高 WIRE 数档距可能为变电站进出线段

### 5.7 MATRIX0 平移分量核验

检查 `spanGroupingReport.spanGroupSamples[].point0TranslationStats` / `point1TranslationStats`：

- **zRange 是否非零**：非零 → 疑似挂点高度层级
- **zRange 是否分层**：同档 CONDUCTOR vs OPGW 的 zRange 是否明显不同
- **x/y 是否体现横担偏移**：xRange / yRange 是否在合理范围（±10m）
- **P0 与 P1 的 zRange 是否对称**：若相同 → 同塔挂点高度一致；若不同 → 跨档挂点差异

### 5.8 KVALUE 分布核验

检查 `spanGroupingReport.spanGroupSamples[].kValueStats`：

- **KVALUE=0 是否集中**：`zeroCount > nonZeroCount` → 部分档距未启用弧垂参数
- **KVALUE 非 0 是否占多数**：`nonZeroCount > zeroCount` → 疑似为张力/弧垂相关参数
- **distinctSampleValues 是否有限**：值域窄 → 离散参数；值域宽 → 连续参数
- **KVALUE 与 wireType 关系**：CONDUCTOR 的 KVALUE 是否明显不同于 OPGW

### 5.9 BLHA 端点核验

检查 `spanGroupingReport.spanGroupSamples[].point0Blha` / `point1Blha`：

- **第 1/2 段（经纬度）是否为塔位中心**：同塔不同挂点 BLHA 是否相同
- **第 3 段（高程）是否为塔位高程**：与塔位 FAM 属性的 towerHeight 是否一致
- **第 4 段（方位角）是否为档距方向**：与前后档方位角是否连续

### 5.10 拓扑分类核验（M4-B3C）

检查 `spanGroupingReport.groupKindCounts` 与三类 samples：

- **same-point 占比**：是否包含大量同点内部连接
- **inter-point 跨点档距样本**：前 5 档距的 distance / wireTypes / SPLIT / P0/P1 zRange / KVALUE 0/非0 占比
- **观察项**：`spanGroupingReport.observations` 自动输出 same-point/inter-point 占比与差异

### 5.11 核验结论模板

完成核验后，建议填写以下结论模板：

```text
KVALUE：确认 / 未确认 / 不使用
  - 含义：_______________
  - 单位：_______________
SPLIT：确认 / 未确认 / 不使用
  - 含义：_______________
MATRIX0：确认 / 未确认 / 不使用
  - 含义：_______________
  - 坐标系：_______________
  - 单位：_______________
BLHA 高程：确认 / 未确认 / 不使用
  - 含义：纬度,经度,高程,方位角（已确认）

档距聚合：
  - 每档 WIRE 数：固定 N / 不固定（min=N1, max=N2）
  - 结构：固定档距结构 / 动态档距结构

MATRIX0 平移分量：
  - x/y：横担偏移 / 其他（_______________）
  - z：挂点高度 / 其他（_______________）
  - 单位：米 / 毫米 / 其他（_______________）
  - 坐标系：局部 / 世界 / 相对塔位

BLHA：
  - 含义：塔位中心 / 挂点 / 其他（_______________）
  - 第 3 段：塔位高程 / 挂点高程 / 其他（_______________）

KVALUE：
  - 0 值含义：未启用 / 直线塔 / 其他（_______________）
  - 非 0 值含义：张力系数 / 弧垂参数 / 其他（_______________）

M4-B4 / M5 路线决策：
  - 示意悬链线 / 工程语义悬链线 / 暂缓
  - 理由：_______________
```

---

## 6. 决策与后续路线

### 6.1 M4 阶段决策（历史记录）

#### M4 当时不实现的内容

- **不实现悬链线渲染**
- **不实现 3D 线路**
- **不解析 MOD**
- **不实现弧垂计算**

#### M4 保留的内容

- 当前导线仍用**直线段**显示
- 保留 **Ctrl+Shift+C 审计导出**（作为后续研究工具）
- 保留所有审计服务代码（纯内存，不影响渲染）
- 保留 spanGroupingReport 字段（向后兼容）

#### 决策理由

> 静态分析证据见 [15-wire-catenary-evidence.md](15-wire-catenary-evidence.md)，以下状态基于该文档已更新。

1. ~~**inter-point 规律未稳定**~~ → ✅ 已解除：samePoint / interPoint 已分离，interPoint 档距长度合理（avg 425m，max 731m）
2. **MATRIX0 语义部分确认**：z=挂点高度、x=横担偏移、单位米已确认；坐标系局部性 + y 分量仍待核验
3. **KVALUE 物理含义未确认**：已确认是数值参数字段（零值占 55%），但具体公式与 0 值精确语义仍待决策
4. ~~**BLHA 是塔位还是挂点未确认**~~ → ✅ 已解除：BLHA 为塔位中心（端点 100% 命中 TOWER）
5. **MVP 边界约束**：不做 3D 线路、不解析 MOD、不改 schema

### 6.2 进入 M4-B4 / M5 的前置条件

| 条件 | 验证方式 | 静态分析状态 |
|---|---|---|
| 每档 WIRE 数规律已理解 | `spanGroupSizeStats.min === max` 或差异原因已识别 | ✅ 已理解（不固定，因转角塔/分支塔/跳线档差异，min=5/max=31/avg≈8.39） |
| MATRIX0 平移分量单位已确认 | 用户对照样本工程核验 | ✅ 已确认（米） |
| MATRIX0 坐标系局部性已确认 | 同塔不同档距的 x/y 方向一致性 | ⏳ 未做交叉验证（疑似局部） |
| MATRIX0 y 分量语义已确认 | 对比同档不同 wireType 的 y 分布 | ⏳ 未确认（值很小，可忽略） |
| BLHA 是塔位还是挂点已确认 | 用户对照样本工程核验 | ✅ 已确认（塔位中心） |
| KVALUE=0 含义已确认 | 用户对照样本工程核验 | ⏳ 待决策（疑似"未启用弧垂"或"跳线"） |
| KVALUE 公式已确认 | 对照 GIM 标准或反推经验公式 | ❌ 未确认 |
| OPGW vs CONDUCTOR 差异已识别 | `wireTypeCounts` 对照样本 | ❌ 未识别（demo-line WIRETYPE 全为 UNKNOWN） |

> 静态分析状态详见 [15-wire-catenary-evidence.md](15-wire-catenary-evidence.md) §6.3。

### 6.3 M4-B4 路线分支（决策树）

| 核验结论 | M4-B4 / M5 路线 |
|---|---|
| BLHA=塔位 + MATRIX0=挂点偏移 + KVALUE=张力 | **工程语义悬链线**（按 MATRIX0 平移分量计算挂点位置，按 KVALUE 计算弧垂） |
| BLHA=塔位 + MATRIX0=未确认 + KVALUE=未确认 | **示意悬链线**（按 BLHA 高程差 + 经验弧垂参数绘制） |
| BLHA=挂点 + MATRIX0=未确认 | **示意悬链线**（直接用 BLHA 作端点） |
| 全部未确认 | **暂缓**（继续预研或放弃悬链线） |

### 6.4 不进入 M4-B4 / M5 的情况

- 每档 WIRE 数完全无规律（min/max 差异极大且无原因）
- MATRIX0 平移分量全部为 0 或缺失
- 用户核验结论为"无法确认"
- 已实现"示意悬链线"满足业务需求
- 业务方明确不再需要悬链线

### 6.5 后续可能路线（M5 预研，不承诺实现）

> 后续若需要真实导线几何，应另起 M5 或专项任务。以下为可能的 M5 子任务（均为预研）。

| 子任务 | 说明 | 前置条件 |
|---|---|---|
| M5-A：真实跨点档距识别 | 基于 inter-point 分类，识别真实跨塔档距 | M4-B3C 完成（已完成） |
| M5-B：MATRIX0 挂点坐标确认 | 用户对照样本工程核验 MATRIX0 单位与坐标系 | 用户核验 |
| M5-C：KVALUE 物理含义确认 | 用户对照样本工程核验 KVALUE=0 与非 0 含义 | 用户核验 |
| M5-D：示意悬链线 feature flag | 基于经验弧垂参数绘制示意悬链线（不依赖 KVALUE） | M5-A 完成 |
| M5-E：工程语义悬链线 | 基于 MATRIX0 + KVALUE 实现工程语义悬链线 | M5-A/B/C 全部完成 |

### 6.6 建议的悬链线实现策略

> **实现偏差（2026-07-17）**：以下仍是本研究的建议边界。当前 `ENABLE_CATENARY=true`，并使用未经物理语义确认的 `KVALUE × L²`，与“默认禁用”和“仅示意、不写死未确认参数”的建议不一致。

#### 先做"示意悬链线"还是"工程语义悬链线"

**建议先做"示意悬链线"**：

- 基于 KVALUE + BLHA 高程差，假设公式 `f(x) = k * x * (L - x)`（抛物线近似）
- 不依赖 KVALUE 物理含义的确认，仅作为视觉增强
- 通过 feature flag 控制，默认禁用，保持直线段为默认

**不建议直接做"工程语义悬链线"**：

- KVALUE 物理含义未确认，可能产生误导
- 若 KVALUE 实际为张力系数，需结合档距、温度、导线参数等计算真实弧垂

#### 是否需要更多样本

- 当前每类最多 20 条样本，若 GIM 标准文档无字段定义，需收集 2-3 个不同电压等级 / 不同塔型的样本工程
- 重点关注：KVALUE 在不同塔型下的分布、MATRIX0 格式一致性

#### 是否需要用户人工确认字段含义

**建议是**：

- 在 M4-B3 报告输出后由用户对照样本工程确认 KVALUE/SPLIT/MATRIX0 含义
- 用户确认后才能进入"工程语义悬链线"实现

#### 是否继续保持直线段作为默认

**建议是**：

- 悬链线作为可选增强（feature flag 控制）
- 默认保持直线段，避免未经确认的参数引入误导

---

## 7. 边界与约束

- **不破坏 OSM baseline**：本轮纯内存审计，不触及底图
- **不破坏导线交互**：不改 hit-test / 选中态 / 样式分层
- **不改 schema**：所有数据来源于 WIRE.rawProps（已序列化为 `raw_props_json`）
- **不确认 MATRIX0 为真实坐标**：仅称"疑似平移分量"
- **不把 same-point 当成真实跨塔档距**：M4-B3C 已分离
- **历史约束**：M4-B3C 当时收口为不进入 M4-B4；此后范围已调整，当前已有待验收的实验实现

---

## 8. 审计工具保留

| 工具 | 快捷键 | 用途 | 保留状态 |
|---|---|---|---|
| 数据库诊断 | Ctrl+Shift+D | 工程类型 / 缓存状态 / 底图状态 | ✅ 保留 |
| 悬链线参数审计 | Ctrl+Shift+C | WIRE 字段覆盖率 / KVALUE / SPLIT / MATRIX0 / BLHA / 档距聚合 / 拓扑分类 | ✅ 保留（作为后续研究工具） |

### 8.1 Ctrl+Shift+C JSON payload 结构

```json
{
  "generatedAt": "...",
  "parserVersion": "...",
  "projectSummary": { ... },
  "report": {
    "wireCount": 5460,
    "coverage": { ... },
    "matrix0FormatSamples": [ ... ],
    "kValueSamples": [ ... ],
    "splitSamples": [ ... ],
    "blhaElevationSamples": [ ... ],
    "semanticHypotheses": [ ... ],
    "blockingQuestions": [ ... ],
    "recommendations": [ ... ]
  },
  "spanGroupingReport": {
    "wireCount": 5460,
    "spanGroupCount": 651,
    "spanGroupSizeStats": { "min": 5, "max": 31, "avg": 8.39, "topSizes": [ ... ] },
    "groupKindCounts": { "same-point": ..., "inter-point": ..., "missing-endpoint": ... },
    "groupKindWireCounts": { ... },
    "groupKindSizeStats": { ... },
    "spanGroupSamples": [ ... ],
    "samePointGroupSamples": [ ... ],
    "interPointSpanSamples": [ ... ],
    "missingEndpointGroupSamples": [ ... ],
    "observations": [ ... ],
    "blockingQuestions": [ ... ],
    "recommendations": [ ... ]
  }
}
```

### 8.2 Markdown 摘要章节

| 章节 | 内容 |
|---|---|
| §1-§9 | M4-B3 覆盖率 / KVALUE / SPLIT / MATRIX0 / BLHA / 语义假设 / 阻塞 / 建议 |
| §10 | 档距聚合摘要 + WIRE 拓扑分类（M4-B3C：same-point / inter-point / missing-endpoint group 数与 WIRE 数表） |
| §11 | inter-point 跨点档距样本（M4-B3C，前 5 档距的 distance / wireTypes / SPLIT / P0/P1 zRange / KVALUE 0/非0 占比 + 观察 + 阻塞 + 收口建议） |

### 8.3 兼容性

- **OSM fallback 兼容**：fallback 后仍可调用，因为 payload 在 `renderLineProjectPanels` 阶段已构建，与底图模式无关
- **向后兼容**：`spanGroupingReport` 为可选字段，旧 payload 无此字段时调用方需判空
- **M4-B3C 历史收口**：当时悬链线不进入 MVP、线路地图使用直线段。该决策后续已调整；2026-07-17 代码存在默认开启的实验性曲线，Ctrl+Shift+C 仍作为审计和后续研究工具
