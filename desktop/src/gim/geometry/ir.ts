/** Current source/compiler IR contract entry; shared payload types and constants retain this module boundary. */
export * from '@gim/gim-primitives/geometry/ir.js';
import type { CanonicalPrimitive } from '@gim/gim-sdk/geometry';
import type {
  XmlModEntity as LegacyEntity,
  XmlModPrimitive as LegacyPrimitive,
} from '@gim/gim-primitives/geometry/ir.js';

export type XmlModPrimitive = LegacyPrimitive | { type: 'Standard'; canonical: CanonicalPrimitive };
export type XmlModEntity = Omit<LegacyEntity, 'primitive'> & { primitive: XmlModPrimitive };
export function primitiveName(p: XmlModPrimitive): string {
  if (p.type === 'Standard') return p.canonical.kind;
  return p.type === 'Unsupported' ? p.sourceType : p.type;
}
