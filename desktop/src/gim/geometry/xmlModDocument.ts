import {
  compilePrimitive,
  PROFILE_TAGS,
  interpretXmlModPrimitive,
  type CanonicalPrimitive,
  type GeometryLod,
} from '@gim/gim-sdk/geometry';
import type {
  RawXmlModDocument,
  XmlModDocument as LegacyDocument,
  XmlModDiagnostic,
} from '@gim/gim-sdk/parser';
import type { XmlModColor, XmlModEntity, XmlModPrimitive } from './ir.js';
import { mapXmlModPrimitive } from './xmlModPrimitiveAdapter.js';

export interface XmlModDocument extends Omit<LegacyDocument, 'entities' | 'diagnostics'> {
  entities: XmlModEntity[];
  diagnostics: readonly XmlModDiagnostic[];
}

const migratedTags = new Map([
  ...PROFILE_TAGS.map((tag) => [tag.toLowerCase(), tag] as [string, string]),
  ['terminalblock', 'TerminalBlock'],
  ['rectangularfixedplate', 'RectangularFixedPlate'],
  ['circularfixedplate', 'CircularFixedPlate'],
  ['cuboid', 'Cuboid'],
  ['cylinder', 'Cylinder'],
  ['sphere', 'Sphere'],
  ['truncatedcone', 'TruncatedCone'],
  ['eccentrictruncatedcone', 'EccentricTruncatedCone'],
  ['offsetrectangulartable', 'OffsetRectangularTable'],
  ['stretchedbody', 'StretchedBody'],
]);

const indexes = new WeakMap<XmlModEntity[], Map<number, XmlModEntity>>();
export function compileStandardLeaf(shape: CanonicalPrimitive, lod: GeometryLod) {
  return compilePrimitive(shape, { lod }).mesh;
}
export function entityIndex(doc: XmlModDocument): ReadonlyMap<number, XmlModEntity> {
  let index = indexes.get(doc.entities);
  if (!index) {
    index = new Map(doc.entities.map((entity) => [entity.id, entity]));
    indexes.set(doc.entities, index);
  }
  return index;
}

export function invalidXml(path: string, message: string) {
  return Object.assign(new Error(`XML parse error in ${path}: ${message}`), {
    code: 'invalid-xml',
    stage: 'parse',
    severity: 'error',
    location: { path },
  });
}

function colorOf(attrs?: Readonly<Record<string, string>>): XmlModColor | undefined {
  if (!attrs) return undefined;
  const values = ['R', 'G', 'B', 'A'].map((key) => Number.parseInt(attrs[key], 10));
  if (values.some((value) => !(value >= 0 && value <= 255))) return undefined;
  const [r, g, b, a] = values;
  return { r, g, b, a };
}

export function projectXmlMod(raw: RawXmlModDocument): XmlModDocument {
  if (raw.status === 'failed')
    throw invalidXml(raw.sourcePath, raw.diagnostics[0]?.message ?? 'Invalid Device document');
  const diagnostics: XmlModDiagnostic[] = [...raw.diagnostics];
  const entities: XmlModEntity[] = [];
  let colorMaxA = 0;
  for (const entity of raw.entities) {
    const { id, primitive: source } = entity;
    if (id === undefined || raw.entitiesById.get(id) !== entity || !source) continue;
    const { sourceTag, rawAttributes } = source;
    const unsupported = { type: 'Unsupported' as const, sourceType: sourceTag, raw: rawAttributes };
    let primitive: XmlModPrimitive;
    const migrated = migratedTags.get(sourceTag.toLowerCase());
    const result = migrated
      ? interpretXmlModPrimitive(
          source.sourceTag === migrated ? source : { ...source, sourceTag: migrated },
          migrated === 'ChannelSteel' && rawAttributes.Model
            ? {
                compatibility: {
                  rule: 'steel-model-section-v1',
                  evidence: 'project XML Model-only section convention',
                },
              }
            : migrated === 'Table'
              ? {
                  compatibility: {
                    rule: 'non-similar-rhombi-preview-v1',
                    evidence: 'substation01 raw Table declarations with unequal scale factors',
                  },
                }
              : {},
        )
      : undefined;
    if (result?.canonical) {
      primitive = { type: 'Standard', canonical: result.canonical };
      for (const issue of result.diagnostics)
        if (issue.stage !== 'parse')
          diagnostics.push({
            code: issue.code,
            severity: issue.severity,
            message: issue.message,
            path: raw.sourcePath,
            ordinal: entity.ordinal,
            entityId: id,
            sourceTag,
            field: issue.location?.field,
          });
    } else if (!result && !source.diagnostics.some((d) => d.code === 'conflicting-field')) {
      primitive = mapXmlModPrimitive(sourceTag, rawAttributes) ?? unsupported;
      if (primitive.type === 'Unsupported')
        diagnostics.push({
          code: 'unsupported-primitive',
          severity: 'warning',
          message: 'Unsupported MOD primitive',
          path: raw.sourcePath,
          ordinal: entity.ordinal,
          entityId: id,
          sourceTag,
          rawValue: sourceTag,
        });
    } else {
      primitive = unsupported;
      for (const issue of result?.diagnostics ?? [])
        if (issue.stage !== 'parse')
          diagnostics.push({
            code: issue.code,
            severity: issue.severity,
            message: issue.message,
            path: raw.sourcePath,
            ordinal: entity.ordinal,
            entityId: id,
            sourceTag,
            field: issue.location?.field,
          });
    }
    const color = colorOf(entity.color);
    colorMaxA = Math.max(colorMaxA, color?.a ?? 0);
    entities.push({
      id,
      type: 'simple',
      primitive,
      color,
      visible: entity.visible,
      transformMatrix: [...entity.transformMatrix],
    });
  }
  return {
    modPath: raw.sourcePath,
    entities,
    declaredEntityCount: raw.declaredEntityCount,
    malformedEntityCount: raw.declaredEntityCount - entities.length,
    colorMaxA,
    isEmpty: raw.status === 'empty',
    status: diagnostics.some((d) => d.severity !== 'info') ? 'partial' : raw.status,
    diagnostics,
  };
}
