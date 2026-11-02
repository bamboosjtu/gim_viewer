import aliases from './sourceTypeAliases.json';
import type { EvidenceValue, ObjectEvidence } from '../../engineering/types.js';

/** Raw source records stay in the source domain, separate from engineering identity. */
export interface SourceProperty {
  keys?: readonly string[];
  value: string;
  path?: string;
  /** IFC raw property spelling/value, before semantic decoding. */
  key?: string;
  source?: string;
  line?: number;
  rawLine?: string;
  section?: string;
}

export interface SourceRecord {
  id: string;
  track: 'dev' | 'ifc';
  source: string;
  name: string;
  source_type: string;
  /** Only a real DEV assembly or IFC object decomposition edge. */
  parent: string;
  properties: readonly SourceProperty[];
  sources: readonly string[];
  context: readonly string[];
  guid: string;
  devOccurrence?: { rootSourceId: string; cbmOccurrenceId: string; assemblyPath: string };
  ifcOccurrence?: { modelId: string; expressId: number; globalId: string };
  /** Hosting/space relations are evidence, not physical assembly membership. */
  relations?: Array<{ kind: 'host'; targetSourceId: string; evidence: string }>;
}

export const isIfcFeatureSourceType = (type: string): boolean => /^(?:IFCDISTRIBUTIONPORT|IFCPORT|IFCOPENINGELEMENT|IFCOPENINGSTANDARDCASE|IFCVOIDINGFEATURE|IFCFEATUREELEMENTSUBTRACTION|IFCFEATUREELEMENTADDITION|IFCFEATUREELEMENT|IFCPROJECTIONELEMENT|IFCANNOTATION|IFCGRID)$/.test(type);

const empty = new Set(['', '-', '/', '-100', '软件自动生成']);
function values(record: SourceRecord, labels: readonly string[]): EvidenceValue[] {
  return record.properties.flatMap((p, index) => p.keys?.some(key => labels.includes(key)) && !empty.has(p.value.trim())
    ? [{ value: p.value, evidenceId: JSON.stringify([record.id, p.path ?? p.source, p.line ?? index, p.keys]) }] : []);
}

/** Format labels and type enums end here; the engineering core does not read them. */
export function toObjectEvidence(record: SourceRecord): ObjectEvidence {
  const type = record.source_type;
  const devTypes: Readonly<Record<string, string>> = aliases.dev;
  const ifcTypes: Readonly<Record<string, string>> = aliases.ifc;
  const devCategory = devTypes[type.toLowerCase()];
  return {
    sourceId: record.id, name: record.name, assemblyParentId: record.parent || undefined,
    typeCategory: /neutralpointequipment/i.test(type) ? 'neutral_set' : devCategory ?? ifcTypes[type],
    traits: {
      fastener: ['IFCMECHANICALFASTENER', 'IFCFASTENER'].includes(type),
      assemblyContainer: ['IFCELEMENTASSEMBLY', 'IFCBUILDINGELEMENTPROXY'].includes(type),
      materialType: !!devCategory?.startsWith('M'),
      nonphysical: isIfcFeatureSourceType(type),
    },
    designations: values(record, ['工程中名称', 'PROJECTNAME', 'Projectname']),
    identityCodes: values(record, ['电网工程标识系统编码', '设备编码', 'GRIDIDENTIFICATIONSYSTEMCODE']),
    identityNames: values(record, ['设备名称', '工程中名称', 'PROJECTNAME', 'Projectname']),
    phases: values(record, ['相数']),
  };
}
