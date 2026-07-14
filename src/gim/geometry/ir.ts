/**
 * GIM 几何来源的统一中间表示（IR）。
 *
 * 一个 CBM 节点（或一个 PHM 引用）对应一个 GimGeometrySource。
 * 解析器按 SOLIDMODEL 扩展名 + MOD 内容分发到对应 kind。
 *
 * 设计原则：
 * - 联合类型分发，避免巨型 interface
 * - 每个 kind 自带最小必要字段，不复制原始文件内容
 * - 大字段保留 path 引用，由 viewer 按需读取
 * - none 分支显式表达"无几何"，避免 null 散落
 *
 * 顶层联合类型引用各 kind 的 interface（非 inline union），
 * 与 docs/schema/13-geometry-ir-schema.md §2.1 保持一致。
 */

// ============================================================================
// §1 顶层联合类型
// ============================================================================

export type GimGeometrySource =
  | IfcGeometrySource
  | XmlModGeometrySource
  | LineTextModGeometrySource
  | StlGeometrySource
  | NoneGeometrySource;

// ============================================================================
// §2 各 kind 详细 interface
// ============================================================================

/**
 * IFC 几何来源（既有主路径，变电 F4System 设备构件）。
 *
 * 与 src/gim/types.ts 的 IfcEntry 互补：IfcEntry 描述文件入口，
 * IfcGeometrySource 描述 IR 中的几何来源。
 */
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

/**
 * 变电 XML MOD 几何来源（14 类 primitive）。
 *
 * 详见 docs/schema/10-substation-mod-grammar.md。
 */
export interface XmlModGeometrySource {
  kind: "xml-mod";
  entities: XmlModEntity[];
  /** MOD 文件路径，用于缓存命中时按需读取 */
  modPath: string;
}

/**
 * 线路 MOD 文本格式族（4 类）。
 *
 * 详见 docs/schema/11-line-mod-grammar.md。
 * 4 类格式族均强类型化（详见 §7.2 判定结果），R 9 token 罕见变体保留弱 schema fallback。
 */
export interface LineTextModGeometrySource {
  kind: "line-text-mod";
  format: LineModFormat;
  modPath: string;
  /**
   * 按 format 分发的强类型记录（联合类型）。
   * - text-hnum-comma-record → HNumModFile
   * - text-point-line → PointLineModFile
   * - text-section-kv-record → BoltModFile
   * - text-key-value → KeyValueModFile（TowerDeviceModFile | WireModFile）
   */
  records: LineModRecords;
}

/** 线路 MOD 4 类格式族解析结果联合类型 */
export type LineModRecords =
  | HNumModFile
  | PointLineModFile
  | BoltModFile
  | KeyValueModFile;

/**
 * STL 三角网格几何来源（binary STL）。
 *
 * 详见 docs/schema/12-stl-static-survey.md。
 */
export interface StlGeometrySource {
  kind: "stl";
  stlPath: string;
  format: "binary";
  triangleCount: number;
  /** STL header 80 字节内容（demo-substation 为 "name"，demo-line 为空白） */
  header?: string;
}

/**
 * 无几何来源（显式表达，避免 null 散落）。
 *
 * reason 区分两种"无几何"语义：
 * - phm-no-solidmodel：PHM 无 SOLIDMODEL 字段（底层事实状态）
 * - assembly-node-without-own-geometry：装配节点自身无几何但子设备几何完整
 */
export interface NoneGeometrySource {
  kind: "none";
  reason: NoneReason;
  /** 可选详情，如解析错误消息或缺失路径 */
  detail?: string;
}

// ============================================================================
// §3 辅助枚举类型
// ============================================================================

/**
 * "无几何"原因分类，用于 UI 提示与诊断。
 */
export type NoneReason =
  | "empty-device-xml" // 变电 EMPTY_DEVICE_XML（44 个，未参与渲染但应提示）
  | "phm-no-solidmodel" // PHM 无 SOLIDMODEL 字段（底层事实状态）
  | "assembly-node-without-own-geometry" // 装配节点自身无几何但子设备几何完整（变电 14 个 PHM）
  | "phm-missing-target" // SOLIDMODEL 引用目标缺失（硬缺失）
  | "cbm-no-objectmodelpointer" // CBM 未声明 OBJECTMODELPOINTER
  | "dev-no-solidmodel" // DEV 未引用任何 PHM
  | "parser-unsupported" // 解析器暂不支持该 kind（保留扩展点）
  | "parse-failed" // 解析失败（具体错误由 reason 详情携带）
  | "unknown"; // 未分类

