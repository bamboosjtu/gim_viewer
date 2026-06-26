# M4-B1 线路几何与导线语义审计

> 阶段性预研文档。本轮仅做字段审计 + 数据结构预研，**不实现悬链线**、**不改 SQLite schema**、**不破坏 OSM MVP baseline**。

---

## 1. 当前线路地图实现

### 1.1 塔位

- **节点类型**：`F4System` + `GROUPTYPE=TOWER`
- **坐标来源**：节点自身 `rawProps.BLHA`（格式 `纬度,经度,高程,方位角`）
- **属性来源**：F4 节点 + `Tower_Device` 子节点的 FAM/DEV 引用（通过 `gatherFamRefs` / `gatherDevRefs` 收集）
- **已提取字段**：杆塔编号、塔型、呼高、转角（通过候选键匹配 FAM/DEV 属性表）
- **渲染**：圆形（直线塔）/ 菱形（耐张塔，DEVICETYPE 命中 TENSION 关键字）
- **交互**：hover tooltip、click 选中、树↔地图联动

### 1.2 导线

- **节点类型**：`WIRE`
- **导线类型**：`CONDUCTOR`（导线，蓝）、`GROUNDWIRE`（地线，灰）、`OPGW`（绿）、`UNKNOWN`（灰）
- **类型判定**：`resolveWireType()` — 优先 WIRE 节点自身 `WIRETYPE`，回退父 `F4System(GROUPTYPE=WIRE)` 的 `WIRETYPE`
- **端点坐标**：
  - 优先 `POINT0.BLHA` + `POINT1.BLHA`（WIRE 节点自身）
  - 兜底 `BACKSTRING` + `FRONTSTRING` → STRING 文件引用 → `TOWER F4.BLHA`
- **渲染**：直线段（`moveTo` + `lineTo`），**无悬链线、无弧垂**
- **图层开关**：导线 / 地线 / OPGW / 未知导线 4 个独立开关

### 1.3 跨越点

- **节点类型**：`F4System` + `GROUPTYPE=CROSS`
- **坐标来源**：`rawProps.BLHA`（缺失时进 `unresolved.crosses`）
- **渲染**：三角形警示符号

### 1.4 当前折线策略

- **数据来源**：`extractLineMapData()` 输出的 `LineMapData.wires: WireSegment[]`
- **投影**：Canvas 等距矩形投影 / MapLibre overlay 模式委托 `map.project()`
- **绘制**：`lineMapView.drawWires()` — 每条 wire 一段直线，按 `wireLayerKey(wireType)` 分图层
- **缺失能力**：无档距计算、无弧垂、无悬链线、无分裂导线、无起止塔关联展示

---

## 2. 已解析字段

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

> 关键结论：**所有 rawProps 均已序列化为 JSON 入库**（`line_cbm_node.raw_props_json`），数据齐备，缺的只是"提取 + 使用"环节。

---

## 3. 导线语义

### 3.1 CONDUCTOR（导线）

- 来源：`WIRETYPE=CONDUCTOR` 的 WIRE 节点
- 颜色：`#3b82f6`（蓝）
- 渲染：直线段
- 缺失：电压等级、回路、相别、导线型号、档距、弧垂

### 3.2 GROUNDWIRE（地线）

- 来源：`WIRETYPE=GROUNDWIRE` 的 WIRE 节点
- 颜色：`#6b7280`（灰）
- 渲染：直线段

### 3.3 OPGW（光纤复合架空地线）

- 来源：`WIRETYPE=OPGW` 的 WIRE 节点
- 颜色：`#10b981`（绿）
- 渲染：直线段

### 3.4 未知导线

- 来源：`WIRETYPE` 缺失或值不在已知列表
- 颜色：`#9ca3af`（浅灰）
- 建议：M4-B2 增加 WIRETYPE 兜底逻辑（如按导线型号关键字推断）

### 3.5 起止塔关系

- **当前**：WIRE 节点不直接持有起止塔引用，仅通过 `BACKSTRING`/`FRONTSTRING` 引用 STRING 文件，STRING 文件归属某个 TOWER F4
- **反查路径**：`WIRE.rawProps.BACKSTRING` → `STRING<i>.STRING` → `towerGroupByStringPath` → `TOWER F4.BLHA`
- **缺失**：未在 UI 展示"导线从 N1 塔到 N2 塔"，仅展示端点坐标
- **建议**：M4-B2 在导线属性面板新增"起止塔"展示（通过现有拓扑反查即可，无需改 schema）

