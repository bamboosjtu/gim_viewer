import {
  compileTowerSkeleton,
  compileSelectedLineAssembly,
  compileLineSpan,
  selectedFoundationParts,
  localSurveyPoint,
  placeGeometrySource,
  identityPlacement,
  type GeometryBatch,
} from '@gim/gim-sdk/geometry';
import { EngineeringRepresentationIndex } from '@gim/gim-sdk/engineering';
import {
  resolveTowerTopology,
  selectTowerParts,
  readSinglePile,
  resolveWireLanes,
} from '@gim/powerline-core';
import type { GimGraphNode } from '@gim/powerline-core/gimGraphTypes.js';
import type { LineModRuntimeEntry } from '../presentation/lineModSourcePort.js';

function survey(value: string | undefined) {
  const fields = value?.split(',');
  if (!fields || fields.length < 3 || fields.slice(0, 3).some((v) => !v.trim())) return;
  const [latitudeDeg, longitudeDeg, heightM] = fields.map(Number);
  if (![latitudeDeg, longitudeDeg, heightM].every(Number.isFinite)) return;
  return { latitudeDeg, longitudeDeg, heightM };
}
export function linePreviewBatch(
  node: GimGraphNode,
  entry: LineModRuntimeEntry,
  version: string,
  heightMm?: number,
  subLegs?: readonly number[],
  spacing?: { mm: number; path: string },
) {
  const records = entry.source?.records;
  if (!records) return;
  const address = { rootOccurrence: node.path, assemblyPath: entry.path };
  const sourceId = JSON.stringify([node.path, entry.path]);
  const ownership = new EngineeringRepresentationIndex(
    { entities: [{ id: node.path }], pending: [], memberships: [{ sourceId, ownerId: node.path }] },
    [{ kind: 'line', sourceId, ...address }],
  );
  let source, caption: string;
  if ('hNum' in records) {
    if (heightMm === undefined) {
      source = compileTowerSkeleton(entry.path, version, resolveTowerTopology(records));
      caption = '塔型骨架';
    } else {
      const selected = selectTowerParts(records, { heightMm, subLegs });
      source = compileSelectedLineAssembly(entry.path, version, selected);
      caption = selected.confirmed ? '已选接身接腿' : '选型不完整 · 已知骨架';
    }
  } else if ('signature' in records && 'H1' in records) {
    const profile = readSinglePile(records);
    if (!profile) return;
    const foundation = selectedFoundationParts({
      piles: [{ key: 'pile', topMm: [0, 0, 0], profile }],
    });
    source = compileSelectedLineAssembly(entry.path, version, {
      ...foundation,
      selectionKey: 'foundation',
      confirmed: true,
      sections: [],
    });
    caption = '基础模型';
  } else if ('OUTSIDEDIAMETER' in records) {
    const span = wirePreview(node, entry.path, version, records.OUTSIDEDIAMETER, spacing);
    if (!span) return;
    ({ source, caption } = span);
  } else return;
  const batch: GeometryBatch = placeGeometrySource(source, [
    { ...address, referencePath: entry.path, localToParent: identityPlacement },
  ]);
  const binding = ownership.resolveLine(address.rootOccurrence, address.assemblyPath);
  return { batch, caption, binding, diagnostics: source.diagnostics };
}

function wirePreview(
  node: GimGraphNode,
  path: string,
  version: string,
  diameter: number,
  spacing?: { mm: number; path: string },
) {
  const ends = [survey(node.rawProps['POINT0.BLHA']), survey(node.rawProps['POINT1.BLHA'])];
  const origin = ends.find((p) => p !== undefined);
  if (!origin) return;
  const frame = { ellipsoid: 'CGCS2000' as const, origin };
  const raw = node.rawProps,
    frameFor = (side: 0 | 1) => {
      const site = ends[side];
      if (!site || !spacing || !(spacing.mm > 0) || raw.SPLIT !== '4') return;
      const centers: number[][] = [];
      for (let i = 0; i < 4; i++) {
        const fields = raw['POINT' + side + '.MATRIX' + i]?.split(',');
        if (fields?.length !== 16) return;
        const m = fields.map(Number);
        if (!m.every(Number.isFinite) || m[15] !== 1) return;
        centers.push(m.slice(12, 15));
      }
      let gap = Infinity;
      for (const [i, c] of centers.entries())
        for (let j = i + 1; j < centers.length; j++)
          gap = Math.min(gap, Math.hypot(...c.map((v, k) => v - centers[j][k])));
      const units = (['mm', 'm'] as const).filter(
        (u) => Math.abs(gap * (u === 'm' ? 1000 : 1) - spacing.mm) <= 10,
      );
      if (units.length !== 1) return;
      const parent = [...identityPlacement.slice(0, 12), ...localSurveyPoint(frame, site), 1];
      return {
        towerId: node.path + '#POINT' + side,
        matrixPlacement: {
          unit: units[0],
          evidence: spacing.path + '#BUNDLESPACING',
          parentToProject: parent,
        },
      };
    };
  const { lanes, splitCount } = resolveWireLanes(raw, [frameFor(0), frameFor(1)], new Map());
  // BLHA locates the tower centre. Preserve it as a preview when terminal placement evidence is absent.
  const ports = ends.map((p, i) =>
    p
      ? {
          position: localSurveyPoint(frame, p),
          quality: 'preview-only' as const,
          reference: node.path + '#POINT' + i + '.BLHA',
        }
      : undefined,
  );
  const resolved = lanes.filter((l) => l.start || l.end);
  const source = compileLineSpan({
    sourcePath: path,
    sourceVersion: version,
    variantKey: node.path,
    lanes: resolved.length ? resolved : [{ start: ports[0], end: ports[1] }],
    splitCount,
    outsideDiameterMm: diameter,
  }).source;
  const caption = resolved.length ? '分裂导体端点弦线 · 预览' : '塔位中心弦线 · 预览';
  return { source, caption };
}
