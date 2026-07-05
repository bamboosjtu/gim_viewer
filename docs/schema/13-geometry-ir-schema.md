# 统一 Geometry IR 草案

> 本文档基于 Round 1-8 的全部静态分析结论，设计一个不绑定 UI、不绑定 Three.js、不绑定 OBC 的中间表示（Intermediate Representation，IR），作为后续 `gim_viewer` 完整展示能力（变电 IFC + 变电 MOD + 变电 STL + 线路 4 类 MOD + 线路 STL）的统一对接接口。
>
> 本轮不写渲染实现，只沉淀 schema 与解析管道边界。

## 1. 目标与背景

### 1.1 现状缺陷

`gim_viewer` 当前展示能力存在以下明显缺陷：

| 维度 | 现状 | 缺陷 |
| ---- | ---- | ---- |
| 变电几何 | 仅渲染 IFC（设备外形 + CBM 树联动） | 4135 个 XML_WITH_ENTITIES MOD、1803 个 STL 完全未渲染 |
| 变电属性 | 仅展示 IFC 原生属性 + CBM/FAM/DEV | 4179 个 PHM 的 COLOR/TransformMatrix 信息未参与展示；44 个 EMPTY_DEVICE_XML 孤儿 MOD 的存在未提示 |
| 线路几何 | 仅渲染塔位点（CROSS 的经纬度点线） | 31 个 TEXT_HNUM_COMMA_RECORD MOD 文件未渲染；315 个 CROSS 对应的 TEXT_POINT_LINE MOD 未渲染；demo-line 中 181 个 unique STL 文件未渲染；Wire_Device 通过 11773 个 CBM refs 触达 8 个 unique STL；Tower_Device 通过部分 CBM refs 触达 STL 或 MOD，不能简单按 entityName 唯一决定 |
| 线路属性 | 仅展示 CBM/FAM/DEV | Tower_Device 螺栓参数（1300 个 Bolt 表）、HNum 杆塔分段参数、WIRE 导线参数全部未展示 |
| 缓存命中 | currentFiles=null 时仅恢复 CBM 树和 IFC 缓存路径 | MOD/STL 缓存策略未设计；缓存命中场景下无法回放非 IFC 几何 |
| 节点联动 | 仅 IFC 高亮 + 相机定位 | 节点→MOD/STL 几何的联动未实现 |

### 1.2 设计目标

```text
1. 不直接绑定 UI 或 Three.js / OBC
   - IR 是纯数据结构，可被 React/Vue/原生 DOM 同等消费
   - IR 可被 Three.js / Babylon.js / OBC 同等渲染
2. 覆盖 Round 1-8 已识别的全部几何来源
   - 变电 XML primitive 体系（14 类，Round 6）
   - 线路 4 类文本格式族（Round 7）
   - STL 三角网格（Round 8）
   - IFC 主路径（既有）
   - 无几何的"none"分支（EMPTY_DEVICE_XML / 14 个空 PHM）
3. 保留 Transform / Color 上游信息
   - 结构上保留 PHM TRANSFORMMATRIX + MOD Entity TransformMatrix 两级字段
   - 但当前三个样本中，PHM TRANSFORMMATRIX 100% 为单位矩阵（Round 5）
   - 实际有效变换主要来自 MOD Entity.TransformMatrix（即事实上的单级变换）
   - PHM COLOR（STL 引用非空，MOD 引用为空）
4. 支持懒加载与缓存命中两条路径
   - 首次打开：currentFiles 持有原始文件 → IR 由 parser 即时构建
   - 缓存命中：currentFiles=null → IR 由 SQLite 索引恢复，几何按需加载
5. 不增加 schema 膨胀
   - IR 只描述"如何获取与解析几何"，不复制原始字段
   - 大字段（如 STL 字节流、IFC buffer）保留 path 引用，按需读取
```

### 1.3 不在 IR 范围

```text
- 渲染策略（线框 / 实体 / 点云 / 地图叠加）→ 由 viewer 层决定
- UI 展示形式（属性面板 / 树节点 / 弹窗）→ 由 ui 层决定
- SQLite schema 变更（PARSER_VERSION 升级、新表 DDL、数据迁移、索引设计）
  → 不在 IR 范围；IR 只定义内存数据结构
  → §5.2 给出 geometry_source 表的字段建议，正式 DDL 另起 14-geometry-cache-schema.md
- 几何运算（布尔 / CSG / 简化）→ 由渲染层或专门的 geometry 工具处理
- 工程语义（塔型 / 跨越档距 / 导线型号）→ 由 CBM/FAM/DEV 属性层处理
```

---

## 2. 顶层 IR 联合类型

### 2.1 GimGeometrySource

```typescript
/**
 * GIM 几何来源的统一中间表示。
 *
 * 一个 CBM 节点（或一个 PHM 引用）对应一个 GimGeometrySource。
 * 解析器（parser）按 SOLIDMODEL 扩展名 + MOD 内容分发到对应 kind。
 *
 * 设计原则：
 * - 联合类型分发，避免巨型 interface
 * - 每个 kind 自带最小必要字段，不复制原始文件内容
 * - 大字段（字节流 / 文件路径）保留 path 引用，由 viewer 按需读取
 * - none 分支显式表达"无几何"，避免 null 散落
 *
 * 顶层联合类型引用各 kind 的详细 interface（§3），
 * 避免 inline union 与详细 interface 字段不同步。
 * 详细 interface 见 §3.1-§3.5。
 */
export type GimGeometrySource =
  | IfcGeometrySource
  | XmlModGeometrySource
  | LineTextModGeometrySource
  | StlGeometrySource
  | NoneGeometrySource;
```

