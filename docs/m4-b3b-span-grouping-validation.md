# M4-B3B 档距聚合与 MATRIX0 平移分量验证

> 阶段：审计与预研。本轮**不实现悬链线渲染、不实现弧垂计算、不改 SQLite schema、不扩展底图**。
>
> 目标：在 M4-B3 / M4-B3A 基础上回答"一档多线"结构问题，先理解档距聚合规律，再决定 M4-B4 路线。
>
> 前置依赖：[M4-B3 悬链线参数验证](m4-b3-catenary-param-validation.md)（先做 B3 覆盖率核验，再做 B3B 档距聚合）。

---

## 1. 目标与边界

### 目标

回答以下 5 个问题：

```text
1. 一个档距内有多少 WIRE？
2. 如何按 wireType / SPLIT / KVALUE / MATRIX0 分组？
3. MATRIX0 的 x,y,z 是否解释相位/分裂/高度？
4. BLHA 是档距端点还是挂点？
5. KVALUE 是否存在分布规律？
```

### 边界（强制）

- **不实现**悬链线计算 / 弧垂绘制
- **不改** SQLite schema、不改 GIM 解析
- **不扩展**底图或坐标系统
- **不破坏**现有渲染、交互、IFC、OSM baseline
- **不将** KVALUE / MATRIX0 定义为确定语义，仅称"疑似 / 候选 / 待确认"
- **不使用** BACKSTRING / FRONTSTRING 作为档距键（保持本轮范围聚焦）

### 实际样本背景

- `wireCount = 5460`
- `towerCount = 327`
- `KVALUE / SPLIT / POINT0.BLHA / POINT1.BLHA / POINT0.MATRIX0 / POINT1.MATRIX0` 覆盖率 100%
- MATRIX0 为 16 元素 4x4 矩阵
- SPLIT 取值 `1` / `4`（疑似分裂数）
- KVALUE 为数值但语义未确认
- 多条 WIRE 共用相同 BLHA → 必须先做档距聚合

---

## 2. 档距聚合必要性

### 现象

实际线路样本中，多个 WIRE 节点共享同一对 `POINT0.BLHA + POINT1.BLHA`：

- 同一档距内可能包含：导线（CONDUCTOR）+ 地线（GROUNDWIRE）+ OPGW
- 同一导线类型可能因分裂导线（SPLIT=4）产生 4 条独立 WIRE 记录
- 跳线（ISJUMPER=1）可能跨档，但仍以两端 BLHA 标识

### 必要性

- 若直接按 WIRE 节点渲染悬链线，会出现"一档多线"重叠
- 需要先按档距聚合，理解每档 WIRE 数的分布规律（固定值 vs 动态值）
- 才能决定 M4-B4 是按"固定档距结构"建模（每档复用同一弧垂参数组）还是按"动态档距结构"建模

### 不做档距聚合的后果

- 弧垂参数张冠李戴（A 档的 KVALUE 用到 B 档）
- 渲染重叠（同档 4 分裂导线被画成 4 条悬链线）
- 无法对照样本工程核验 MATRIX0 平移分量的物理含义

---

## 3. spanKey 规则

### 规则定义

```ts
function buildSpanKey(p0: string, p1: string): string {
  if (!p0 || !p1) return 'missing-endpoint';
  const a = p0.trim();
  const b = p1.trim();
  return a <= b ? `${a} -> ${b}` : `${b} -> ${a}`;
}
```

### 设计要点

| 要点 | 说明 |
|---|---|
| 端点来源 | `POINT0.BLHA` + `POINT1.BLHA`（WIRE.rawProps） |
| 去方向 | `A -> B` 与 `B -> A` 视为同一档距（按字典序排序） |
| 缺失处理 | 任一端点缺失 → `'missing-endpoint'`（不参与样本统计） |
| 空白处理 | 去除两端空白，避免 `'1,2,3'` 与 `'1, 2, 3'` 产生不同 key |
| 不使用 | BACKSTRING / FRONTSTRING（保持本轮范围聚焦） |
| 保留原始 | 报告中 `point0Blha` / `point1Blha` 字段保留原始 BLHA 字符串 |

### 局限性

- BLHA 第 4 段方位角差异不影响 spanKey（前 3 段相同即视为同档）
- 同塔不同挂点（横担）若 BLHA 相同，会被聚合到同一档距 → 需要 MATRIX0 区分挂点

---

## 4. MATRIX0 解析

### 解析规则

```ts
function parseMatrixTranslation(matrix: string | null): MatrixTranslation
```

| 输入长度 | 解析方式 | likelyFormat |
|---|---|---|
| 16 | 4x4 矩阵，平移分量为 `values[12]` / `values[13]` / `values[14]` | `4x4-matrix` |
| 12 | 3x4 矩阵（行优先），平移分量为 `values[3]` / `values[7]` / `values[11]` | `3x4-matrix` |
| 9 / 6 / 4 / 3 / 1 | 不解析平移，仅记录长度与格式 | `3x3-matrix` / `6-tuple` / `quaternion` / `triplet` / `scalar` |

