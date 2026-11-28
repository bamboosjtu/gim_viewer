/** SDK local meshes, provider-compatible sections/cables and host Boolean/LOD composition. */
import { steelSection, steelSectionContour } from '../gim/geometry/steelSection.js';
import { logger } from '../utils/logger.js';
import * as THREE from 'three';
import type { StageObserver } from '../measurement/core.js';
export type DeviceLod = 0 | 1 | 2;
import { Brush, Evaluator, ADDITION, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
import type { XmlModColor, XmlModEntity, XmlModPrimitive } from '../gim/geometry/ir.js';
import type { XmlModDocument } from '../gim/geometry/xmlModParser.js';
import {
  entityIndex,
  compileStandardLeaf,
  BooleanGraph,
  visibleGeometryRoots,
  outlinePartThresholdMm,
} from '../gim/geometry/xmlModDocument.js';
import { geometryFromMeshData } from './geometryBatch.js';
export { geometryFromMeshData } from './geometryBatch.js';

const MOD_MM_TO_SCENE_UNIT = 0.001;
export { MOD_MM_TO_SCENE_UNIT };

/** 去重 warn（每种 primitive 只 warn 一次） */
const _warnedOnce = new Set<string>();

/**
 * 共享 Material 缓存：按 (colorHex, opacity, transparent) 聚类。
 *
 * 修复背景：变电工程约 78000+ Entity，若每个 Entity 独立 new MeshStandardMaterial，
 * GPU 内存累积导致 OOM 崩溃。实证样本中颜色种类有限（数十个），
 * 通过共享缓存可将 Material 数量从 78000+ 降到几十个。
 *
 * 共享 Material 不可在 disposeXmlModGroup 中逐 mesh dispose，
 * 必须由 disposeSharedXmlModMaterials 统一释放（项目切换时调用）。
 */
const _sharedMaterialCache = new Map<string, THREE.MeshStandardMaterial>();

/** 默认 Material（无 color 字段的 Entity 使用） */
let _sharedDefaultMaterial: THREE.MeshStandardMaterial | null = null;

/**
 * 共享 Geometry 缓存：按 (LOD, primitiveType, primitiveParamsSignature) 全局聚类。
 *
 * 安全性：BufferGeometry 仅含顶点数据（position/normal/uv），由 primitive 参数决定。
 * Entity.TransformMatrix 烘焙到 mesh.matrix，不影响 geometry 顶点。
 * 因此同 LOD、同参数的图元可跨 MOD 共用几何；项目清理时统一释放。
 */
const _sharedGeometryCache = new Map<string, THREE.BufferGeometry>();

/** 标记 PHM 颜色覆盖创建的实例材质，便于项目切换时安全释放。 */
const INSTANCE_MATERIAL_FLAG = '__gimOwnedInstanceMaterial';
const INSTANCE_COLOR_KEY = '__gimPhmColorKey';

/**
 * 释放所有共享 Material 缓存。
 *
 * 调用时机：项目切换时（projectCleanupService）。
 * 调用前需确保所有引用这些 Material 的 Mesh 已从 scene 移除。
 */
export function disposeSharedXmlModMaterials(): void {
  for (const mat of _sharedMaterialCache.values()) {
    mat.dispose();
  }
  _sharedMaterialCache.clear();
  if (_sharedDefaultMaterial) {
    _sharedDefaultMaterial.dispose();
    _sharedDefaultMaterial = null;
  }
}

/**
 * 释放所有共享 Geometry 缓存。
 *
 * 调用时机：项目切换时（projectCleanupService），在 disposeSharedXmlModMaterials
 * 之前或之后均可（两者独立）。
 * 调用前需确保所有引用这些 Geometry 的 Mesh 已从 scene 移除。
 */
export function disposeSharedXmlModGeometries(): void {
  for (const geo of _sharedGeometryCache.values()) {
    geo.dispose();
  }
  _sharedGeometryCache.clear();
}

/** Worker-only: call after all per-task geometry has been exported and released. */
export function trimSharedXmlModGeometries(budget: number): void {
  let bytes = 0;
  const sizes = new Map<string, number>();
  for (const [key, geo] of _sharedGeometryCache) {
    let size = geo.index?.array.byteLength ?? 0;
    for (const attribute of Object.values(geo.attributes)) size += attribute.array.byteLength;
    sizes.set(key, size);
    bytes += size;
  }
  for (const [key, geo] of _sharedGeometryCache) {
    if (bytes <= budget) break;
    _sharedGeometryCache.delete(key);
    bytes -= sizes.get(key)!;
    geo.dispose();
  }
}

/**
 * 释放 Group 内由 PHM 颜色覆盖创建的实例材质。
 *
 * MOD 原始材质来自共享缓存，不能在 Group 清理时逐个 dispose；只有带有
 * INSTANCE_MATERIAL_FLAG 的 clone 才由该函数负责释放。
 */
export function disposeOwnedXmlModMaterials(group: THREE.Object3D): void {
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material
        ? [mesh.material]
        : [];
    for (const material of materials) {
      if (
        (material.userData as Record<string, unknown> | undefined)?.[INSTANCE_MATERIAL_FLAG] ===
        true
      ) {
        material.dispose();
      }
    }
  });
}

