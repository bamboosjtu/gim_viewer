type XYZ = [number, number, number];
export interface WireAttachment {
  towerId: string;
  stringId: string;
  portName: string;
  /** Confirmed port expressed in tower-local mm. A bare tower G precedes the insulator string. */
  positionMm: XYZ;
  kind: "string-end" | "tower-mount";
  sourcePath: string;
}
export interface WireEndContext {
  towerId: string;
  stringId?: string;
  portName?: string;
  /** Needed for tower-local G and string ports. */
  towerToProject?: readonly number[];
  /** Only a known exporter/layout may supply the length unit for POINTn.MATRIXi. */
  matrixPlacement?: {
    unit: "m" | "mm";
    evidence: string;
    /** Frame of the matrix translations. Exporters can already include site azimuth in these values. */
    parentToProject: readonly number[];
  };
}
function point(p: XYZ, m: readonly number[]): XYZ {
  return [0, 1, 2].map(
    (i) => m[i] * p[0] + m[4 + i] * p[1] + m[8 + i] * p[2] + m[12 + i],
  ) as XYZ;
}
const key = (t: string, s: string, n: string) => JSON.stringify([t, s, n]);
export function wireAttachmentIndex(ports: Iterable<WireAttachment>) {
  const byKey = new Map<string, WireAttachment | undefined>();
  for (const p of ports) {
    const k = key(p.towerId, p.stringId, p.portName);
    byKey.set(k, byKey.has(k) ? undefined : p);
  }
  return byKey;
}
export function resolveWireEnd(
  props: Readonly<Record<string, string>>,
  side: 0 | 1,
  lane: number,
  context: WireEndContext | undefined,
  ports: ReadonlyMap<string, WireAttachment | undefined>,
) {
  if (!context) return;
  const prefix = `POINT${side}.MATRIX${lane}`,
    raw = props[prefix];
  if (
    raw &&
    context.matrixPlacement?.evidence &&
    context.matrixPlacement.parentToProject.length === 16
  ) {
    const tokens = raw.trim().split(/[\s,;]+/),
      m = tokens.map(Number);
    if (m.length === 16 && m.every(Number.isFinite) && m[15] === 1) {
      const s = context.matrixPlacement.unit === "m" ? 1000 : 1,
        position = point(
          [m[12] * s, m[13] * s, m[14] * s],
          context.matrixPlacement.parentToProject,
        );
      return {
        position,
        quality: "source-derived" as const,
        reference: [
          context.towerId,
          prefix,
          context.matrixPlacement.evidence,
        ].join("/"),
      };
    }
  }
  if (
    lane !== 0 ||
    !context.stringId ||
    !context.portName ||
    context.towerToProject?.length !== 16
  )
    return;
  const hit = ports.get(
    key(context.towerId, context.stringId, context.portName),
  );
  if (!hit) return;
  return {
    position: point(hit.positionMm, context.towerToProject),
    quality:
      hit.kind === "string-end"
        ? ("source-derived" as const)
        : ("preview-only" as const),
    reference: hit.sourcePath,
  };
}

/** Enumerate source lane ordinals only. An absent split layout remains a single preview chord. */
export function resolveWireLanes(
  props: Readonly<Record<string, string>>,
  ends: readonly [WireEndContext | undefined, WireEndContext | undefined],
  ports: ReadonlyMap<string, WireAttachment | undefined>,
) {
  const indices = new Set<number>();
  for (const field of Object.keys(props)) {
    const match = /^POINT[01]\.MATRIX(\d+)$/.exec(field);
    if (match) indices.add(Number(match[1]));
  }
  if (!indices.size) indices.add(0);
  const declared = Number(props.SPLIT),
    splitCount =
      Number.isSafeInteger(declared) && declared >= 1
        ? declared
        : Math.max(1, indices.size);
  const lanes = Array.from(indices)
    .sort((a, b) => a - b)
    .map((ordinal) => ({
      ordinal,
      start: resolveWireEnd(props, 0, ordinal, ends[0], ports),
      end: resolveWireEnd(props, 1, ordinal, ends[1], ports),
    }));
  return { splitCount, lanes };
}