### 分隔符

- 优先逗号（`,`），过滤空字符串
- 若按逗号分割后元素数 ≤ 1，回退空格分隔（`\s+`）

### 输出字段

```ts
interface MatrixTranslation {
  x: number | null;     // 4x4: values[12]，疑似横担偏移
  y: number | null;     // 4x4: values[13]，疑似横担偏移
  z: number | null;     // 4x4: values[14]，疑似高度层级
  rawLength: number | null;
  likelyFormat: string;
}
```

### 重要约束

- **不确认**单位（米？毫米？）
- **不确认**坐标系（局部？世界？相对塔位？）
- **仅称**"疑似平移分量"
- 实际样本显示为 16 元素 4x4 矩阵，平移在 `[12][13][14]`

### 待用户核验

| 假设 | 验证方式 |
|---|---|
| x/y 是横担偏移 | 对比同档不同 wireType 的 x/y 是否差异 |
| z 是挂点高度 | 对比 CONDUCTOR vs OPGW 的 zRange 是否分层 |
| 单位为米 | 对比 zRange 量级与塔位 BLHA 高程差 |
| 坐标系为局部 | 对比同塔不同档距的 x/y 是否方向一致 |

---

## 5. 聚合统计项

### 每个档距组（SpanGroupSample）的统计字段

| 字段 | 说明 |
|---|---|
| `spanKey` | `min(p0, p1) -> max(p0, p1)` |
| `point0Blha` / `point1Blha` | 原始 BLHA 字符串 |
| `wireCount` | 该档距 WIRE 数 |
| `wireTypeCounts` | 按导线类型计数（CONDUCTOR / GROUNDWIRE / OPGW / UNKNOWN） |
| `splitCounts` | 按 SPLIT 值计数 |
| `kValueStats` | min / max / zeroCount / nonZeroCount / distinctSampleValues（≤20） |
| `point0TranslationStats` | POINT0.MATRIX0 平移分量 x/y/z 的 min/max 范围 |
| `point1TranslationStats` | POINT1.MATRIX0 平移分量 x/y/z 的 min/max 范围 |
| `wireSamples` | 该档距的 WIRE 样本（≤20） |

### 档距组大小统计（spanGroupSizeStats）

| 字段 | 说明 |
|---|---|
| `min` / `max` / `avg` | 每档 WIRE 数的最小 / 最大 / 平均值 |
| `topSizes` | WIRE 数 Top 5 档距（按 wireCount 降序） |

### 样本上限

| 上限 | 值 |
|---|---|
| `MAX_SPAN_GROUP_SAMPLES` | 20（档距组样本数） |
| `MAX_WIRE_SAMPLES_PER_GROUP` | 20（每档内 WIRE 样本数） |
| `MAX_DISTINCT_KVALUES` | 20（distinct KVALUE 原始值样本） |

### 观察 / 阻塞 / 建议自动生成规则

| 类型 | 自动生成条件 |
|---|---|
| 观察 | wireCount / spanGroupCount / minSize===maxSize / wireType 分布 / SPLIT 分布 / zRange 非零 / KVALUE=0 占多数 / OPGW vs CONDUCTOR 差异 |
| 阻塞问题 | spanGroupCount=0 / minSize!==maxSize / MATRIX0 坐标系未确认 / KVALUE=0 含义 / BLHA 是端点还是挂点 |
| 建议 | 每档固定 WIRE 数 → 固定档距结构 / 动态 → 动态结构 / z 非零 → 可作挂点高度 / BLHA+MATRIX0 假设 |

---

## 6. 用户核验要点

### 6.1 导出方式

按 `Ctrl + Shift + C`（Tauri 桌面模式），JSON payload 中新增 `spanGroupingReport` 字段：

```json
{
  "generatedAt": "...",
  "projectSummary": { ... },
  "report": { ... },                       // M4-B3 审计报告
  "spanGroupingReport": {                  // M4-B3B 档距聚合
    "wireCount": 5460,
    "spanGroupCount": 327,
    "spanGroupSizeStats": {
      "min": 12, "max": 16, "avg": 16.7,
      "topSizes": [ ... ]
    },
    "spanGroupSamples": [ ... ],
    "observations": [ ... ],
    "blockingQuestions": [ ... ],
    "recommendations": [ ... ]
  }
}
```

Console 同时输出 Markdown 摘要：

- §10 档距聚合摘要：WIRE 总数 / 唯一档距数 / min/max/avg / Top 5
- §11 MATRIX0 平移样本：前 5 档距的 wireTypes / SPLIT / P0 zRange / P1 zRange / KVALUE 0/非0 占比

### 6.2 档距聚合核验

检查 `spanGroupingReport.spanGroupSizeStats`：

- **每档 WIRE 数是否固定**：看 `min === max`
  - 固定 → 疑似结构化分裂导线 + 地线 + OPGW 共档
  - 不固定 → 疑似转角塔 / 分支塔 / 跳线档差异
