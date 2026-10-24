/** Explicit source reference, never inferred from distance or object names. */
export interface ConnectionEndpointEvidence {
  kind: 'gim-connect-guid' | 'ifc-element';
  reference: string;
  relationId: number;
  propertyId?: number;
  propertySet?: string;
  propertyName?: string;
  viaPortIds?: number[];
}
export function normalizeConnectionPointGuid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/^\{(.*)\}$/, '$1');
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(text) ? text.toUpperCase() : null;
}
export function validEndpointEvidence(values: unknown): values is ConnectionEndpointEvidence[] {
  return Array.isArray(values) && values.length <= 128 && values.every(value => value
    && ['gim-connect-guid','ifc-element'].includes(value.kind)
    && typeof value.reference === 'string' && value.reference.length > 0 && value.reference.length <= 64
    && Number.isSafeInteger(value.relationId) && value.relationId > 0
    && (value.kind !== 'gim-connect-guid' || normalizeConnectionPointGuid(value.reference) !== null)
    && (value.propertyId === undefined || Number.isSafeInteger(value.propertyId) && value.propertyId > 0)
    && (value.propertySet === undefined || typeof value.propertySet === 'string' && value.propertySet.length <= 4096)
    && (value.propertyName === undefined || typeof value.propertyName === 'string' && value.propertyName.length <= 4096)
    && (value.viaPortIds === undefined || Array.isArray(value.viaPortIds) && value.viaPortIds.length <= 2
      && value.viaPortIds.every((id: unknown) => Number.isSafeInteger(id) && Number(id) > 0)));
}
