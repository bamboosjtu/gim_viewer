import {
  compileGeometrySource,
  placeGeometrySource,
  identityPlacement,
} from '@gim/gim-sdk/geometry';
import { readDomXmlMod } from '../../gim/geometry/xmlModParser.js';
import { projectXmlMod } from '../../gim/geometry/xmlModDocument.js';
import { geometryBatchToGroup } from '../../viewer/geometryBatch.js';
import { applyPhmColorOverride, colorToMaterial } from '../../viewer/xmlModGeometry.js';
import { XML_MOD_GEOMETRY_DIAGNOSTICS_KEY } from '../../viewer/xmlModLoader.js';
import type { DiscoveredModGeometry } from './modGeometryDiscovery.js';

/** Raw inspection uses local SDK buffers for standard solids. Composite/compatibility documents keep their browser evaluator. */
export async function readStandardMod(file: File, path: string, sourceVersion: string) {
  const raw = readDomXmlMod(await file.text(), path, 'project-column-major');
  const doc = projectXmlMod(raw);
  if (
    !doc.entities.length ||
    doc.status !== 'ok' ||
    doc.entities.some(
      (e) =>
        e.primitive.type !== 'Standard' ||
        ['Wire', 'CurveCable', 'Cable'].includes(e.primitive.canonical.kind),
    ) ||
    doc.diagnostics.some((d) => d.code === 'confirmed-compatibility')
  )
    return { doc };
  const source = compileGeometrySource(
    { format: 'xml-mod', sourceVersion, document: raw },
    { lod: 2 },
  );
  if (source.objects.some((o) => o.availability !== 'available')) return { doc };
  const colors = new Map(doc.entities.map((e) => [e.id, e.color]));
  return {
    doc,
    place(geo: DiscoveredModGeometry, rootPath: string) {
      const batch = placeGeometrySource(source, [
        {
          rootOccurrence: geo.rootOccurrence ?? rootPath,
          assemblyPath: geo.assemblyPath ?? '',
          referencePath: geo.referencePath ?? geo.instanceKey,
          localToParent: geo.placementTransformMatrix ?? identityPlacement,
        },
      ]);
      const group = geometryBatchToGroup(batch, (p) =>
        colorToMaterial(colors.get(p.address.entityId!), doc.colorMaxA),
      );
      group.name = 'xml-mod:' + path;
      group.userData.modPath = path;
      const unavailable = batch.objects.some((o) => o.availability === 'unavailable');
      group.userData[XML_MOD_GEOMETRY_DIAGNOSTICS_KEY] = {
        status: unavailable ? 'unsupported' : group.children.length ? 'renderable' : 'empty',
        ...(unavailable
          ? {
              sourceDiagnostics: [
                {
                  kind: 'invalid-source-matrix',
                  path,
                  field: 'TransformMatrix',
                  lines: [],
                  values: [],
                },
              ],
            }
          : {}),
        entityCount: doc.declaredEntityCount,
        renderableEntityCount: group.children.length,
        malformedEntityCount: 0,
        unsupportedEntityCount: 0,
        unsupportedPrimitiveTypeCounts: {},
      };
      applyPhmColorOverride(group, geo.phmColor, geo.phmColorMaxA);
      return group;
    },
  };
}