/**
 * 线路 MOD 4 类文本格式族（docs/schema/11-line-mod-grammar.md）。
 *
 * 4 类格式族已落地 parser（src/gim/geometry/lineModParser.ts）。
 */
export type LineModFormat =
  | "text-hnum-comma-record" // 杆塔主体分段构件
  | "text-point-line" // 经纬度点线（CROSS）
  | "text-section-kv-record" // 螺栓参数表
  | "text-key-value"; // 杆塔基础参数 / 导线参数

// ============================================================================
// §4 xml-mod 详细子类型
// ============================================================================

/**
 * 变电 XML MOD 的单个 Entity（对应 <Entity> 元素）。
 *
 * 字段来源（docs/schema/10-substation-mod-grammar.md §6.4）：
 * - id / type / visible：Entity 属性
 * - primitive：14 类 primitive 之一
 * - transformMatrix：4×4 矩阵，列主序，16 浮点
 * - color：R/G/B/A 4 通道，A 实际取 40 或 100
 */
export interface XmlModEntity {
  id: number;
  type: "simple"; // 当前样本全部为 simple
  visible: boolean;
  primitive: XmlModPrimitive;
  transformMatrix: number[]; // 长度 16，列主序
  color?: XmlModColor; // 实测 100% 出现，但保留可选
}

/**
 * 14 类 primitive 的联合类型。
 *
 * 11 类强类型覆盖 99.86%（docs/schema/10-substation-mod-grammar.md §6.3）。
 * 3 类低样本（RectangularFixedPlate / OffsetRectangularTable / RectangularRing）
 * 保留弱 schema fallback（raw: Record<string, string>）。
 */
export type XmlModPrimitive =
  | { type: "Cuboid"; l: number; w: number; h: number }
  | { type: "Cylinder"; r: number; h: number }
  | { type: "PorcelainBushing"; r: number; r1: number; r2: number; n: number; h: number }
  | { type: "StretchedBody"; l: number; array: string; normal: string }
  | { type: "TruncatedCone"; br: number; tr: number; h: number }
  | { type: "Ring"; r: number; dr: number; rad: number }
  | { type: "TerminalBlock"; l: number; w: number; h?: number; t: number; r: number; bl: number; cl: number; cs: number; rs: number; cn: number; rn: number; phase: string }
  | { type: "Sphere"; r: number }
  | { type: "ChannelSteel"; l: number; model: string; d?: number; h?: number; b?: number; t?: number }
  | { type: "Table"; h: number; ll1: number; ll2: number; tl1: number; tl2: number }
  | { type: "CircularGasket"; h: number; rad: number; or: number; ir: number }
  | {
      type: "RectangularFixedPlate" | "OffsetRectangularTable" | "RectangularRing";
      raw: Record<string, string>;
    };

/**
 * Color 节点，4 通道独立属性（非 Value 字符串）。
 *
 * A 为 0-100 百分制透明度，实测 40 或 100。
 */
export interface XmlModColor {
  r: number; // 0-255
  g: number; // 0-255
  b: number; // 0-255
  a: number; // 0-100（透明度百分比）
}

// ============================================================================
// §4b line-text-mod 详细子类型（4 类格式族）
// ============================================================================

// ─── TEXT_HNUM_COMMA_RECORD：杆塔主体分段构件 ─────────────────────────────

/** H 记录：档位标高 + 归属 Body/Leg */
export interface HRecord {
  /** 档位标高（mm） */
  height: number;
  /** 归属体段（"Body1".."BodyN"） */
  body: string;
  /** 归属腿（"Leg1".."LegN"） */
  leg: string;
}

/** P 记录：节点笛卡尔坐标（局部坐标，毫米） */
export interface PRecord {
  id: number;
  x: number;
  y: number;
  z: number;
}

/**
 * R 记录联合类型（三变体）。
 * - angle（11 token，99.79%）：角钢，含双方向单位向量
 * - tube（5 token，0.21%）：钢管，规格前缀 `φ`
 * - unknown（9 token 罕见变体 + 兜底）：保留原始记录文本
 */