### 2.2 NoneReason 枚举

```typescript
/**
 * "无几何"原因分类，用于 UI 提示与诊断。
 *
 * 注意区分两种"无几何"语义：
 * - phm-no-solidmodel：PHM 无 SOLIDMODEL 字段（底层事实状态，可能就是空装配）
 * - assembly-node-without-own-geometry：装配节点自身无几何，但子设备几何完整
 *   （Round 7：变电 14 个无目标 PHM 即属于此类，需要区分以免误判为"缺几何"）
 */
export type NoneReason =
  | "empty-device-xml"                          // 变电 EMPTY_DEVICE_XML（44 个，未参与渲染但应提示）
  | "phm-no-solidmodel"                         // PHM 无 SOLIDMODEL 字段（底层事实状态）
  | "assembly-node-without-own-geometry"        // 装配节点自身无几何，但子设备几何完整（变电 14 个 PHM）
  | "phm-missing-target"                        // SOLIDMODEL 引用目标缺失（硬缺失）
  | "cbm-no-objectmodelpointer"                 // CBM 未声明 OBJECTMODELPOINTER
  | "dev-no-solidmodel"                         // DEV 未引用任何 PHM
  | "parser-unsupported"                        // 解析器暂不支持该 kind（保留扩展点）
  | "parse-failed"                              // 解析失败（具体错误由 reason 详情携带）
  | "unknown";                                  // 未分类
```

### 2.3 LineModFormat 枚举

```typescript
/**
 * 线路 MOD 4 类文本格式族（Round 7）。
 */
export type LineModFormat =
  | "text-hnum-comma-record"  // 杆塔主体分段构件（31 文件）
  | "text-point-line"          // 经纬度点线（315 文件，CROSS）
  | "text-section-kv-record"  // 螺栓参数表（1300 文件）
  | "text-key-value";          // 杆塔基础参数 / 导线参数（161 文件）
```

---

## 3. 各 kind 详细 schema

### 3.1 ifc（既有 IFC 主路径）

```typescript
export interface IfcGeometrySource {
  kind: "ifc";
  /** IFC 文件名（如 "ABC123.ifc"），用于唯一标识 modelId */
  ifcFile: string;
  /** IFC GlobalID（可选，CBM 的 IFCGUID 字段） */
  ifcGuid?: string;
  /** modelId = ifcFile 去除 .ifc 后缀，用于 OBC Fragments 注册 */
  modelId: string;
  /** 缓存命中时从 cachedIfcPaths 获取本地路径；首次打开时为空 */
  cachedPath?: string;
}
```

> 既有 [src/gim/types.ts](../../src/gim/types.ts) 的 `IfcEntry` 已覆盖此结构，IR 直接复用，不重新发明。

### 3.2 xml-mod（变电 XML primitive 体系，Round 6）

```typescript
/**
 * 变电 XML MOD 的单个 Entity（对应 <Entity> 元素）。
 *
 * 字段来源：
 * - id / type / visible：Entity 属性
 * - primitive：14 类 primitive 之一（Cylinder / Cuboid / StretchedBody / ...）
 * - transformMatrix：4×4 矩阵，列主序，16 浮点（Round 5）
 * - color：R/G/B/A 4 通道，A 实际取 40 或 100（Round 6.3）
 */
export interface XmlModEntity {
  id: number;
  type: "simple";              // 当前样本全部为 simple
  visible: boolean;
  primitive: XmlModPrimitive;
  transformMatrix: number[];   // 长度 16，列主序
  color?: XmlModColor;         // 实测 100% 出现，但保留可选
}

/**
 * 14 类 primitive 的联合类型（Round 6）。
 *
 * 强类型覆盖 99.86%（11 类），3 类低样本（CircularGasket/RectangularFixedPlate/OffsetRectangularTable/RectangularRing）保留弱 schema fallback。
 */
export type XmlModPrimitive =
  | { type: "Cuboid"; l: number; w: number; h: number }
  | { type: "Cylinder"; r: number; h: number }
  | { type: "PorcelainBushing"; r: number; r1: number; r2: number; n: number; h: number }
  | { type: "StretchedBody"; array: [number, number][]; normal: [number, number, number]; l: number }
  | { type: "TruncatedCone"; /* 字段待 GIM 规范确认 */ raw: Record<string, string> }
  | { type: "Ring"; raw: Record<string, string> }
  | { type: "Sphere"; raw: Record<string, string> }
  | { type: "ChannelSteel"; raw: Record<string, string> }
  | { type: "Table"; raw: Record<string, string> }
  | { type: "TerminalBlock"; raw: Record<string, string> }
  | { type: "CircularGasket" | "RectangularFixedPlate" | "OffsetRectangularTable" | "RectangularRing"; raw: Record<string, string> };

/**
 * Color 节点，4 通道独立属性（非 Value 字符串）。
 */
export interface XmlModColor {
  r: number;  // 0-255
  g: number;  // 0-255
  b: number;  // 0-255
  a: number;  // 0-100（透明度百分比），实测 40 或 100
}

export interface XmlModGeometrySource {
  kind: "xml-mod";
  entities: XmlModEntity[];
  /** MOD 文件路径，用于缓存命中时按需读取 */
  modPath: string;
}
```

