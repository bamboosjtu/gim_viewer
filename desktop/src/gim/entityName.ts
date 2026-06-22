/**
 * ENTITYNAME 归一化。
 *
 * 十样本复核实证（docs/schema/04）：ENTITYNAME 值存在大小写三态——
 * `PARTINDEX` / `PartIndex`、`F4System` / `F4SYSTEM`、`Wire_Device` / `WIRE_DEVICE` 等，
 * 随导出软件变化。所有比较必须基于归一化后的规范形态。
 */

/** 规范形态表（键为小写形式） */
const CANONICAL: Record<string, string> = {
  f1system: 'F1System',
  f2system: 'F2System',
  f3system: 'F3System',
  f4system: 'F4System',
  partindex: 'PARTINDEX',
  dev_subdevice: 'DEV_SUBDEVICE',
  logicalmodel: 'LOGICALMODEL',
  wire_device: 'Wire_Device',
  tower_device: 'Tower_Device',
  wire: 'WIRE',
  cross: 'CROSS',
};

/**
 * 将 ENTITYNAME 原始值归一化为规范大小写形态。
 * 未知值原样返回（不猜测），保证向前兼容新实体类型。
 */
export function normalizeEntityName(raw: string): string {
  const key = raw.trim().toLowerCase();
  return CANONICAL[key] ?? raw.trim();
}