export type RRecord = RRecordAngle | RRecordTube | RRecordUnknown;

/** R 记录角钢变体（11 token） */
export interface RRecordAngle {
  kind: "angle";
  /** 起点节点 id（引用 P.id） */
  id1: number;
  /** 终点节点 id */
  id2: number;
  /** 规格（"L140X12" 等） */
  spec: string;
  /** 材质（"Q235" / "Q355" / "Q420"） */
  material: string;
  /** 第一方向单位向量 */
  dir1: [number, number, number];
  /** 第二方向单位向量 */
  dir2: [number, number, number];
}

/** R 记录钢管变体（5 token） */
export interface RRecordTube {
  kind: "tube";
  id1: number;
  id2: number;
  /** 规格（"φ325.000000X6.000000" 等） */
  spec: string;
  material: string;
}

/** R 记录未知变体（9 token 罕见 + 兜底） */
export interface RRecordUnknown {
  kind: "unknown";
  /** 保留原始记录文本，供后续样本扩展 */
  raw: string;
}

/** G 记录：导线/地线挂点 */
export interface GRecord {
  /** 挂点类型（"G"=地线，"C"=导线） */
  type: string;
  /** 挂点名称（"后地1" 等） */
  name: string;
  x: number;
  y: number;
  z: number;
}

/** HSubLeg 记录：子腿高度偏移（负值序列递增到 0） */
export interface HSubLegRecord {
  /** 子腿序号（1..N） */
  index: number;
  /** 高度偏移（mm） */
  offset: number;
}

/** HLeg 记录：腿顶坐标（X/Y 平面投影） */
export interface HLegRecord {
  /** 腿序号（1..N） */
  index: number;
  x: number;
  y: number;
}

/** Body 段：含参考标高 + P/R/G 记录组 */
export interface BodySection {
  /** 体段标识（"Body1".."BodyN"） */
  name: string;
  /** 体段参考标高（mm，来自 HBodyN 行；缺失为 undefined） */
  hBody?: number;
  points: PRecord[];
  rods: RRecord[];
  groundPoints: GRecord[];
}

/** TEXT_HNUM_COMMA_RECORD 解析结果（杆塔主体分段构件） */
export interface HNumModFile {
  /** 档位总数 */
  hNum: number;
  /** H 记录列表（长度等于 hNum） */
  hRecords: HRecord[];
  /** Body 段列表 */
  bodySections: BodySection[];
  /** 子腿高度偏移序列 */
  hSubLegs: HSubLegRecord[];
  /** 腿顶坐标序列 */
  hLegs: HLegRecord[];
}

// ─── TEXT_POINT_LINE：经纬度点线表（CROSS） ───────────────────────────────

/** POINT 记录：经纬度点（WGS84） */
export interface PointRecord {
  id: number;
  /** 纬度（度） */
  lat: number;
  /** 经度（度） */
  lon: number;
  /** 高程（米） */
  alt: number;
  /** 点类型（"13" / "42" 等，保留 string） */
  type: string;
}

/** LINE 记录：有向边（引用 POINT.id） */
export interface LineRecord {
  fromId: number;
  toId: number;
}

/** TEXT_POINT_LINE 解析结果（经纬度点线表） */
export interface PointLineModFile {
  /** 业务码（"201" / "30" 等，保留 string） */
  code: string;
  pointNum: number;
  lineNum: number;
  points: PointRecord[];
  lines: LineRecord[];
}

// ─── TEXT_SECTION_KV_RECORD：螺栓参数表 ───────────────────────────────────

/** 螺栓位置（第 2 段，分号后 4 token） */
export interface BoltPosition {
  /** 方位码（210 等） */
  code: number;
  x: number;
  y: number;
  z: number;
}

/** Bolt 记录：螺栓参数 + 法兰盘坐标 */
export interface BoltRecord {
  /** 序号（1..boltNum） */
  index: number;
  /** 螺栓规格（"M64"） */
  spec: string;
  /** 螺栓长度（mm） */
  length: number;
  /**
   * 第 1 段其他字段（位置 3-12，共 10 个 token）。
   * 11 号文档 §4.3.2 已确认字段 1-3（spec/length/grade），
   * 字段 4-12 含义待 GIM 官方规范确认，保留原始字符串数组。
   * 索引 0 = grade, 1 = d1, 2 = d2, 3 = type, 4 = flag1,
   * 5 = d3, 6 = d4, 7 = d5, 8 = flag2, 9 = angle
   */
  restFields: string[];
  /** 螺栓位置（第 2 段） */
  position: BoltPosition;
}