### 3.3 line-text-mod（线路 4 类文本格式族，Round 7）

```typescript
/**
 * 线路 MOD 文本格式族统一 IR。
 *
 * 按 format 分发到不同 records 类型，避免单一巨型 union。
 * records 字段保持 unknown[]，由消费方按 format cast。
 *
 * 设计权衡：
 * - 强类型 schema 已在 Round 7 §6.3 设计，但 IR 层不强制绑定具体类型
 * - 让 parser 层产出强类型（HNumModFile / PointLineModFile / ...），IR 仅引用
 * - 这样 schema 演进（如新增字段）不影响 IR 接口
 */
export interface LineTextModGeometrySource {
  kind: "line-text-mod";
  format: LineModFormat;
  modPath: string;
  /**
   * 按 format 分发的强类型记录数组：
   * - text-hnum-comma-record → HNumModFile
   * - text-point-line → PointLineModFile
   * - text-section-kv-record → BoltModFile
   * - text-key-value → TowerDeviceModFile | WireModFile
   *
   * IR 层保留 unknown，由消费方按 format 显式 cast。
   * 类型守卫见 §6。
   */
  records: unknown;
}
```

### 3.4 stl（STL 三角网格，Round 8）

```typescript
/**
 * STL 几何来源。
 *
 * 三样本 2066 个 STL 全部为 binary STL（Round 8.1）。
 * - 文件大小 = 84 + 50 * triangleCount
 * - 三角面含 12 个 float（normal + 3 vertices）+ 2 字节 attribute
 * - 法向量是否有效需运行时验证（部分导出工具置零）
 *
 * 不在 IR 中缓存字节流，保留 path 由 viewer 按需读取。
 */
export interface StlGeometrySource {
  kind: "stl";
  stlPath: string;
  format: "binary";              // 当前 100% binary，保留 "ascii" 扩展点
  triangleCount: number;
  /** STL header 80 字节内容（demo-substation 为 "name"，demo-line 为空白） */
  header?: string;
}
```

### 3.5 none（无几何分支）

```typescript
/**
 * 无几何来源（显式表达，避免 null 散落）。
 *
 * 用于：
 * - 变电 44 个 EMPTY_DEVICE_XML 孤儿 MOD（reason: empty-device-xml）
 * - 变电 14 个无 SOLIDMODEL 的空 PHM（reason: assembly-node-without-own-geometry，
 *   装配节点自身无几何但子设备几何完整；与 phm-no-solidmodel 区分）
 * - CBM 未声明 OBJECTMODELPOINTER（reason: cbm-no-objectmodelpointer）
 * - DEV 未引用 PHM（reason: dev-no-solidmodel）
 * - SOLIDMODEL 引用目标缺失（reason: phm-missing-target）
 * - 解析器暂不支持的 kind（reason: parser-unsupported）
 */
export interface NoneGeometrySource {
  kind: "none";
  reason: NoneReason;
  /** 可选详情，如解析错误消息或缺失路径 */
  detail?: string;
}
```

---

## 4. 上游 CBM → GeometrySource 解析管道

### 4.1 管道分层

```text
CBM 节点
  │
  │ 1. 提取 ENTITYNAME + OBJECTMODELPOINTER
  ▼
DEV 文件
  │
  │ 2. 递归收集 SOLIDMODEL → PHM / child DEV
  │    （加 visited 防环，最大深度 1，已知样本无环）
  ▼
PHM 文件集
  │
  │ 3. 提取每个 PHM 的 SOLIDMODELn + TRANSFORMMATRIXn + COLORn
  │    （验证 SOLIDMODELn 与 TRANSFORMMATRIXn 一一对应）
  ▼
SOLIDMODEL 引用列表（.ifc / .mod / .stl）
  │
  │ 4. 按扩展名分发：
  │    .ifc → IfcGeometrySource
  │    .mod → 按 MOD 内容分类（XML / 4 类文本 / EMPTY）
  │    .stl → StlGeometrySource
  ▼
GimGeometrySource[]
  │
  │ 5. 按 PHM 归属附加 TransformMatrix + Color
  ▼
GimGeometryInstance[]（带变换与颜色的实例）
```

### 4.2 GimGeometryInstance（附加变换与颜色）

