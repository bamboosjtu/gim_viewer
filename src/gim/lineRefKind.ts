/**
 * 线路工程引用类型统一常量（v5）。
 *
 * 写入 line_cbm_ref.ref_kind、Rust 诊断 SQL、restore 服务必须使用一致值，
 * 严禁到处手写字符串字面量。
 *
 * - cbmFiles / devFiles / famFiles / phmFiles / modFiles / stlFiles / wireFiles / ifcFiles
 *   对应 GimGraphNode.refs 的 8 个数组字段
 * - ifcGuids：IFC GUID 引用（保留，当前线路工程未使用）
 * - rawRefs：原始引用键值对（非数组型引用），对应 GimGraphNode.refs.rawRefs
 */
export const LineRefKind = {
  CBM_FILES: 'cbmFiles',
  DEV_FILES: 'devFiles',
  FAM_FILES: 'famFiles',
  PHM_FILES: 'phmFiles',
  MOD_FILES: 'modFiles',
  STL_FILES: 'stlFiles',
  WIRE_FILES: 'wireFiles',
  IFC_FILES: 'ifcFiles',
  IFC_GUIDS: 'ifcGuids',
  RAW_REFS: 'rawRefs',
} as const;

export type LineRefKindValue = (typeof LineRefKind)[keyof typeof LineRefKind];

/** 数组型引用字段名集合（ref_kind 命中这些时归类到对应 refs 数组） */
export const ARRAY_REF_FIELDS: ReadonlySet<string> = new Set<string>([
  LineRefKind.CBM_FILES,
  LineRefKind.DEV_FILES,
  LineRefKind.FAM_FILES,
  LineRefKind.PHM_FILES,
  LineRefKind.MOD_FILES,
  LineRefKind.STL_FILES,
  LineRefKind.WIRE_FILES,
  LineRefKind.IFC_FILES,
]);