/** TEXT_SECTION_KV_RECORD 解析结果（螺栓参数表） */
export interface BoltModFile {
  /** section header（恒为 "Bolt"） */
  section: "Bolt";
  /** 螺栓总数（4 或 8） */
  boltNum: number;
  /** 螺栓记录列表 */
  bolts: BoltRecord[];
}

// ─── TEXT_KEY_VALUE：Tower_Device / WIRE 二分 ────────────────────────────

/** TEXT_KEY_VALUE 联合类型（按签名分发，未识别签名走 UnknownKvModFile 兜底） */
export type KeyValueModFile = TowerDeviceModFile | WireModFile | UnknownKvModFile;

/** Tower_Device 基础参数（签名 1：全小写 key） */
export interface TowerDeviceModFile {
  signature: "type,H1,H2,H3,H4,d,e1,e2";
  /** 基础类型（中文） */
  type: string;
  H1: number;
  H2: number;
  H3: number;
  H4: number;
  /** 基础直径（小写） */
  d: number;
  /** 基础直径（大写，可能表示顶径；未在签名中但实测全部出现，可选） */
  D?: number;
  e1: number;
  e2: number;
}

/** WIRE 导线参数（签名 2：全大写 key） */
export interface WireModFile {
  signature: "TYPE,SECTIONALAREA,OUTSIDEDIAMETER,WIREWEIGHT,COEFFICIENTOFELASTICITY,EXPANSIONCOEFFICIENTOFWIRE,RATEDSTRENGTH";
  /** 导线型号 */
  TYPE: string;
  /** 截面面积（mm²） */
  SECTIONALAREA: number;
  /** 外径（mm） */
  OUTSIDEDIAMETER: number;
  /** 单位重量（kg/km） */
  WIREWEIGHT: number;
  /** 弹性系数（MPa） */
  COEFFICIENTOFELASTICITY: number;
  /** 线膨胀系数（1/°C × 10⁻⁶） */
  EXPANSIONCOEFFICIENTOFWIRE: number;
  /** 额定拉断力（N） */
  RATEDSTRENGTH: number;
}

/**
 * 未识别签名的 TEXT_KEY_VALUE 兜底类型（弱 schema）。
 *
 * 11 号文档 §7.4：若新样本出现未识别 key set 签名，应保留 Record<string, string> 弱 schema，不阻塞解析。
 * 实测 demo-line / demo-line1 全部命中签名 1 或 2，此类型为前瞻性兜底。
 */
export interface UnknownKvModFile {
  signature: "unknown";
  /** 原始 key 集合（排序后逗号拼接，用于诊断） */
  keySignature: string;
  /** 弱 schema KV 字典 */
  raw: Record<string, string>;
}

// ============================================================================
// §5 PHM 解析中间产物（Phase 2 使用）
// ============================================================================

/**
 * PHM 中单个 SOLIDMODEL 引用条目。
 *
 * SOLIDMODELn / TRANSFORMMATRIXn / COLORn 三者通过 index 一一对应。
 */
export interface PhmSolidModelEntry {
  /** 引用的几何模型文件名（如 "abc.mod" / "xyz.stl"） */
  solidModelPath: string;
  /** 4×4 变换矩阵，列主序，长度 16；缺失时回退单位矩阵 */
  transformMatrix: number[];
  /** 颜色覆盖；MOD 引用为空（undefined），STL 引用必非空 */
  color?: XmlModColor;
}

/**
 * PHM 文件解析结果。
 *
 * 详见 docs/schema/phm.md。
 */
export interface PhmDocument {
  /** PHM 文件路径（如 "PHM/abc.phm"） */
  phmPath: string;
  /** SOLIDMODEL 引用列表 */
  solidModels: PhmSolidModelEntry[];
  /** NUM=0 时为 true（变电 14 个无几何装配节点） */
  isEmpty: boolean;
}