```typescript
/**
 * 一个几何来源在某个 PHM 中的实例化（带变换矩阵与颜色）。
 *
 * 字段来源：
 * - source：来自 SOLIDMODEL 引用（§3 的 GimGeometrySource 之一）
 * - transformMatrix：来自 PHM 的 TRANSFORMMATRIXn（4×4 列主序，Round 5）
 *   - 已知三样本 PHM 矩阵 100% 为 IDENTITY（占位符）
 *   - 但 IR 设计保留非 IDENTITY 支持
 * - color：来自 PHM 的 COLORn
 *   - 线路样本：100% 非空（MOD 和 STL 引用都显式指定）
 *   - 变电样本：MOD 引用为空（依赖 MOD 自带 Color），STL 引用非空
 * - phmPath：归属 PHM 文件路径（用于多 PHM 联动追溯）
 */
export interface GimGeometryInstance {
  source: GimGeometrySource;
  /** 4×4 列主序变换矩阵，长度 16；缺失时为单位矩阵 */
  transformMatrix?: number[];
  /** PHM 层颜色（覆盖 MOD Entity 自带 Color） */
  color?: { r: number; g: number; b: number; a: number };
  /** 归属 PHM 路径 */
  phmPath: string;
  /** SOLIDMODEL 索引（PHM 内的第 N 个 SOLIDMODEL） */
  solidModelIndex: number;
}
```

### 4.3 CbmGeometryBundle（CBM 节点级聚合）

```typescript
/**
 * 一个 CBM 节点触达的全部几何实例。
 *
 * 一个 CBM 可能通过 OBJECTMODELPOINTER → DEV → 递归 SUBDEVICE → 多个 PHM →
 * 多个 SOLIDMODEL 引用，触达多个几何实例。
 *
 * 用于 UI 节点联动：点击 CBM 节点 → 高亮所有 instances。
 */
export interface CbmGeometryBundle {
  /** CBM 节点路径（唯一标识） */
  cbmPath: string;
  /** CBM entityName（如 "F4System" / "Tower_Device" / "CROSS"） */
  entityName: string;
  /** 触达的全部几何实例（来自该 CBM 链路下的所有 PHM） */
  instances: GimGeometryInstance[];
  /** 触达的 IFC modelId 集合（用于懒加载判断） */
  ifcModelIds: string[];
}
```

### 4.4 解析器入口签名

```typescript
/**
 * 从 CBM 节点构建 GimGeometrySource 集合的解析管道入口。
 *
 * 输入：
 * - cbmNode：CBM 树节点
 * - currentFiles：GIM 解压后的文件 Map（首次打开时持有，缓存命中时为 null）
 * - cachedPaths：缓存命中时的本地路径索引（IFC / MOD / STL 缓存路径）
 *
 * 输出：
 * - CbmGeometryBundle：该 CBM 触达的全部几何实例
 *
 * 异常处理：
 * - 单个 SOLIDMODEL 解析失败不阻塞其他引用，转为 { kind: "none", reason: "parse-failed", detail: err.message }
 * - 整体 CBM 链路异常（如 DEV 文件缺失）返回空 bundle + warning
 */
export interface GeometryParser {
  resolveBundle(
    cbmNode: CbmNode,
    context: GeometryParseContext,
  ): Promise<CbmGeometryBundle>;

  /** 批量解析，用于首屏全量构建 */
  resolveBundles(
    cbmTree: CbmNode,
    context: GeometryParseContext,
  ): Promise<Map<string, CbmGeometryBundle>>;
}

export interface GeometryParseContext {
  /** GIM 解压后的内存文件（首次打开时持有，缓存命中时为 null） */
  currentFiles: Map<string, File> | null;
  /** 缓存命中时的 IFC 本地路径索引 */
  cachedIfcPaths: Map<string, string>;
  /** 缓存命中时的 MOD/STL 本地路径索引（新增） */
  cachedGeometryPaths: Map<string, string>;
  /** 当前项目 ID（用于 Tauri SQLite 缓存读取） */
  projectId?: number;
}
```

---

## 5. 类型守卫与消费方约定

### 5.1 类型守卫

```typescript
export function isIfcSource(s: GimGeometrySource): s is Extract<GimGeometrySource, { kind: "ifc" }> {
  return s.kind === "ifc";
}

export function isXmlModSource(s: GimGeometrySource): s is Extract<GimGeometrySource, { kind: "xml-mod" }> {
  return s.kind === "xml-mod";
}

export function isLineTextModSource(s: GimGeometrySource): s is Extract<GimGeometrySource, { kind: "line-text-mod" }> {
  return s.kind === "line-text-mod";
}

export function isStlSource(s: GimGeometrySource): s is Extract<GimGeometrySource, { kind: "stl" }> {
  return s.kind === "stl";
}

export function isNoneSource(s: GimGeometrySource): s is Extract<GimGeometrySource, { kind: "none" }> {
  return s.kind === "none";
}
```

### 5.2 消费方约定

