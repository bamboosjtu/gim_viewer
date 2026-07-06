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
 * 当前 P0 不实现，IR 类型保留以兼容联合类型。
 */
export interface LineTextModGeometrySource {
  kind: "line-text-mod";
  format: LineModFormat;
  modPath: string;
  /** 按 format 分发的强类型记录数组，IR 保留 unknown，由消费方按 format 显式 cast */
  records: unknown;
}

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
 * 当前 P0 不实现，类型保留。
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