### 3.6 回路 / 相别 / 线型 / 电压等级

| 语义 | 当前状态 | 候选字段位置 |
|---|---|---|
| 回路 | ❌ 未解析 | 可能在 F1/F2/F3 rawProps（未确认）或 `STRING<i>.GPOINT` |
| 相别 | ❌ 未解析 | `STRING<i>.GPOINT` 挂点名（如"前导6"已捕获到 rawRefs，未结构化） |
| 线型 | ❌ 未解析 | 可能在 WIRE rawProps 或 FAM 属性 |
| 电压等级 | ❌ 未解析 | 可能在 F1/F2/F3 rawProps（未确认） |

---

## 4. 悬链线相关候选字段

### 4.1 KVALUE

- **位置**：WIRE 节点 `rawProps.KVALUE`
- **当前用途**：属性面板高亮显示
- **推测语义**：张力系数 / 弧垂参数候选
- **覆盖度**：审计服务可输出 `KVALUE 出现 N/M 次`
- **风险**：未在 GIM 标准文档中确认语义，需 M4-B2 人工核验样本值

### 4.2 SPLIT

- **位置**：WIRE 节点 `rawProps.SPLIT`
- **当前用途**：属性面板高亮显示
- **推测语义**：分裂导线数（如 4 分裂、6 分裂、8 分裂）
- **用途**：M4-B2 可做分裂导线渲染（同一档距画 N 条平行线）

### 4.3 POINT0 / POINT1

- **位置**：WIRE 节点 `rawProps.POINT0.BLHA` / `POINT1.BLHA`
- **当前用途**：导线端点坐标（已使用）
- **悬链线用途**：悬链线起点 / 终点
- **覆盖度**：审计服务可输出 `hasPoint0Blha` / `hasPoint1Blha` 命中率

### 4.4 MATRIX0

- **位置**：WIRE 节点 `rawProps.POINT0.MATRIX0` / `POINT1.MATRIX0`
- **当前用途**：属性面板高亮显示（注释标记"悬链线计算用"）
- **推测语义**：端点变换矩阵（可能是挂点高度偏移 / 绝缘子串长度）
- **风险**：未确认具体语义，需 M4-B2 人工核验

### 4.5 BLHA 高程分量

- **位置**：TOWER F4 / WIRE 的 `BLHA` 第 3 段（`纬度,经度,高程,方位角`）
- **当前用途**：TowerMarker.elev，tooltip 展示
- **悬链线用途**：两端高程差影响弧垂曲线
- **覆盖度**：BLHA 已解析，elev 字段已存在

### 4.6 其他候选字段

| 字段 | 推测语义 | 当前状态 |
|---|---|---|
| `ISJUMPER` | 跳线标志 | 未解析 |
| `MATERIALSHEET` | 材料表 | 未解析 |
| `TRANSFORMMATRIX` | 节点变换矩阵 | 已入库未用于几何 |

---

## 5. 当前缺口

### 5.1 字段缺失

- **电压等级**：未在 F1/F2/F3 rawProps 中显式提取（数据可能在 `raw_props_json`，但未结构化）
- **回路号**：未识别字段
- **相别**：`STRING<i>.GPOINT` 已捕获到 rawRefs，但未结构化解析
- **导线型号**：未识别字段（可能在 FAM 属性或 WIRE rawProps）
- **档距**：未计算（可由两端 BLHA 反算，M4-B2 可补）
- **弧垂**：未计算（依赖 KVALUE/SPLIT 语义确认）

### 5.2 字段未解析

- `POINT0.MATRIX0` / `POINT1.MATRIX0` 已在 rawProps 但语义未确认
- `STRING<i>.GPOINT` 已捕获但未结构化为"相别 / 挂点序号"
- `TRANSFORMMATRIX` 已入库但未用于几何变换

### 5.3 字段无法确认含义

