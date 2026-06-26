# M4-B3 悬链线参数语义验证

> 阶段：审计与预研。本轮**不实现悬链线渲染、不实现弧垂计算、不改 SQLite schema**。
>
> 目标：验证悬链线候选字段语义，为后续 M4-B4 是否实现悬链线提供依据。

---

## 1. 目标与边界

### 目标

对线路 GIM 中与悬链线计算相关的字段做：
- 字段抽样
- 覆盖率统计
- 格式判断
- 语义假设
- 验证建议
- 文档输出

### 边界（强制）

- **不实现**悬链线计算
- **不实现**悬链线绘制
- **不做**真实 3D 线路
- **不改** SQLite schema
- **不把**未经确认的字段语义写死进渲染逻辑
- 输出可供 M4-B4 决策的证据

---

## 2. 候选字段清单

| 字段 | 来源 | 当前用途 | 候选语义 | 风险 |
|---|---|---|---|---|
| `KVALUE` | WIRE.rawProps | M4-B2 属性面板展示 | 疑似张力 / 弧垂相关参数 | 物理含义未确认，单位未知 |
| `SPLIT` | WIRE.rawProps | M4-B2 样式加粗 + 属性面板 | 疑似分裂导线数 | 需验证是否为正整数 |
| `POINT0.BLHA` | WIRE.rawProps | M4-B2 端点坐标 + 档距 | 起点经纬度高程方位角 | 已确认格式，高程可解析 |
| `POINT1.BLHA` | WIRE.rawProps | M4-B2 端点坐标 + 档距 | 终点经纬度高程方位角 | 已确认格式，高程可解析 |
| `POINT0.MATRIX0` | WIRE.rawProps | M4-B2 属性面板展示 | 疑似挂点局部变换矩阵 | 坐标系与单位未确认 |
| `POINT1.MATRIX0` | WIRE.rawProps | M4-B2 属性面板展示 | 疑似挂点局部变换矩阵 | 坐标系与单位未确认 |
| `ISJUMPER` | WIRE.rawProps | M4-B2 虚线样式 | 疑似跳线标识 | 跳线可能不需要悬链线 |
| `MATERIALSHEET` | WIRE.rawProps | 仅审计采样 | 疑似导线材料表 | 是否参与弧垂计算未确认 |
| `TRANSFORMMATRIX` | WIRE.rawProps | 仅审计采样 | 疑似节点整体变换矩阵 | 与 POINT0/1.MATRIX0 关系待确认 |
| `BACKSTRING` | WIRE.rawProps | M4-B2 端点兜底引用 | 后侧字符串引用（已使用） | 已确认含义 |
| `FRONTSTRING` | WIRE.rawProps | M4-B2 端点兜底引用 | 前侧字符串引用（已使用） | 已确认含义 |
| `STRING<i>.GPOINT` | STRING 子节点 rawProps | 未解析 | 疑似挂点几何参数 | 完全未解析，需 M4-B4 评估 |
| BLHA 高程分量 | POINT0/1.BLHA 第 3 段 | M4-B2 档距计算 | 起终点高差参与弧垂计算 | 已确认可解析为数值 |

---

## 3. 覆盖率统计

> 以下统计由 `buildLineCatenaryParamAuditReport()` 在运行时计算，本节为字段清单与判定规则。

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

**摘要输出**：在 `lineProjectView.renderLineProjectPanels` 完成地图数据提取后，通过 `debugLog(DEBUG_LINE_MAP, '[M4-B3] catenary param audit summary', ...)` 输出精简摘要：

```ts
{
  wireCount: number;
  coverage: Record<string, { count: number; ratio: number }>;
  blockingQuestionCount: number;
}
```

完整报告（含样本值）通过 `buildLineCatenaryParamAuditReport()` 调用获取，**默认不输出到 Ctrl+Shift+D 诊断**，避免 JSON 体积过大。

---

## 4. 样本值分析

### 4.1 KVALUE 数字分布

```ts
interface KValueSample {
  path: string;
  wireType: string;       // CONDUCTOR / GROUNDWIRE / OPGW
  kValue: string | null;
  numericValue: number | null;  // parseFloat 结果
}
```

**判定规则**：
- 若 `numericValue !== null` 且分布在合理区间（如 0.001 ~ 100），疑似为系数
- 若分布为大整数（如 10000+），疑似为编码或 ID
- 若完全无法 parseFloat，疑似为字符串编码

### 4.2 SPLIT 整数分布

```ts
interface SplitSample {
  path: string;
  split: string | null;
  numericValue: number | null;
  isInteger: boolean;     // 是否为正整数
}
```

**判定规则**：
- `isInteger === true` 且值在 {1, 2, 3, 4, 6, 8} 中，疑似为分裂导线数
- `isInteger === false`，需进一步核验

### 4.3 MATRIX0 格式样本

```ts
interface Matrix0FormatSample {
  path: string;
  point0Matrix0: string | null;
  point1Matrix0: string | null;
  parsedLength: number | null;  // 元素数量
  likelyFormat: string;        // 4x4-matrix / 3x4-matrix / triplet / scalar / unknown
}
```

