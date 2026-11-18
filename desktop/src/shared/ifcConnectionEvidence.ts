/**
 * IFC entity evidence that can be rendered as a connection-line preview
 * before the complete Fragments model is ready.  The classification is based
 * on the source entity type, never on a vendor/file-name hint.  Keep this set
 * conservative: an unknown type must stay an ordinary regional object rather
 * than being guessed into the electrical topology.
 */
export const CONNECTION_IFC_TYPES = new Set([
  'IFCCABLESEGMENT',
  'IFCCABLECARRIERSEGMENT',
  'IFCCABLEFITTING',
  'IFCCABLECARRIERFITTING',
  'IFCDUCTSEGMENT',
  'IFCDUCTFITTING',
  'IFCPIPESEGMENT',
  'IFCPIPEFITTING',
  'IFCFLOWSEGMENT',
  'IFCFLOWFITTING',
  'IFCROPE',
  'IFCWIRESEGMENT',
  'IFCCONDUCTORSEGMENT',
]);

// Some GIM exporters use IfcBuildingElementProxy for soft conductors and
// named bus/cable objects.  The name is source entity evidence, whereas the
// IFC file name is only a scheduling hint and must not classify geometry.
const CONNECTION_PROXY_NAME = /导线|软导体|电缆|母线|cable|wire|conductor|busbar/i;

export function isRegionalConnectionObject(object: { ifcType: string; name: string; role?: 'connection' }): boolean {
  if (object.role === 'connection') return true;
  const type = String(object.ifcType).trim().toUpperCase();
  return CONNECTION_IFC_TYPES.has(type)
    || (type === 'IFCBUILDINGELEMENTPROXY' && CONNECTION_PROXY_NAME.test(object.name));
}