- **avg 是否接近整数**：avg ≈ 12 / 16 / 24 → 疑似标准塔型结构
- **Top 5 是否包含特殊档距**：高 WIRE 数档距可能为变电站进出线段

### 6.3 MATRIX0 平移分量核验

检查 `spanGroupingReport.spanGroupSamples[].point0TranslationStats` / `point1TranslationStats`：

- **zRange 是否非零**：非零 → 疑似挂点高度层级
- **zRange 是否分层**：同档 CONDUCTOR vs OPGW 的 zRange 是否明显不同
- **x/y 是否体现横担偏移**：xRange / yRange 是否在合理范围（±10m）
- **P0 与 P1 的 zRange 是否对称**：若相同 → 同塔挂点高度一致；若不同 → 跨档挂点差异

### 6.4 KVALUE 分布核验

检查 `spanGroupingReport.spanGroupSamples[].kValueStats`：

- **KVALUE=0 是否集中**：`zeroCount > nonZeroCount` → 部分档距未启用弧垂参数
- **KVALUE 非 0 是否占多数**：`nonZeroCount > zeroCount` → 疑似为张力/弧垂相关参数
- **distinctSampleValues 是否有限**：值域窄 → 离散参数；值域宽 → 连续参数
- **KVALUE 与 wireType 关系**：CONDUCTOR 的 KVALUE 是否明显不同于 OPGW

### 6.5 BLHA 端点核验

检查 `spanGroupingReport.spanGroupSamples[].point0Blha` / `point1Blha`：

- **第 1/2 段（经纬度）是否为塔位中心**：同塔不同挂点 BLHA 是否相同
- **第 3 段（高程）是否为塔位高程**：与塔位 FAM 属性的 towerHeight 是否一致
- **第 4 段（方位角）是否为档距方向**：与前后档方位角是否连续

### 6.6 核验结论模板

完成核验后，建议填写以下结论模板：

```text
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

M4-B4 路线决策：
  - 示意悬链线 / 工程语义悬链线 / 暂缓
  - 理由：_______________
```

---

## 7. M4-B4 决策条件

### 7.1 进入 M4-B4 的前置条件

| 条件 | 验证方式 |
|---|---|
| 每档 WIRE 数规律已理解 | `spanGroupSizeStats.min === max` 或差异原因已识别 |
| MATRIX0 平移分量单位已确认 | 用户对照样本工程核验 |
| BLHA 是塔位还是挂点已确认 | 用户对照样本工程核验 |
| KVALUE=0 含义已确认 | 用户对照样本工程核验 |
| OPGW vs CONDUCTOR 差异已识别 | `wireTypeCounts` 对照样本 |

### 7.2 M4-B4 路线分支

| 核验结论 | M4-B4 路线 |
|---|---|
| BLHA=塔位 + MATRIX0=挂点偏移 + KVALUE=张力 | **工程语义悬链线**（按 MATRIX0 平移分量计算挂点位置，按 KVALUE 计算弧垂） |
| BLHA=塔位 + MATRIX0=未确认 + KVALUE=未确认 | **示意悬链线**（按 BLHA 高程差 + 经验弧垂参数绘制） |
| BLHA=挂点 + MATRIX0=未确认 | **示意悬链线**（直接用 BLHA 作端点） |
| 全部未确认 | **暂缓**（继续预研或放弃悬链线） |

### 7.3 不进入 M4-B4 的情况

- 每档 WIRE 数完全无规律（min/max 差异极大且无原因）
- MATRIX0 平移分量全部为 0 或缺失
- 用户核验结论为"无法确认"
- 已实现"示意悬链线"满足业务需求

---

## 8. 实现文件

| 文件 | 说明 |
|---|---|
| `src/services/lineSpanGroupingAuditService.ts` | 档距聚合审计服务（`buildLineSpanGroupingAuditReport()` + `parseMatrixTranslation()`） |
| `src/services/lineCatenaryAuditExportService.ts` | 接入 `spanGroupingReport` 字段 + Markdown §10/§11 摘要 |

### 不修改的文件

- `src/gim/lineMapData.ts`（不改地图数据提取）
- `src/ui/lineMapView.ts`（不改渲染）
- `src/ui/lineProjectView.ts`（不改 UI；payload 通过 `buildLineCatenaryAuditExportPayload` 自动包含）
- `src/app/bootstrap.ts`（不改快捷键；Ctrl+Shift+C 自动包含新字段）
- `src-tauri/src/db.rs`（不改 schema）

---

## 9. 边界与约束

- **不破坏 OSM baseline**：本轮纯内存审计，不触及底图
- **不破坏导线交互**：不改 hit-test / 选中态 / 样式分层
- **不改 schema**：所有数据来源于 WIRE.rawProps（已序列化为 `raw_props_json`）
- **不确认 MATRIX0 为真实坐标**：仅称"疑似平移分量"
- **先理解"一档多线"，再决定 M4-B4**：本轮目标为理解，不为实现
