import {
  compilePrimitive,
  modMeshTemplate,
  STANDARD_PRIMITIVE_TAGS,
  type GeometryCompileOptions,
  curveCenterline,
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

const migratedTags = new Map(STANDARD_PRIMITIVE_TAGS.map((tag) => [tag.toLowerCase(), tag]));
const projectRules: Record<string, NonNullable<GeometryCompileOptions['compatibility']>['rule']> = {
  ChannelSteel: 'steel-model-section-v1',
  Wire: 'wire-fit-preview-v1',
  Table: 'non-similar-rhombi-preview-v1',
};

const indexes = new WeakMap<XmlModEntity[], Map<number, XmlModEntity>>();
export function compileStandardLeaf(shape: CanonicalPrimitive, lod: GeometryLod) {
  const result = compilePrimitive(shape, { lod });
  return { template: modMeshTemplate(result), diagnostics: result.diagnostics };
}
export function standardConnectionLine(shape: CanonicalPrimitive, lod?: GeometryLod) {
  return 'family' in shape && shape.family === 'curve'
    ? curveCenterline(shape, lod).flat()
    : undefined;
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
  const path = raw.sourcePath.replace(/\\/g, '/');
  const projectArchiveMod =
    raw.matrixLayout === 'project-column-major' &&
    /^MOD\/(?:[^/]+\/)*[^/]+\.mod$/i.test(path) &&
    !path.split('/').some((segment) => segment === '..' || segment === '.');
  const entities: XmlModEntity[] = [];
  let colorMaxA = 0;
  for (const entity of raw.entities) {
    const { id, primitive: source } = entity;
    if (id === undefined || raw.entitiesById.get(id) !== entity || !source) continue;
    const { sourceTag, rawAttributes } = source;
    const unsupported = { type: 'Unsupported' as const, sourceType: sourceTag, raw: rawAttributes };
    let primitive: XmlModPrimitive;
    const migrated = migratedTags.get(sourceTag.toLowerCase());
    const normalized =
      migrated && sourceTag !== migrated ? { ...source, sourceTag: migrated } : source;
    let result = migrated ? interpretXmlModPrimitive(normalized) : undefined;
    const rule = migrated && projectRules[migrated];
    if (rule && result?.status === 'invalid' && projectArchiveMod) {
      const evidence = `${raw.sourcePath}#${id} (${raw.matrixLayout}, GIM MOD archive entry)`;
      result = interpretXmlModPrimitive(normalized, { compatibility: { rule, evidence } });
      if (result.status === 'compatible')
        diagnostics.push({
          code: 'confirmed-compatibility',
          severity: 'info',
          message: `${rule}: ${evidence}`,
          path: raw.sourcePath,
          ordinal: entity.ordinal,
          entityId: id,
          sourceTag,
        });
    }
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
