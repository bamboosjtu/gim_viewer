import type {
  CanonicalPrimitive,
  GeometryDiagnostic,
  GeometryLod,
} from "../primitiveContracts.js";
import type {
  CompiledGeometrySource,
  GeometryTemplate,
  LocalGeometryObject,
  MeshTemplate,
} from "../contracts/geometryBatch.js";
import { compilePrimitive } from "../compilePrimitive.js";
import { analyzePrimitive, type Point3 } from "../analysisGeometry.js";
import { identityPlacement, isUsableAffineMatrix } from "../affineMatrix.js";
import { cross3, dot3, mul3, sub3, unit3 } from "../sweep.js";
import { compileTowerSkeleton, type TowerSkeletonSection } from "./line-mod.js";

type Member = TowerSkeletonSection["rods"][number] & {
  record: { kind: string; spec?: string; dir1?: Point3; dir2?: Point3 };
};
export interface SelectedTowerSection extends TowerSkeletonSection {
  rods: readonly Member[];
}
export interface SelectedSolid {
  key: string;
  quality?: "preview-only";
  shape: CanonicalPrimitive;
  placement: readonly number[];
}
export interface SelectedLineAssembly {
  selectionKey: string;
  sections: readonly SelectedTowerSection[];
  confirmed: boolean;
  missing: readonly string[];
  solids?: readonly SelectedSolid[];
}
function memberSolid(r: Member, key: string): SelectedSolid | undefined {
  const { start: a, end: b, record } = r;
  if (!a || !b || !record.spec) return;
  const base: Point3 = [a.x, a.y, a.z],
    delta = sub3([b.x, b.y, b.z], base),
    length = Math.hypot(...delta);
  if (!length || !Number.isFinite(length)) return;
  const axis = unit3(delta);
  const tube = /^[φΦØ]([\d.]+)[x×]([\d.]+)$/i.exec(record.spec);
  if (tube && record.kind === "tube") {
    const outer = Number(tube[1]) / 2,
      inner = outer - Number(tube[2]);
    if (!(outer > inner && inner > 0)) return;
    const x = unit3(
        cross3(Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], axis),
      ),
      y = cross3(axis, x);
    return {
      key,
      shape: {
        family: "profile",
        kind: "CircularGasket",
        outer,
        inner,
        height: 1,
        angle: 2 * Math.PI,
      },
      placement: [...x, 0, ...y, 0, ...delta, 0, ...base, 1],
    };
  }
  const angle = /^L([\d.]+)(?:[x×]([\d.]+))?[x×]([\d.]+)$/i.exec(record.spec);
  if (angle && record.kind === "angle" && record.dir1 && record.dir2) {
    const width = Number(angle[1]),
      height = Number(angle[2] ?? angle[1]),
      t = Number(angle[3]);
    if (!(t > 0 && width > t && height > t)) return;
    const x = unit3(sub3(record.dir1, mul3(axis, dot3(record.dir1, axis)))),
      y = cross3(axis, x),
      sign = dot3(y, record.dir2);
    if (!Number.isFinite(sign) || Math.abs(sign) < 1e-6) return;
    return {
      key,
      shape: {
        family: "profile",
        kind: "AngleSteel",
        width,
        height,
        web: t,
        flange: t,
        length: 1,
      },
      placement: [
        ...delta,
        0,
        ...mul3(x, -1),
        0,
        ...mul3(y, Math.sign(sign)),
        0,
        ...base,
        1,
      ],
    };
  }
}
export function compileSelectedLineAssembly(
  sourcePath: string,
  sourceVersion: string,
  selection: SelectedLineAssembly,
  lod: GeometryLod = 2,
  pool = new Map<string, MeshTemplate>(),
): CompiledGeometrySource {
  const objects: LocalGeometryObject[] = [],
    templates = new Map<string, GeometryTemplate>();
  const compile = (s: SelectedSolid) => {
    const key = JSON.stringify(["line-solid", lod, s.shape]);
    if (!isUsableAffineMatrix(s.placement)) return false;
    let template = pool.get(key);
    if (!template) {
      const r = compilePrimitive(s.shape, { lod });
      if (!r.mesh || r.status === "none") return false;
      template = { kind: "mesh", mesh: r.mesh, quality: r.status };
      pool.set(key, template);
    }
    templates.set(key, template);
    objects.push({
      componentKey: s.key,
      visible: true,
      geometry: {
        templateKey: key,
        lod,
        quality: s.quality ?? template.quality,
      },
      localToSource: s.placement,
      availability: "available",
      range: analyzePrimitive(s.shape).range,
      diagnostics: [],
      ports: [],
    });
    return true;
  };
  const fallback = selection.sections.map((s) => ({
    ...s,
    rods: s.rods.filter((r) => {
      if (!selection.confirmed) return true;
      const solid = memberSolid(r, `Body/${s.sectionIndex}/R/${r.ordinal}`);
      return !solid || !compile(solid);
    }),
  }));
  const skeleton = compileTowerSkeleton(sourcePath, sourceVersion, fallback);
  for (const [key, t] of skeleton.templates) {
    const scoped = JSON.stringify([key, selection.selectionKey]);
    templates.set(scoped, t);
  }
  for (const o of skeleton.objects) {
    objects.push({
      ...o,
      componentKey: "section/" + o.ordinal,
      geometry: o.geometry
        ? {
            ...o.geometry,
            templateKey: JSON.stringify([
              o.geometry.templateKey,
              selection.selectionKey,
            ]),
          }
        : undefined,
    });
  }
  const diagnostics: GeometryDiagnostic[] = selection.missing.map(
    (message) => ({
      code: "incomplete-line-selection",
      stage: "interpret",
      severity: "warning",
      message,
      location: { path: sourcePath },
    }),
  );
  for (const s of selection.solids ?? [])
    if (!compile(s))
      diagnostics.push({
        code: "invalid-line-solid",
        stage: "compile",
        severity: "warning",
        message: s.key,
        location: { path: sourcePath },
      });
  if (diagnostics.length)
    objects.push({
      componentKey: "unresolved",
      visible: true,
      availability: "unavailable",
      ports: [],
      range: { coverage: "unknown" },
      localToSource: identityPlacement,
      diagnostics,
    });
  return {
    format: "line-mod",
    sourceVersion,
    sourcePath,
    variantKey: selection.selectionKey,
    requestedLod: lod,
    templates,
    objects,
    diagnostics,
  };
}