```text
Viewer 层（Three.js / OBC）：
  - 遍历 CbmGeometryBundle.instances
  - 按 source.kind 分发到不同 loader：
      ifc       → 复用现有 ifcLoader.ts（无需改动）
      xml-mod   → 新增 xmlModLoader.ts（按 primitive 类型构建 THREE.Mesh）
      line-text-mod → 新增 lineModLoader.ts（按 format 分发）
      stl       → 新增 stlLoader.ts（THREE.STLLoader 或等价实现）
      none      → 跳过，仅日志
  - 应用 transformMatrix 到每个 instance
  - 应用 color（若 PHM 层提供，覆盖 source 自带 color）

UI 层（属性面板 / 树节点）：
  - 点击 CBM 节点 → 高亮 bundle.instances
  - 属性面板按 source.kind 展示不同字段：
      ifc → IFC 原生属性（既有）
      xml-mod → Entity ID + primitive 参数 + Color + Transform
      line-text-mod → 按 format 展示（HNum 杆塔分段 / Bolt 螺栓表 / ...）
      stl → 三角面数 + 文件大小 + format
      none → 显示 reason + detail（提示用户该节点无几何）

缓存层（SQLite）：
  - IR 文档只定义内存数据结构（§2-§4 的 TypeScript interface）
  - SQLite geometry_source 表仅作为缓存实现建议，不是 IR 的一部分
  - 现有 ifc_model / cbm_node 表保留
  - 缓存命中时如需恢复非 IFC 几何 IR，建议新增 geometry_source 表（可选）：
      cbm_path TEXT,
      solid_model_index INTEGER,
      kind TEXT,           -- 'ifc' / 'xml-mod' / 'line-text-mod' / 'stl' / 'none'
      format TEXT,         -- 仅 line-text-mod 用
      mod_path TEXT,       -- 仅 xml-mod / line-text-mod 用
      stl_path TEXT,       -- 仅 stl 用
      triangle_count INTEGER, -- 仅 stl 用
      reason TEXT          -- 仅 none 用
  - 缓存命中时直接从 SQLite 恢复 IR，无需重新解析 MOD/STL
  - 正式 DDL（含 PARSER_VERSION 升级、数据迁移、索引设计）
    应另起 `14-geometry-cache-schema.md` 或放入实现设计文档，不在本 IR 范围
```

---

## 6. 现有 gim_viewer 缺陷与 IR 补齐路径

### 6.1 缺陷对照表

| # | 缺陷 | 当前实现 | IR 补齐路径 |
| - | ---- | -------- | ----------- |
| 1 | 变电 4135 个 XML_WITH_ENTITIES MOD 未渲染 | 仅 IFC 主路径 | `xml-mod` kind + `XmlModEntity[]` + xmlModLoader |
| 2 | 变电 1803 个 STL 未渲染 | 仅 IFC | `stl` kind + stlLoader（先做 30 个 STL-only，再评估 86 个 STL+MOD 并存） |
| 3 | 变电 44 个 EMPTY_DEVICE_XML 孤儿未提示 | 静默忽略 | `none` kind + `reason: "empty-device-xml"`，UI 显示提示 |
| 4 | 变电 14 个无 SOLIDMODEL 的 PHM 未提示 | 静默忽略 | `none` kind + `reason: "assembly-node-without-own-geometry"`（装配节点自身无几何但子设备几何完整） |
| 5 | 线路 31 个 TEXT_HNUM 杆塔骨架未渲染 | 仅塔位点 | `line-text-mod` format=`text-hnum-comma-record` + HNum parser |
| 6 | 线路 315 个 CROSS 经纬度点线无 3D 表达 | 仅 2D 地图叠加 | `line-text-mod` format=`text-point-line`（保留地图为主，3D 可选） |
| 7 | 线路 1300 个螺栓表未展示 | 完全缺失 | `line-text-mod` format=`text-section-kv-record` + 属性面板 |
| 8 | 线路 161 个基础/导线参数未展示 | 完全缺失 | `line-text-mod` format=`text-key-value` + 属性面板 |
| 9 | 线路 181 个 Tower_Device STL 未渲染 | 完全缺失 | `stl` kind（Tower_Device 62% STL 分支） |
| 10 | 线路 11773 个 Wire_Device STL 未渲染 | 完全缺失 | `stl` kind（Wire_Device 100% STL） |
| 11 | PHM COLOR 字段未参与展示 | 完全缺失 | `GimGeometryInstance.color` 字段，覆盖 MOD Entity 自带 Color |
| 12 | PHM TransformMatrix 未应用 | 完全缺失 | `GimGeometryInstance.transformMatrix` 字段（已知 100% IDENTITY，但保留） |
| 13 | 缓存命中时无法回放非 IFC 几何 | 仅 IFC | `cachedGeometryPaths` 字段 + `geometry_source` 表（可选） |
| 14 | 节点联动仅 IFC 高亮 | 仅 IFC | `CbmGeometryBundle.instances` 高亮所有 kind |
| 15 | 属性显示不正确（缺 Bolt/HNum/WIRE 参数） | 仅 CBM/FAM/DEV | 按 `format` 分发到不同属性面板组件 |

### 6.2 补齐优先级

```text
P0（MVP 必补，影响核心展示能力）：
  - #1 xml-mod 渲染（变电主路径补齐，覆盖 4135 MOD）
  - #5 text-hnum-comma-record 渲染（线路杆塔骨架，覆盖 31 MOD）
  - #7 text-section-kv-record 属性面板（线路螺栓表，覆盖 1300 MOD）
  - #8 text-key-value 属性面板（线路基础/导线参数，覆盖 161 MOD）
  - #15 属性显示按 format 分发

P1（MVP 可选，影响 STL 展示能力）：
  - #2 stl 渲染（变电 1803 STL，建议先做 30 个 STL-only）
  - #9 + #10 线路 STL 渲染（181 Tower_Device + 11773 Wire_Device）
  - #11 PHM COLOR 应用

P2（体验补齐）：
  - #3 + #4 none 分支 UI 提示
  - #6 CROSS 3D 表达（保留地图为主）
  - #12 PHM TransformMatrix 应用（已知 100% IDENTITY）
  - #13 缓存命中回放
  - #14 节点联动多 kind 高亮
```