// ============================================================================
// §5b DEV 解析中间产物（Phase 4 使用）
// ============================================================================

/**
 * DEV 中 SOLIDMODELS 块的单个引用条目。
 *
 * 变电工程 SOLIDMODELn 仅指向 .phm；线路工程可指向 .phm 或 .dev（递归）。
 */
export interface DevSolidModelEntry {
  /** 引用的文件名（如 "abc.phm" / "xyz.dev"） */
  solidModelPath: string;
  /** 4×4 变换矩阵，列主序 / Three.js Matrix4.elements 布局，长度 16；缺失时回退单位矩阵 */
  transformMatrix: number[];
}

/**
 * DEV 中 SUBDEVICES 块的单个引用条目（仅变电工程使用）。
 *
 * SUBDEVICES 块与 SOLIDMODELS 块的 TRANSFORMMATRIX 索引各自独立从 0 开始。
 */
export interface DevSubDeviceEntry {
  /** 引用的子 DEV 文件名（如 "child.dev"） */
  devPath: string;
  /** 4×4 变换矩阵，列主序 / Three.js Matrix4.elements 布局，长度 16 */
  transformMatrix: number[];
}

/**
 * DEV 文件解析结果。
 *
 * 详见 docs/schema/dev.md。
 */
export interface DevDocument {
  /** DEV 文件路径（如 "DEV/abc.dev"） */
  devPath: string;
  /** BASEFAMILY 字段（.fam 文件名） */
  baseFamily: string;
  /** TYPE（变电）或 DEVICETYPE（线路）字段 */
  type: string;
  /** SYMBOLNAME 字段 */
  symbolName: string;
  /** SOLIDMODELS 块（指向 .phm 或递归 .dev） */
  solidModels: DevSolidModelEntry[];
  /** SUBDEVICES 块（仅变电工程，递归子 .dev） */
  subDevices: DevSubDeviceEntry[];
  /** 无 SOLIDMODELS 且无 SUBDEVICES 时为 true */
  isEmpty: boolean;
}

// ============================================================================
// §6 实例化（附加 Transform + Color）
// ============================================================================

/**
 * 几何实例（source + 变换 + 颜色）。
 *
 * 一个 source 可被多个 instance 引用（如同一 MOD 文件被多个 PHM 实例化）。
 */
export interface GimGeometryInstance {
  source: GimGeometrySource;
  /** 4×4 变换矩阵，列主序，长度 16（来自 PHM TRANSFORMMATRIXn） */
  transformMatrix: number[];
  /** 颜色覆盖（来自 PHM COLORn；MOD 引用时为 undefined，由 Entity 自带 Color 决定） */
  color?: XmlModColor;
}

// ============================================================================
// §7 类型守卫
// ============================================================================

export function isIfcSource(s: GimGeometrySource): s is IfcGeometrySource {
  return s.kind === "ifc";
}

export function isXmlModSource(s: GimGeometrySource): s is XmlModGeometrySource {
  return s.kind === "xml-mod";
}

export function isLineTextModSource(s: GimGeometrySource): s is LineTextModGeometrySource {
  return s.kind === "line-text-mod";
}

export function isStlSource(s: GimGeometrySource): s is StlGeometrySource {
  return s.kind === "stl";
}

export function isNoneSource(s: GimGeometrySource): s is NoneGeometrySource {
  return s.kind === "none";
}

// ============================================================================
// §8 primitive 类型守卫
// ============================================================================

export function isCuboid(p: XmlModPrimitive): p is Extract<XmlModPrimitive, { type: "Cuboid" }> {
  return p.type === "Cuboid";
}

export function isCylinder(p: XmlModPrimitive): p is Extract<XmlModPrimitive, { type: "Cylinder" }> {
  return p.type === "Cylinder";
}

export function isStretchedBody(p: XmlModPrimitive): p is Extract<XmlModPrimitive, { type: "StretchedBody" }> {
  return p.type === "StretchedBody";
}

export function isWeakSchemaPrimitive(
  p: XmlModPrimitive,
): p is Extract<XmlModPrimitive, { raw: Record<string, string> }> {
  return (
    p.type === "RectangularFixedPlate" ||
    p.type === "OffsetRectangularTable" ||
    p.type === "RectangularRing"
  );
}