function primitiveToGeometryUncached(
  p: XmlModPrimitive,
  lod: DeviceLod,
  onFailure?: (reason: string) => void,
): THREE.BufferGeometry | null {
  if (p.type === 'Standard') {
    const result = compileStandardLeaf(p.canonical, lod);
    if (!result.template) {
      onFailure?.(result.diagnostics[0]?.code ?? 'unsupported-primitive');
      return null;
    }
    const geometry = geometryFromMeshData(result.template.mesh);
    if (result.template.quality === 'estimated' || result.template.quality === 'preview-only')
      geometry.userData.representationQuality = result.template.quality;
    return geometry;
  }
  if (p.type === 'ChannelSteel' || p.type === 'BeamChannelLike') {
    const s = steelSection(p);
    if (!s) return null;
    const contour = steelSectionContour(s).map(([x, z]): [number, number, number] => [
      x,
      -s.length / 2,
      z,
    ]);
    const result = compileStandardLeaf(
      {
        kind: 'StretchedBody',
        normal: [0, 1, 0],
        length: s.length,
        contour,
        displacement: [0, s.length, 0],
      },
      lod,
    );
    return result.template ? geometryFromMeshData(result.template.mesh) : null;
  }
  if (p.type === 'Cable') {
    const points = vec3Array(p.inflectionPoints);
    if (points.length < 2) return null;
    return new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(points),
      Math.min(Math.max(points.length, 8), 256),
      Math.max(p.d / 2 || 0, 1e-6),
      6,
      false,
    );
  }
  if (p.type === 'Unsupported' && !_warnedOnce.has(p.sourceType)) {
    _warnedOnce.add(p.sourceType);
    logger.warn(`[xmlModGeometry] 未支持 primitive "${p.sourceType}"，已跳过`);
  }
  return null;
}

const standardSignatures = new WeakMap<object, string>();
function primitiveSignature(p: XmlModPrimitive): string {
  const shape = p.type === 'Standard' ? p.canonical : p;
  let key = standardSignatures.get(shape);
  if (key === undefined) {
    key = JSON.stringify(shape);
    standardSignatures.set(shape, key);
  }
  return key;
}
export function primitiveToGeometry(
  p: XmlModPrimitive,
  lod: DeviceLod = 2,
  onFailure?: (reason: string) => void,
): THREE.BufferGeometry | null {
  const sig = `${lod}:${p.type}:${primitiveSignature(p)}`;
  const cached = _sharedGeometryCache.get(sig);
  if (cached) return cached;
  const geo = primitiveToGeometryUncached(p, lod, onFailure);
  if (geo) _sharedGeometryCache.set(sig, geo);
  return geo;
}