---

## 7. 实现路径建议

### 7.1 分阶段实施

```text
阶段 1（IR schema 落地，不写渲染）：
  - 新增 src/gim/geometry/ir.ts（IR 类型定义）
  - 新增 src/gim/geometry/irBuilder.ts（CBM → CbmGeometryBundle 解析管道）
  - 单元测试：3 个 demo 样本全量构建 IR，验证 kind 分布与 Round 1-8 统计一致
  - 不修改现有 ifcLoader.ts，仅新增

阶段 2（xml-mod 渲染，P0）：
  - 新增 src/viewer/xmlModLoader.ts
  - 按 XmlModPrimitive 联合类型分发：
      Cuboid / Cylinder / PorcelainBushing → THREE 几何体
      StretchedBody → THREE.ExtrudeGeometry
      其他 9 类 → 弱 schema fallback（暂用 BoxGeometry 占位）
  - 应用 TransformMatrix + Color
  - 接入 CbmGeometryBundle 高亮链路

阶段 3（line-text-mod 属性面板，P0）：
  - 新增 src/gim/lineMod/ 下的 4 个 parser：
      hnumParser.ts → HNumModFile
      pointLineParser.ts → PointLineModFile
      sectionKvParser.ts → BoltModFile
      keyValueParser.ts → TowerDeviceModFile | WireModFile
  - 新增 src/ui/lineModPropsView.ts（按 format 分发到不同展示组件）
  - 属性面板集成

阶段 4（text-hnum-comma-record 渲染，P0）：
  - 新增 src/viewer/hnumModLoader.ts
  - P 节点 → THREE.Vector3
  - R 杆件 → THREE.LineSegments（线框骨架）
  - R 杆件实体化（可选）→ 按 spec 查型号表
  - G 挂点 → THREE.Points

阶段 5（stl 渲染，P1）：
  - 新增 src/viewer/stlLoader.ts
  - 使用 THREE.STLLoader 或等价实现
  - 优先加载 30 个 STL-only（变电 + 线路 Wire_Device 小模型）
  - 评估 86 个变电 STL+MOD 并存 PHM 是否重复

阶段 6（缓存命中回放，P2）：
  - SQLite 新增 geometry_source 表（PARSER_VERSION 升级）
  - gimIndexPersistenceService 增加 MOD/STL 路径持久化
  - gimIndexRestoreService 增加 IR 恢复逻辑

阶段 7（none 分支提示，P2）：
  - UI 显示无几何节点的 reason
  - 诊断快捷键 Ctrl+Shift+D 输出 IR 统计
```

### 7.2 风险点

```text
1. xml-mod primitive 14 类中，9 类字段未在 Round 6 完全拆解
   - 阶段 2 实施时需补充字段分析（特别是 TruncatedCone / Ring / ChannelSteel）
   - 临时方案：弱 schema fallback 用 BoxGeometry 占位

2. text-hnum-comma-record 的 R 记录 9 token 变体（2 条）样本不足
   - 阶段 4 实施时保留 RRecordUnknown 弱 schema，不强行解析

3. 86 个变电 STL+MOD 并存 PHM 是否描述同一几何
   - 阶段 5 实施前需采样 86 个 PHM 的 STL/MOD bounding box 比对
   - 若重复：仅加载 MOD，跳过 STL
   - 若不重复：可同时渲染

4. 线路 PHM TransformMatrix 已知 100% IDENTITY
   - 阶段 2-5 实施时可直接忽略 TransformMatrix
   - 但 IR 设计保留字段，避免未来样本出现非 IDENTITY 时返工

5. PARSER_VERSION 升级会失效所有现有缓存
   - 阶段 6 实施时需提示用户重新解压 GIM
   - 或提供数据迁移脚本（从旧 cbm_node 表推导 geometry_source）
   - geometry_source 表的正式 DDL 不在本 IR 范围，应另起 14-geometry-cache-schema.md（见 §1.3 和 §5.2）

6. 内存占用
   - 4135 个变电 XML MOD 全量解析可能占用大量内存
   - 建议按需懒加载（点击节点时才解析对应 PHM 的 SOLIDMODEL）
   - IR 设计已支持懒加载（modPath 保留引用，按需读取）

7. 线路 11773 个 Wire_Device STL 引用（实际 8 unique STL）
   - 阶段 5 实施时需建立几何缓存池（同内容 STL 只加载 1 次）
   - 或按 stlPath 去重，避免重复解析
```

---

## 8. 当前不能得出的结论

