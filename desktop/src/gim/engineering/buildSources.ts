import type { IfcSpatialObject, IfcSpatialNode, SpatialModelSummary } from '../ifcSpatialParser.js';
import { ifcSourceRecords } from './ifcSourceRecords.js';
import { buildEngineeringSourceModel, type IfcSourceMatch } from './engineeringModel.js';
import type { SourceRecord } from './sourceEvidence.js';
import type { EngineeringSourceGraph } from './sourceGraph.js';
import { normalizeEngineeringModel } from '../../engineering/normalize.js';
import { toObjectEvidence } from './sourceEvidence.js';
import type { EngineeringSnapshot } from '../../engineering/types.js';

export const ENGINEERING_SOURCE_VERSION = 'engineering-source-v5';
export type EngineeringSpatialContext = Pick<IfcSpatialNode, 'key' | 'modelId' | 'expressId' | 'ifcType' | 'kind' | 'globalId' | 'name' | 'sourcePath' | 'parentKey'>;
export interface EngineeringSources {
  version: string;
  graph: EngineeringSourceGraph;
  ifcRecords: SourceRecord[];
  ifcMatches: IfcSourceMatch[];
  models: Array<{ modelId: string; path: string; error?: string }>;
  spatialNodes: EngineeringSpatialContext[];
  complete: boolean;
  incompleteReasons: string[];
}
const canonical = (value: string) => value.replace(/\\/g, '/').toLowerCase();

/** A parse result can be browsed without certifying a complete source snapshot. */
export function buildEngineeringSources(scope: string, graph: EngineeringSourceGraph, objects: readonly IfcSpatialObject[], models: readonly SpatialModelSummary[], nodes: readonly IfcSpatialNode[] = []): { sources: EngineeringSources; snapshot: EngineeringSnapshot } {
  const model = buildEngineeringSourceModel(scope, graph, objects);
  const expected = new Set(graph.ifcPaths.map(canonical));
  const actual = new Set(models.map(m => canonical(m.entryPath)));
  const reasons: string[] = [];
  if (models.length !== actual.size || expected.size !== actual.size || [...expected].some(p => !actual.has(p))) reasons.push('ifc-manifest-incomplete');
  if (models.some(m => m.parseError)) reasons.push('ifc-parse-failed');
  const contexts = new Set(nodes.map(node => node.key));
  if (objects.some(object => object.spatialKeys.some(key => !contexts.has(key)))) reasons.push('ifc-spatial-context-incomplete');
  if (graph.diagnostics.length) reasons.push('source-graph-incomplete');
  if (graph.references.some(r => r.status !== 'resolved' && /\.(?:cbm|dev|fam|ifc)\$?$/i.test(r.value))) reasons.push('source-reference-unresolved');
  return { sources: {
    version: ENGINEERING_SOURCE_VERSION, graph, ifcRecords: ifcSourceRecords(objects), ifcMatches: model.ifcMatches,
    models: models.map(m => ({ modelId: m.modelId, path: m.entryPath, ...(m.parseError ? { error: m.parseError } : {}) })),
    spatialNodes: nodes.map(({ key, modelId, expressId, ifcType, kind, globalId, name, sourcePath, parentKey }) => ({ key, modelId, expressId, ifcType, kind, globalId, name, sourcePath, parentKey })),
    complete: reasons.length === 0, incompleteReasons: reasons,
  }, snapshot: model.snapshot };
}

/** Rules can change without reparsing source formats or touching geometry. */
export function normalizeEngineeringSources(scope: string, sources: EngineeringSources): EngineeringSnapshot {
  return normalizeEngineeringModel(scope, [...sources.graph.records, ...sources.ifcRecords].map(toObjectEvidence), sources.graph.aliases);
}