/**
 * GIM TransformMatrix → Three.js Matrix4。
 *
 * 样本研究结论：GIM 矩阵为列主序展开，平移在 m[12]/m[13]/m[14]，
 * 等同于 Three.js Matrix4.elements 数组布局。
 */
export function gimMatrixToMatrix4(arr: number[]): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  if (!Array.isArray(arr) || arr.length !== 16) return m;
  m.fromArray(arr);
  return m;
}

/**
 * 将 Entity 转换为 Three.Mesh。
 *
 * - primitive → geometry（按图元参数共享缓存）
 * - color → material（共享缓存）
 * - transformMatrix → fromArray（列主序，与 GIM 实测布局一致）
 *
 * @param e entity 描述
 * @param colorMaxA 当前文件的颜色 A 刻度上限
 */
export function entityToMesh(e: XmlModEntity, colorMaxA = 100): THREE.Mesh | null {
  const geometry = primitiveToGeometry(e.primitive);
  if (!geometry) return null;

  const material = colorToMaterial(e.color, colorMaxA);
  const mesh = new THREE.Mesh(geometry, material);

  if (e.transformMatrix.length === 16) {
    mesh.applyMatrix4(gimMatrixToMatrix4(e.transformMatrix));
  }

  return mesh;
}

/**
 * A 原始值 → 不透明度。
 *
 * 规则（docs/schema/substation-mod.md 实测四工具）：
 * - A=0 是 Bentley/BIMBase 的「不透明哨兵」（占绝对主导），不是全透明
 * - 刻度按文件级 maxA 判定：maxA > 100 → 字节制(/255)，否则百分制(/100)
 */
export function resolveOpacity(a: number, maxA: number): { opacity: number; transparent: boolean } {
  if (a <= 0) return { opacity: 1, transparent: false };
  const scale = maxA > 100 ? 255 : 100;
  const opacity = Math.min(a / scale, 1);
  return { opacity, transparent: opacity < 1 };
}

/**
 * Color → 共享 MeshStandardMaterial。
 *
 * 按 (colorHex, opacity, transparent) 聚类缓存：
 * - 同色同透明度的 Entity 共享同一 Material 实例
 * - Material 不可在 disposeXmlModGroup 中 dispose（共享）
 * - 项目切换时由 disposeSharedXmlModMaterials 统一释放
 */
function colorToMaterial(
  color: XmlModColor | undefined,
  colorMaxA = 100,
): THREE.MeshStandardMaterial {
  if (!color) {
    if (!_sharedDefaultMaterial) {
      _sharedDefaultMaterial = new THREE.MeshStandardMaterial({
        color: 0x888888,
        transparent: false,
      });
    }
    return _sharedDefaultMaterial;
  }
  const hex = (clamp255(color.r) << 16) | (clamp255(color.g) << 8) | clamp255(color.b);
  const { opacity, transparent } = resolveOpacity(clamp255(color.a), colorMaxA);
  const key = `${hex}_${opacity}_${transparent}`;
  let material = _sharedMaterialCache.get(key);
  if (!material) {
    material = new THREE.MeshStandardMaterial({
      color: hex,
      transparent,
      opacity,
    });
    _sharedMaterialCache.set(key, material);
  }
  return material;
}

/**
 * 将 PHM COLORn 覆盖应用到一个已加载的 MOD/STL Group。
 *
 * PHM 颜色是实例级属性，不能直接修改 XML MOD 的共享材质；这里为每个
 * Mesh 材质创建 clone，再写入 RGB/opacity。A=0 按不透明哨兵处理，
 * `colorMaxA > 100` 时按字节制（/255），否则按百分制（/100）。
 *
 * @returns 实际被覆盖的 Mesh 数量
 */
