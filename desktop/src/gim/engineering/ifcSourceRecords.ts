import type { IfcSpatialObject } from '../ifcSpatialParser.js';
import type { SourceProperty, SourceRecord } from './sourceEvidence.js';
import { isIfcFeatureSourceType } from './sourceEvidence.js';
import { isIfcInternalDefinitionType } from '../ifcOutwardProduct.js';

/** Consumes only the parser's outward products. Never traverses STEP internals,
 * representations, type definitions or geometry. File discovery remains separate.
 */
export function ifcSourceRecords(objects: readonly IfcSpatialObject[]): SourceRecord[] {
  const records = objects.map(object => {
    // Express identity disambiguates duplicate/missing GlobalIds in a given model.
    const id = `ifc:${JSON.stringify([object.modelId, object.expressId])}`;
    return { object, id };
  });
  const byKey = new Map(records.map(({ object, id }) => [object.key, id]));
  if (byKey.size !== objects.length || new Set(records.map(row => row.id)).size !== objects.length) {
    throw new Error('Duplicate IFC outward occurrence identity');
  }
  return records.map(({ object, id }) => {
    if (isIfcInternalDefinitionType(object.ifcType)) {
      throw new Error(`IFC internal definition is not an outward source: ${object.ifcType}`);
    }
    const properties: SourceProperty[] = (object.propertySets ?? []).flatMap(group => group.values.map(property => ({
      path: object.sourcePath, source: `${object.sourcePath}#${group.id}`, section: group.name,
      keys: [property.name], value: property.value,
    })));
    for (const [field, value] of [['Name', object.sourceName], ['Description', object.description], ['ObjectType', object.objectType], ['Tag', object.tag]] as const) {
      if (value !== undefined) properties.push({ path: object.sourcePath, source: `${object.sourcePath}#${object.expressId}:${field}`, keys: [`IFC.${field}`], value });
    }
    const hostId = byKey.get(object.hostObjectKey ?? '');
    return {
      id, track: 'ifc', source: `${object.sourcePath}#${object.expressId}`, name: object.name,
      source_type: object.ifcType,
      parent: byKey.get(object.parentObjectKey ?? '') ?? (isIfcFeatureSourceType(object.ifcType) ? hostId : undefined) ?? '',
      properties, sources: [object.sourcePath], context: [...object.spatialKeys], guid: object.globalId,
      ifcOccurrence: { modelId: object.modelId, expressId: object.expressId, globalId: object.globalId },
      ...(hostId ? { relations: [{ kind: 'host' as const, targetSourceId: hostId, evidence: 'IFC host relationship' }] } : {}),
    };
  });
}