**格式推断规则**（`guessMatrix0Format`）：

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

**分隔符识别**：优先识别逗号分隔，回退空格分隔。

### 4.4 BLHA 高程样本

```ts
interface BlhaElevationSample {
  path: string;
  point0Elevation: number | null;  // POINT0.BLHA 第 3 段
  point1Elevation: number | null;  // POINT1.BLHA 第 3 段
  elevationDelta: number | null;   // point1 - point0（米）
}
```

**已知规则**：BLHA = `纬度,经度,高程,方位角`（lat 在前），第 3 段为高程。

### 4.5 ISJUMPER 样本

样本中 `ISJUMPER` 的真值分布（1/true/TRUE/yes 占比）。

---

## 5. 语义假设

> **重要**：以下全部为"疑似 / 候选 / 待确认"，**不写成结论**。M4-B3 阶段不验证字段的物理含义。

- `KVALUE` 疑似张力 / 弧垂相关参数（覆盖率统计见运行时报告），但物理含义待样本核验
- `SPLIT` 疑似分裂导线数，需验证是否为正整数
- `POINT0/1.MATRIX0` 疑似挂点或端点局部变换参数，坐标系与单位待确认
- `POINT0.BLHA` 第 3 段可作为高程候选（与 `POINT1.BLHA` 高差参与弧垂计算）
- `ISJUMPER` 疑似跳线标识，跳线可能不需要悬链线计算
- `MATERIALSHEET` 疑似导线材料表，可能参与弧垂计算（线规/截面积）
- `TRANSFORMMATRIX` 疑似节点整体变换矩阵，与 `POINT0/1.MATRIX0` 关系待确认
- `BACKSTRING` / `FRONTSTRING` 已确认含义（端点兜底引用）

---

## 6. 阻塞问题

推进 M4-B4（悬链线预研）前需解决的阻塞问题：

1. **KVALUE 物理含义未确认**
   - 候选：张力系数？弧垂参数？应力？是否单位无关？
   - 若 KVALUE 缺失，需确认是否来自父 F4(WIRE) 或 FAM 文件

2. **POINT0/1.MATRIX0 坐标系与单位未确认**
   - 候选：局部坐标？世界坐标？米？毫米？
   - 若 MATRIX0 缺失，悬链线挂点高程是否可仅依赖 BLHA 第 3 段

3. **是否需要 MATERIALSHEET 参与弧垂计算**
   - 候选：导线截面 / 单位长度重量 / 张力等级
   - 若需要，需先解析 MATERIALSHEET 文件格式

4. **GIM 标准文档是否有 KVALUE/SPLIT/MATRIX0 的明确字段定义**
   - 若有，按标准文档实现
   - 若无，需用户对照样本工程人工确认

---

## 7. M4-B4 建议

### 7.1 先做"示意悬链线"还是"工程语义悬链线"

**建议先做"示意悬链线"**：
- 基于 KVALUE + BLHA 高程差，假设公式 `f(x) = k * x * (L - x)`（抛物线近似）
- 不依赖 KVALUE 物理含义的确认，仅作为视觉增强
- 通过 feature flag 控制，默认禁用，保持直线段为默认

**不建议直接做"工程语义悬链线"**：
- KVALUE 物理含义未确认，可能产生误导
- 若 KVALUE 实际为张力系数，需结合档距、温度、导线参数等计算真实弧垂

### 7.2 是否需要更多样本

- 当前每类最多 20 条样本，若 GIM 标准文档无字段定义，需收集 2-3 个不同电压等级 / 不同塔型的样本工程
- 重点关注：KVALUE 在不同塔型下的分布、MATRIX0 格式一致性

### 7.3 是否需要用户人工确认字段含义

**建议是**：
- 在 M4-B3 报告输出后由用户对照样本工程确认 KVALUE/SPLIT/MATRIX0 含义
- 用户确认后才能进入"工程语义悬链线"实现

### 7.4 是否继续保持直线段作为默认

**建议是**：
- 悬链线作为可选增强（feature flag 控制）
- 默认保持直线段，避免未经确认的参数引入误导

---

## 8. 审计服务 API

### 完整报告

```ts
// src/services/lineGeometryAuditService.ts

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

### 摘要输出（lineProjectView 集成）

```ts
// src/ui/lineProjectView.ts
function buildLineCatenaryAuditSummary(graph, mapData): {
  wireCount: number;
  coverage: Record<string, { count: number; ratio: number }>;
  blockingQuestionCount: number;
}

// 调用点：renderLineProjectPanels 完成 mapData 提取后
debugLog(DEBUG_LINE_MAP, '[M4-B3] catenary param audit summary', summary);
```

### 调用约束

- 只读内存数据，不读 DB、不读 GIM 文件
- 不影响渲染、不修改 state
- 样本数量限制（每类最多 20 条）
- 默认不集成到 Ctrl+Shift+D 诊断（避免 JSON 体积过大），仅在 `DEBUG_LINE_MAP` 开启时输出到 console