export function applyPhmColorOverride(
  group: THREE.Object3D,
  color?: XmlModColor,
  colorMaxA?: number,
): number {
  if (!color) return 0;
  const maxA =
    Number.isFinite(colorMaxA) && (colorMaxA as number) > 0 ? (colorMaxA as number) : color.a;
  const hex = (clamp255(color.r) << 16) | (clamp255(color.g) << 8) | clamp255(color.b);
  const { opacity, transparent } = resolveOpacity(clamp255(color.a), maxA);
  const colorKey = `${hex}_${opacity}_${transparent}`;
  let affected = 0;

  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const applyOne = (source: THREE.Material): THREE.Material => {
      const sourceData = source.userData as Record<string, unknown> | undefined;
      if (
        sourceData?.[INSTANCE_MATERIAL_FLAG] === true &&
        sourceData[INSTANCE_COLOR_KEY] === colorKey
      ) {
        return source;
      }
      const material = source.clone();
      const materialData = { ...(material.userData ?? {}) } as Record<string, unknown>;
      materialData[INSTANCE_MATERIAL_FLAG] = true;
      materialData[INSTANCE_COLOR_KEY] = colorKey;
      material.userData = materialData;
      const colorTarget = (material as THREE.Material & { color?: THREE.Color }).color;
      if (colorTarget) colorTarget.setHex(hex);
      material.opacity = opacity;
      material.transparent = transparent;
      material.needsUpdate = true;
      // Re-applying a different override must not leak the previous clone.
      if (sourceData?.[INSTANCE_MATERIAL_FLAG] === true) source.dispose();
      return material;
    };
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map(applyOne);
    } else {
      mesh.material = applyOne(mesh.material);
    }
    affected++;
  });
  return affected;
}