- `KVALUE`：可能是张力系数、弧垂系数、应力，需对照 GIM 标准文档或样本工程人工核验
- `SPLIT`：可能是分裂导线数，但未确认是否为数值字段
- `MATRIX0`：可能是 4x4 变换矩阵的某一行的逗号分隔值，语义未确认

---

## 6. M4-B2 建议

### 6.1 优先级 1：导线属性面板增强（低风险）

- 在 WIRE 节点属性面板新增"起止塔"展示（通过 `BACKSTRING`/`FRONTSTRING` 反查 TOWER F4 的杆塔编号）
- 新增"档距"展示（由两端 BLHA 反算 Haversine 距离）
- 新增"导线类型"分组展示（CONDUCTOR/GROUNDWIRE/OPGW/UNKNOWN）
- 新增"KVALUE/SPLIT/MATRIX0"样本值展示（已有，确认是否需补充注释）
- **不改 schema、不改渲染**，仅 UI 增强

### 6.2 优先级 2：导线样式分层（中风险）

- 按 `wireType` 已有 4 色分层，可扩展为线宽 / 线型（虚线/点划线）分层
- 按 `SPLIT` 分裂数渲染分裂导线（同档距 N 条平行线，偏移量按缩放自适应）
- 按"电压等级"（如能从 F1/F2/F3 提取）做线宽分层
- **不改 schema**，仅 Canvas 渲染增强

### 6.3 优先级 3：悬链线预研（高风险，本轮不做）

- 需先确认 `KVALUE` / `SPLIT` / `MATRIX0` 语义（对照 GIM 标准文档或样本工程）
- 需确认是否使用真实弧垂公式还是简化抛物线
- 需考虑 Canvas overlay 模式下的悬链线采样密度（避免性能问题）
- **本轮明确禁止**，待 M4-B2 完成字段确认后再评估

### 6.4 验收清单（M4-B2 进入条件）

- [ ] `lineGeometryAuditService` 在样本 GIM 上运行，输出 `KVALUE`/`SPLIT`/`MATRIX0` 覆盖度
- [ ] 人工核验 `KVALUE` 样本值是否为数值（张力系数）
- [ ] 人工核验 `SPLIT` 样本值是否为整数（分裂导线数）
- [ ] 人工核验 `MATRIX0` 样本值格式（矩阵行 or 标量）
- [ ] 确认 F1/F2/F3 rawProps 中是否含电压等级字段
- [ ] 确认 `STRING<i>.GPOINT` 是否可作为相别 / 挂点信息来源

---

## 7. 审计服务 API

`src/services/lineGeometryAuditService.ts` 提供：

```ts
export function buildLineGeometryAuditReport(args: {
  graph: unknown;       // GimGraph
  mapData: unknown;     // LineMapData
  attrIndex?: unknown;  // LineAttributeIndex
}): LineGeometryAuditReport;
```

返回结构包含：
- `nodeTypeCounts`：节点类型计数
- `wireTypeCounts`：导线类型计数
- `conductorLikeSamples`：导线样本（最多 10 条，含 KVALUE/SPLIT/MATRIX0 样本值）
- `towerLikeSamples`：塔位样本
- `crossLikeSamples`：跨越点样本
- `possibleSagFields`：悬链线候选字段统计
- `missingFields`：缺失的期望字段
- `recommendations`：给 M4-B2 的可执行建议

**调用约束**：
- 只读内存数据，不读 DB、不读 GIM 文件
- 不影响渲染、不修改 state
- 样本数量限制（每类最多 10 条）
- 当前未集成到 Ctrl+Shift+D 诊断（避免诊断体积过大），可在 DevTools Console 手动调用

---

## 8. M4-B2 导线属性增强与样式分层（实现记录）

> 阶段：已完成。本轮 **不实现悬链线**，仅做"导线可点、可看、可解释"。

### 8.1 新增 WireSemanticInfo

文件：`src/services/lineWireSemanticService.ts`

```ts
export interface WireSemanticInfo {
  wireType: string;           // CONDUCTOR / GROUNDWIRE / OPGW / UNKNOWN
  layerKey: string;           // conductor / groundwire / opgw / unknownWire
  isJumper: boolean;          // ISJUMPER 命中 1/true/TRUE/yes
  split: number | null;       // SPLIT 转数字
  kValue: string | null;
  point0Blha: string | null;  // 起点 BLHA 原始字符串
  point1Blha: string | null;
  point0Matrix0: string | null;
  point1Matrix0: string | null;
  backString: string | null;  // 端点兜底引用
  frontString: string | null;
  spanMeters: number | null;  // Haversine 档距近似（米）
  warnings: string[];
}

export function buildWireSemanticInfo(args: {
  wire: unknown;             // WireSegment
  rawProps?: Record<string, string>;
}): WireSemanticInfo;
```