```text
1. xml-mod 9 类低样本 primitive 的精确字段
   - TruncatedCone / Ring / Sphere / ChannelSteel / Table / TerminalBlock
   - 需在阶段 2 实施前补充字段分析（可作为 Round 6.5）

2. 86 个变电 STL+MOD 并存 PHM 是否描述同一几何
   - 需采样 bounding box 比对（可作为 Round 8.5）

3. text-hnum-comma-record 的 R 记录 9 token 变体字段语义
   - 仅 2 条样本，需采集更多线路样本验证

4. text-point-line 的 CODE 字段业务含义
   - 7 种 CODE 取值，无 GIM 规范对照
   - 不影响 IR 设计（CODE 保留为 string），但影响 UI 展示

5. 缓存命中时的 geometry_source 表 schema 设计
   - 本 IR 仅给出字段建议（见 §5.2），未做正式 SQLite DDL
   - 需结合现有 cbm_node 表结构设计，避免冗余
   - 正式 DDL 应另起 14-geometry-cache-schema.md，不在本 IR 范围（见 §1.3）

6. IR 是否需要支持几何变换的"组合"（如多 PHM 共享同一 MOD 的不同变换）
   - 已知 MOD 在线路样本最大复用 70 次
   - 当前 IR 设计通过 GimGeometryInstance 表达（同 source 多 instance）
   - 但内存优化策略（如 InstancedMesh）由 viewer 层决定，不在 IR 范围

7. line-text-mod 的 records 字段是否应强类型化
   - 当前设计为 unknown，由消费方 cast
   - 替代方案：IR 直接持有强类型（HNumModFile | PointLineModFile | ...）
   - 但会引入 schema 演进耦合（Round 7 schema 变更影响 IR）
   - 建议：parser 层产出强类型，IR 层保留 unknown，由类型守卫保护消费

8. none 分支的 reason 是否需要扩展
   - 当前 8 种 reason 覆盖已知场景
   - 新样本可能引入新 reason（如 "ifc-guid-missing"）
   - reason 字段保留 string 扩展点，NoneReason 枚举不强制闭合
```

---

## 9. 与既有代码的兼容性

### 9.1 不破坏现有 IFC 主路径

```text
现有路径：
  CBM 节点 → ifcFile/ifcGuid → ifcLoader → OBC Fragments → 高亮

IR 兼容路径：
  CBM 节点 → irBuilder → CbmGeometryBundle
    → instances.find(isIfcSource) → 复用现有 ifcLoader
    → instances.find(isXmlModSource) → 新增 xmlModLoader
    → ...

阶段 1 实施 IR 时，不修改 ifcLoader.ts，仅在 irBuilder 中调用现有 IfcEntry。
```

### 9.2 与既有 CbmNode 类型的关系

```typescript
// 既有 src/gim/types.ts
export interface CbmNode {
  path: string;
  name: string;
  entityName: string;
  children: CbmNode[];
  famPath: string;
  devPath: string;
  ifcFile: string;       // 保留，IR 不替代
  ifcGuid: string;       // 保留，IR 不替代
  classifyName: string;
  transformMatrix: string;
}

// IR 不修改 CbmNode，仅在解析时消费：
// - path → 用于 CbmGeometryBundle.cbmPath
// - entityName → 用于 CbmGeometryBundle.entityName
// - devPath → 用于定位 DEV 文件，启动解析管道
// - ifcFile / ifcGuid → 用于构建 IfcGeometrySource（向后兼容）
```

### 9.3 与既有 AppState 的关系

```typescript
// 既有 src/app/state.ts
export interface AppState {
  // ... 现有字段
  currentIfcEntries: IfcEntry[];      // 保留
  cachedIfcPaths: Map<string, string>; // 保留
  loadedModels: Set<string>;          // 保留
  // ... 新增字段（阶段 6）
  geometryBundles?: Map<string, CbmGeometryBundle>; // IR 缓存
  cachedGeometryPaths?: Map<string, string>;        // MOD/STL 本地缓存路径
}
```

---

## 10. 附录 A：完整 TypeScript schema 草案

> 以下代码块为可直接落地到 `src/gim/geometry/ir.ts` 的完整草案。