function clamp255(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** 将整个 XmlModDocument 转换为 THREE.Group */
export function xmlModDocumentToGroup(doc: XmlModDocument): THREE.Group {
  const group = new THREE.Group();
  group.name = `xml-mod:${doc.modPath}`;
  if (doc.isEmpty) return group;

  for (const entity of doc.entities) {
    const mesh = entityToMesh(entity, doc.colorMaxA);
    if (!mesh) continue; // 跳过暂停渲染的 primitive
    mesh.visible = entity.visible;
    group.add(mesh);
  }
  group.scale.setScalar(MOD_MM_TO_SCENE_UNIT);
  return group;
}

/**
 * 收集文档中所有可见 entity 的 baked geometry（已烘焙 TransformMatrix + mm→m 缩放），按 Material 分组。
 *
 * 方案 B 专用：直接从 entity 数据烘焙 transform 到 geometry 顶点，
 * 不经过 Mesh.applyMatrix4 → decompose → compose 链路，避免精度损失。
 *
 * 单位处理：MOD 原始尺寸为毫米，这里把 Scale(0.001) 也烘焙到顶点（mm → m），
 * 使 merged geometry 顶点直接以场景单位（米）表达。
 * 这样 group.scale 保持 1，后续 applyPlacementTransformToSceneUnits 的顶点烘焙
 * 不会再触发 Object3D.applyMatrix4 + decompose 链路 corrupt group.scale。
 *
 * @param doc 解析后的 XmlModDocument
 * @returns Map<共享Material, baked BufferGeometry[]>，调用方负责 dispose baked geometry
 */
export interface OutlineGeometryOptions {
  /** MOD -> DEV placement, in source millimetres, used only for size filtering. */
  placementMatrix?: number[];
  /** Serialization defers the fallback until the whole DEV has been considered. */
  deferSmallPartFallback?: boolean;
  /** Deterministic subset of visible roots for an oversized single MOD. */
  rootSlice?: { index: number; total: number };
}
export function collectBakedGeometriesByMaterial(
  doc: XmlModDocument,
  lod: DeviceLod = 2,
  timings?: Record<string, number>,
  options?: OutlineGeometryOptions,
  onStage?: StageObserver,
): BakedGeometries {
  const steps = bakeGeometrySteps(doc, lod, timings, options, onStage);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** Keep exactly the synchronous operation order, yielding between completed
 * operations (including recursive Boolean operands). A single CSG evaluation
 * is still synchronous; this bounds chains, not the cost of an individual CSG.
 */
export async function collectBakedGeometriesByMaterialAsync(
  doc: XmlModDocument,
  lod: DeviceLod = 2,
  timings?: Record<string, number>,
  options?: OutlineGeometryOptions,
  onStage?: StageObserver,
): Promise<BakedGeometries> {
  const steps = bakeGeometrySteps(doc, lod, timings, options, onStage);
  let sliceStarted = performance.now();
  let step = steps.next();
  while (!step.done) {
    if (performance.now() - sliceStarted >= 8) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      sliceStarted = performance.now();
    }
    step = steps.next();
  }
  return step.value;
}

export interface BakedGeometryFailure {
  rootId: number;
  dependencies: { id: number; reason: string }[];
}
export type BakedGeometries = Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]> & {
  previewShapes: Set<string>;
  failures: BakedGeometryFailure[];
  simplifiedBooleans: number;
  lod: DeviceLod;
  representationPolicy: 'outline' | 'detailed';
  approximatedBooleans: Record<'Union' | 'Difference' | 'Intersection', number>;
  omittedSmallParts: number;
  omittedMaxExtentMm: number;
};
function* bakeGeometrySteps(
  doc: XmlModDocument,
  lod: DeviceLod,
  timings?: Record<string, number>,
  options?: OutlineGeometryOptions,
  onStage?: StageObserver,
): Generator<void, BakedGeometries, void> {
  const byMaterial = Object.assign(new Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]>(), {
    previewShapes: new Set<string>(),
    failures: [] as BakedGeometryFailure[],
    simplifiedBooleans: 0,
    lod,
    representationPolicy: lod < 2 ? ('outline' as const) : ('detailed' as const),
    approximatedBooleans: { Union: 0, Difference: 0, Intersection: 0 },
    omittedSmallParts: 0,
    omittedMaxExtentMm: 0,
  });
  const build = (p: XmlModPrimitive, id: number) => {
    const started = performance.now();
    const geometry = primitiveToGeometry(p, lod, (reason) => failures.set(id, reason));
    const quality: unknown = geometry?.userData.representationQuality;
    if (p.type === 'Standard' && (quality === 'estimated' || quality === 'preview-only'))
      byMaterial.previewShapes.add(p.canonical.kind + ':' + quality);
    const elapsed = timings || onStage ? performance.now() - started : 0;
    if (timings) timings.primitiveMs = (timings.primitiveMs ?? 0) + elapsed;
    onStage?.('dev.primitive', elapsed, {
      primitives: 1,
      verticesReferenced: geometry?.getAttribute('position')?.count ?? 0,
    });
    return geometry;
  };
  if (doc.isEmpty) return byMaterial;

  // mm → m 缩放矩阵：烘焙到顶点，避免 group.scale + Object3D.applyMatrix4 decompose 精度损失
  const mmToScene = new THREE.Matrix4().makeScale(
    MOD_MM_TO_SCENE_UNIT,
    MOD_MM_TO_SCENE_UNIT,
    MOD_MM_TO_SCENE_UNIT,
  );

  const entities = entityIndex(doc);
  const memo = new Map<number, THREE.BufferGeometry | null>();
  const visiting = new Set<number>();
  const owned = new Set<THREE.BufferGeometry>();
  const graph = new BooleanGraph((id) => {
    const entity = entities.get(id);
    if (!entity) return;
    return {
      localToParent: entity.transformMatrix,
      operation: entity.primitive.type === 'Boolean' ? entity.primitive : undefined,
    };
  });
  const failures = graph.failures;
  const own = (geometry: THREE.BufferGeometry) => {
    owned.add(geometry);
    return geometry;
  };
  const transform = (geometry: THREE.BufferGeometry, matrix: THREE.Matrix4) => {
    geometry.applyMatrix4(matrix);
    // Reflection reverses triangle winding. Keep outward normals and CSG's
    // inside/outside classification consistent without touching cached leaves.
    if (matrix.determinant() < 0) {
      if (!geometry.index)
        geometry.setIndex(
          Array.from({ length: geometry.getAttribute('position').count }, (_, i) => i),
        );
      const index = geometry.index!;
      for (let i = 0; i < index.count; i += 3) {
        const b = index.getX(i + 1);
        index.setX(i + 1, index.getX(i + 2));
        index.setX(i + 2, b);
      }
    }
    return geometry;
  };
  const fail = (id: number, reason: string) => {
    failures.set(id, reason);
    return null;
  };
  // Every cached result is in its parent's frame, including this Entity's
  // transform. Root output therefore applies only mm -> m, never that matrix twice.
  function* evaluate(id: number): Generator<void, THREE.BufferGeometry | null, void> {
    const key = id;
    if (memo.has(key)) return memo.get(key)!;
    const entity = entities.get(id);
    if (!entity) return fail(id, 'missing-reference');
    if (visiting.has(id)) return fail(id, 'cycle');
    visiting.add(id);
    let result: THREE.BufferGeometry | null = null;
    try {
      const p = entity.primitive;
      if (p.type !== 'Boolean') {
        const base = build(p, id);
        if (base) result = own(base.clone());
        else return fail(id, failures.get(id) ?? `unsupported-or-invalid:${p.type}`);
      } else {
        const a = yield* evaluate(p.entity1);
        const b = yield* evaluate(p.entity2);
        if (!a || !b) return fail(id, 'operand-unavailable');
        else if (!a.getAttribute('position').count || !b.getAttribute('position').count) {
          result = own(
            (p.op === 'Intersection'
              ? !a.getAttribute('position').count
                ? a
                : b
              : p.op === 'Difference'
                ? a
                : a.getAttribute('position').count
                  ? a
                  : b
            ).clone(),
          );
        } else {
          const started = performance.now();
          try {
            result = own(
              getSharedCsgEvaluator().evaluate(
                new Brush(a),
                new Brush(b),
                p.op === 'Union' ? ADDITION : p.op === 'Intersection' ? INTERSECTION : SUBTRACTION,
              ).geometry,
            );
          } catch (error) {
            return fail(id, `csg-failed:${String(error)}`);
          } finally {
            const elapsed = performance.now() - started;
            onStage?.('dev.boolean', elapsed, { evaluations: 1 });
            if (timings) {
              timings.booleanMs = (timings.booleanMs ?? 0) + elapsed;
              timings.booleanEvaluations = (timings.booleanEvaluations ?? 0) + 1;
            }
          }
        }
      }
      if (result) transform(result, gimMatrixToMatrix4(entity.transformMatrix));
      memo.set(key, result);
      yield;
      return result;
    } finally {
      visiting.delete(id);
    }
  }
  // Outline traversal never calls evaluate(): even a detailed failure fallback
  // only assembles source leaves. Matrices stay per reference, so shared leaves
  // can occur under multiple ancestors without double-transforming cached meshes.
  interface Piece {
    geometry: THREE.BufferGeometry;
    matrix: THREE.Matrix4;
    primitive: XmlModPrimitive;
  }
  const leaves = new Map<number, { geometry: THREE.BufferGeometry; primitive: XmlModPrimitive }>();
  const outlineLeaf = (id: number) => {
    if (leaves.has(id)) return true;
    const p = entities.get(id)!.primitive;
    const geometry = build(p, id);
    if (!geometry) {
      fail(id, failures.get(id) ?? `unsupported-or-invalid:${p.type}`);
      return false;
    }
    leaves.set(id, { geometry, primitive: p });
    return true;
  };
  function* surface(id: number): Generator<void, Piece[], void> {
    const plan = yield* graph.outline(id, outlineLeaf, (op) => {
      byMaterial.simplifiedBooleans++;
      byMaterial.approximatedBooleans[op]++;
    });
    return plan.map((p) => ({
      ...leaves.get(p.id)!,
      matrix: new THREE.Matrix4().fromArray(p.matrix),
    }));
  }
  const placement = options?.placementMatrix
    ? new THREE.Matrix4().fromArray(options.placementMatrix)
    : new THREE.Matrix4();
  let fallback:
    | { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial; extent: number }
    | undefined;
  const append = (geometry: THREE.BufferGeometry, material: THREE.MeshStandardMaterial) => {
    const bucket = byMaterial.get(material) ?? [];
    bucket.push(geometry);
    byMaterial.set(material, bucket);
  };

  try {
    for (const entity of visibleGeometryRoots(doc.entities, options?.rootSlice)) {
      let pieces = lod < 2 ? yield* surface(entity.id) : null;
      const base = lod < 2 ? null : yield* evaluate(entity.id);
      const reachable = graph.dependencies(entity.id);
      const dependencies: { id: number; reason: string }[] = [];
      for (const id of reachable) {
        const reason = failures.get(id);
        if (reason !== undefined) dependencies.push({ id, reason });
      }
      if (dependencies.length) byMaterial.failures.push({ rootId: entity.id, dependencies });
      // A failed detailed Union can still provide its supported browser
      // outline. Keep the root diagnostic and never label it complete.
      if (dependencies.length && lod === 2 && entity.primitive.type === 'Boolean')
        pieces = yield* surface(entity.id);
      pieces ??= base
        ? [{ geometry: base, matrix: new THREE.Matrix4(), primitive: entity.primitive }]
        : [];
      const material = colorToMaterial(entity.color, doc.colorMaxA);
      for (const piece of pieces) {
        if (piece.geometry.getAttribute('position').count === 0) continue;
        const baked = transform(piece.geometry.clone(), piece.matrix);
        const threshold = outlinePartThresholdMm(
          piece.primitive.type === 'Standard'
            ? piece.primitive.canonical.kind
            : piece.primitive.type,
        );
        if (lod < 2 && threshold) {
          baked.computeBoundingBox();
          const box = baked.boundingBox!.clone().applyMatrix4(placement);
          const size = box.getSize(new THREE.Vector3());
          const extent = Math.max(size.x, size.y, size.z);
          if (Number.isFinite(extent) && extent <= threshold) {
            byMaterial.omittedSmallParts++;
            byMaterial.omittedMaxExtentMm = Math.max(byMaterial.omittedMaxExtentMm, extent);
            if (!fallback || extent > fallback.extent) {
              fallback?.geometry.dispose();
              fallback = { geometry: baked, material, extent };
            } else baked.dispose();
            continue;
          }
        }
        baked.applyMatrix4(mmToScene);
        append(baked, material);
      }
      yield;
    }
    if (!byMaterial.size && fallback && !options?.deferSmallPartFallback) {
      append(fallback.geometry.clone().applyMatrix4(mmToScene), fallback.material);
    }
  } finally {
    fallback?.geometry.dispose();
    for (const geometry of owned) geometry.dispose();
  }
  if (timings) {
    timings.simplifiedBooleans = (timings.simplifiedBooleans ?? 0) + byMaterial.simplifiedBooleans;
    timings.lodOmittedPrimitives =
      (timings.lodOmittedPrimitives ?? 0) + byMaterial.omittedSmallParts;
    timings.failedVisibleRoots = (timings.failedVisibleRoots ?? 0) + byMaterial.failures.length;
  }

  return byMaterial;
}

/** 共享 CSG Evaluator（three-bvh-csg） */
let _sharedCsgEvaluator: Evaluator | null = null;
function getSharedCsgEvaluator(): Evaluator {
  if (!_sharedCsgEvaluator) _sharedCsgEvaluator = new Evaluator();
  return _sharedCsgEvaluator;
}

/** 展平坐标数组 [x,y,z,...] → THREE.Vector3[] */
function vec3Array(flat: number[]): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) {
    out.push(new THREE.Vector3(flat[i], flat[i + 1], flat[i + 2]));
  }
  return out;
}