- 只读 wire + rawProps，不读 DB、不改 schema
- `spanMeters` 用 Haversine 公式（地球半径 6371000m），端点缺失返回 null + warning

### 8.2 新增导线属性面板字段

文件：`src/ui/lineProjectView.ts` → `showWireProperties(wire)`

点击导线后右侧属性面板展示：

| 字段 | 来源 | 缺失时 |
|---|---|---|
| 导线类型 | wire.wireType | — |
| 图层 | WireSemanticInfo.layerKey | — |
| 是否跳线 | ISJUMPER | 否 |
| 分裂数 (SPLIT) | rawProps.SPLIT | — |
| 档距 (近似) | Haversine 计算 | — |
| KVALUE | rawProps.KVALUE | — |
| 起点 BLHA (POINT0) | rawProps.POINT0.BLHA | — |
| 终点 BLHA (POINT1) | rawProps.POINT1.BLHA | — |
| POINT0.MATRIX0 | rawProps.POINT0.MATRIX0 | — |
| POINT1.MATRIX0 | rawProps.POINT1.MATRIX0 | — |
| BACKSTRING | rawProps.BACKSTRING | — |
| FRONTSTRING | rawProps.FRONTSTRING | — |

- 端点坐标小节：展示已解析的 startLat/startLng/endLat/endLng（6 位小数）
- 解析告警小节：warnings 非空时显示 ⚠ 标识
- 原始 rawProps 小节：折叠展示，便于排障
- 档距保留 1 位小数（如 `356.2 m`）

### 8.3 新增档距近似计算

- 公式：Haversine（球面三角）
- 地球半径：6371000 m
- 输入：wire.startLat/startLng/endLat/endLng
- 输出：米，保留 1 位小数由 UI 层处理
- 端点缺失：返回 null + warning `导线端点坐标缺失，无法计算档距`

### 8.4 新增 jumper / split 样式增强

文件：`src/ui/lineMapView.ts` → `drawWireSegment(w, isSelected)`

| 规则 | 样式 |
|---|---|
| `isJumper=true` | 虚线 `[6, 4]`（setLineDash） |
| `SPLIT > 1` | 线宽 2.5px（默认 1.5px） |
| 选中导线 | 线宽 3.5px + 黄色光晕描边 |
| UNKNOWN | 保持浅灰弱化样式 |

- 选中态先画一层黄色光晕（`rgba(245,158,11,0.45)`，宽 7.5px），再画主体线
- 选中态最后绘制，确保位于所有导线最上层

### 8.5 导线 hit-test 与选中态

- 新增 `hitTestWire(sx, sy, threshold)`：点到线段距离（像素）
- 点击阈值：`WIRE_HIT_DIST = 6px`（严格）
- Hover 阈值：`WIRE_HIT_DIST_HOVER = 8px`（放宽，仅更新 cursor）
- 优先级：塔位 > 导线（命中塔位时不触发导线 hit-test）
- 选中导线后清除塔位选中态，反之亦然（避免双重选中）
- `fit()` / `destroy()` 时清除导线选中态

### 8.6 仍然保持直线段渲染

- 本轮明确 **不做悬链线、不做弧垂**
- `drawWires()` 仍使用 `moveTo` + `lineTo` 绘制直线段
- 样式增强仅影响线宽 / 虚线 / 颜色，不改变线段几何

### 8.7 OSM overlay / Canvas fallback 兼容性

- `onWireClick` 在 3 个 renderLineMap 调用点均接入：
  1. 初始 Canvas 渲染
  2. OSM fallback 后的 Canvas-only 重渲染
  3. OSM overlay 模式（MapLibre 底图 + Canvas overlay）
- 导线点击在 Canvas-only / overlay 模式下行为一致
- 不影响 OSM 底图加载、不影响 fallback 触发逻辑