```typescript
// src/gim/geometry/ir.ts

/**
 * GIM 统一 Geometry IR。
 *
 * 设计依据：docs/schema/13-geometry-ir-schema.md
 * 不绑定 UI / Three.js / OBC。
 */

// ============ 顶层联合类型 ============

export type GimGeometrySource =
  | IfcGeometrySource
  | XmlModGeometrySource
  | LineTextModGeometrySource
  | StlGeometrySource
  | NoneGeometrySource;

// ============ ifc ============

export interface IfcGeometrySource {
  kind: "ifc";
  ifcFile: string;
  ifcGuid?: string;
  modelId: string;
  cachedPath?: string;
}

// ============ xml-mod ============

export interface XmlModGeometrySource {
  kind: "xml-mod";
  entities: XmlModEntity[];
  modPath: string;
}

export interface XmlModEntity {
  id: number;
  type: "simple";
  visible: boolean;
  primitive: XmlModPrimitive;
  transformMatrix: number[];  // 长度 16，列主序
  color?: XmlModColor;
}

export type XmlModPrimitive =
  | { type: "Cuboid"; l: number; w: number; h: number }
  | { type: "Cylinder"; r: number; h: number }
  | {
      type: "PorcelainBushing";
      r: number; r1: number; r2: number; n: number; h: number;
    }
  | {
      type: "StretchedBody";
      array: [number, number][];
      normal: [number, number, number];
      l: number;
    }
  | {
      type:
        | "TruncatedCone"
        | "Ring"
        | "Sphere"
        | "ChannelSteel"
        | "Table"
        | "TerminalBlock"
        | "CircularGasket"
        | "RectangularFixedPlate"
        | "OffsetRectangularTable"
        | "RectangularRing";
      raw: Record<string, string>;
    };

export interface XmlModColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

// ============ line-text-mod ============

export type LineModFormat =
  | "text-hnum-comma-record"
  | "text-point-line"
  | "text-section-kv-record"
  | "text-key-value";

export interface LineTextModGeometrySource {
  kind: "line-text-mod";
  format: LineModFormat;
  modPath: string;
  /** 按 format 分发的强类型记录（HNumModFile / PointLineModFile / BoltModFile / TowerDeviceModFile | WireModFile） */
  records: unknown;
}

// ============ stl ============

export interface StlGeometrySource {
  kind: "stl";
  stlPath: string;
  format: "binary";
  triangleCount: number;
  header?: string;
}

// ============ none ============

export type NoneReason =
  | "empty-device-xml"
  | "phm-no-solidmodel"
  | "assembly-node-without-own-geometry"
  | "phm-missing-target"
  | "cbm-no-objectmodelpointer"
  | "dev-no-solidmodel"
  | "parser-unsupported"
  | "parse-failed"
  | "unknown";

export interface NoneGeometrySource {
  kind: "none";
  reason: NoneReason;
  detail?: string;
}

// ============ 实例化与聚合 ============

export interface GimGeometryInstance {
  source: GimGeometrySource;
  transformMatrix?: number[];
  color?: { r: number; g: number; b: number; a: number };
  phmPath: string;
  solidModelIndex: number;
}

export interface CbmGeometryBundle {
  cbmPath: string;
  entityName: string;
  instances: GimGeometryInstance[];
  ifcModelIds: string[];
}

// ============ 类型守卫 ============

export function isIfcSource(s: GimGeometrySource): s is IfcGeometrySource {
  return s.kind === "ifc";
}

export function isXmlModSource(s: GimGeometrySource): s is XmlModGeometrySource {
  return s.kind === "xml-mod";
}

export function isLineTextModSource(
  s: GimGeometrySource,
): s is LineTextModGeometrySource {
  return s.kind === "line-text-mod";
}

export function isStlSource(s: GimGeometrySource): s is StlGeometrySource {
  return s.kind === "stl";
}

export function isNoneSource(s: GimGeometrySource): s is NoneGeometrySource {
  return s.kind === "none";
}

// ============ 解析器接口 ============

export interface GeometryParseContext {
  currentFiles: Map<string, File> | null;
  cachedIfcPaths: Map<string, string>;
  cachedGeometryPaths: Map<string, string>;
  projectId?: number;
}

export interface GeometryParser {
  resolveBundle(
    cbmNode: import("../types.js").CbmNode,
    context: GeometryParseContext,
  ): Promise<CbmGeometryBundle>;

  resolveBundles(
    cbmTree: import("../types.js").CbmNode,
    context: GeometryParseContext,
  ): Promise<Map<string, CbmGeometryBundle>>;
}
```

---

## 11. 附录 B：Round 1-8 关键发现汇总

> 本节汇总前 8 轮分析对 IR 设计的关键约束，便于追溯。

| Round | 主题 | 对 IR 的约束 |
| ----- | ---- | ----------- |
| 1 | 容器结构 + 文件清单 | 无直接影响（IR 不处理解压） |
| 2 | 引用链 + 完整性 | IR 需表达"硬缺失"（NoneReason=`phm-missing-target`） |
| 3 | 几何可达性 | IR 需表达"孤儿"（NoneReason=`cbm-no-objectmodelpointer` / `dev-no-solidmodel`） |
| 4 | MOD 静态分型 | IR 的 `kind` 字段直接对应 6 类分型（xml-mod / line-text-mod 4 类 / none） |
| 5 | PHM 与 MOD 变换链 | `GimGeometryInstance.transformMatrix` 字段（PHM 层矩阵，已知 100% IDENTITY） |
| 6 | 变电 XML primitive | `XmlModPrimitive` 联合类型（14 类，11 强类型 + 3 弱 schema）+ `XmlModColor`（R/G/B/A 4 通道） |
| 7 | 线路 MOD 文本格式族 | `LineModFormat` 4 类 + 强类型 records（HNumModFile / PointLineModFile / BoltModFile / TowerDeviceModFile | WireModFile） |
| 8 | STL 静态角色 | `StlGeometrySource`（100% binary，含 triangleCount）+ entityName 分发策略（Wire_Device / Tower_Device / F4System / PARTINDEX） |

---

## 12. 附录 C：与既有文档的引用关系

```text
13-geometry-ir-schema.md
  ├─ 引用 02-gim-file-inventory.md（STL 文件清单）
  ├─ 引用 03-gim-file-role-matrix.md（STL 角色）
  ├─ 引用 05-gim-reference-integrity.md（NoneReason=phm-missing-target）
  ├─ 引用 07-dev-phm-geometry-reachability.md（NoneReason=cbm-no-objectmodelpointer / dev-no-solidmodel）
  ├─ 引用 08-mod-static-survey.md（MOD 6 类分型 → IR kind 分发）
  ├─ 引用 09-transform-chain-analysis.md（GimGeometryInstance.transformMatrix）
  ├─ 引用 10-substation-mod-grammar.md（XmlModPrimitive + XmlModColor）
  ├─ 引用 11-line-mod-grammar.md（LineModFormat + 强类型 records）
  └─ 引用 12-stl-static-survey.md（StlGeometrySource + entityName 分发策略）
```
