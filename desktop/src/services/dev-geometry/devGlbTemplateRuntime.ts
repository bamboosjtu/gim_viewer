/**
 * Session-local DEV GLB template/placement runtime.
 *
 * A DEV GLB is parsed once per project session.  The parsed hierarchy is kept
 * detached as an immutable template; each CBM occurrence receives its own
 * Object3D hierarchy while BufferGeometry and base Material references stay
 * shared.  This module deliberately contains no cache/database policy and no
 * substation-wide scheduler.
 */

import * as THREE from 'three';
import { invalidGeometryBounds } from '../../viewer/geometryBounds.js';
import type { AppState } from '../../app/state.js';
import type { ProjectSessionIdentity } from '../../shared/projectSession.js';

export interface DevGlbParsedAsset {
  scene: THREE.Group;
  animations?: THREE.AnimationClip[];
}

export type DevGlbTemplatePreparation =
  | {
      kind: 'shared';
      template: DevGlbTemplate;
    }
  | {
      kind: 'exclusive';
      fallbackReason: string;
    };

export interface DevGlbTemplatePoolMetrics {
  templateParseCount: number;
  templateParseMs: number;
  templateShareableCount: number;
  templateFallbackCount: number;
  fallbackDevPaths: string[];
  fallbackReasons: Record<string, string>;
  sharedGeometryCount: number;
  sharedMaterialCount: number;
  sharedTextureCount: number;
}

export interface DevGlbPlacementOptions {
  rootOccurrence?: string;
  instanceKey?: string;
  /** CBM placement in source millimetres, column-major. */
  placementMatrix?: number[] | null;
  /** Project source → viewer matrix, applied at the placement root. */
  projectSourceToViewerMatrix?: THREE.Matrix4 | null;
}

export interface PlacementBudgetOptions {
  maxSliceMs?: number;
  maxPlacementsPerSlice?: number;
  yieldToMain: () => Promise<void>;
  isCurrent: () => boolean;
  onSlice?: (durationMs: number, yielded: boolean) => void;
}

export interface PlacementBudgetResult {
  placementCount: number;
  sliceCount: number;
  yieldCount: number;
  maxSliceMs: number;
  sliceDurationsMs: number[];
}

export const DEV_GLB_TEMPLATE_POOL_USER_DATA_KEY = '__gimDevGlbTemplatePool';
export const DEV_GLB_TEMPLATE_PLACEMENT_USER_DATA_KEY = '__gimDevGlbTemplatePlacement';
export const DEV_GLB_EXCLUSIVE_PLACEMENT_USER_DATA_KEY = '__gimDevGlbExclusivePlacement';

/** Query existing placement ownership; raw and GLB must not both own one root. */
export function getLoadedDevOccurrenceKind(
  state: Pick<AppState, 'loadedXmlModGroups' | 'loadedStlGroups'>,
  rootOccurrence: string | undefined,
): 'glb' | 'raw' | null {
  if (!rootOccurrence) return null;
  let raw = false;
  for (const groups of [state.loadedXmlModGroups, state.loadedStlGroups]) {
    if (!groups) continue;
    for (const group of groups.values()) {
      if (group.userData.rootOccurrence !== rootOccurrence) continue;
      if (
        group.userData[DEV_GLB_TEMPLATE_PLACEMENT_USER_DATA_KEY] ||
        group.userData[DEV_GLB_EXCLUSIVE_PLACEMENT_USER_DATA_KEY]
      )
        return 'glb';
      raw = true;
    }
  }
  return raw ? 'raw' : null;
}

const DEFAULT_MAX_SLICE_MS = 6;
const DEFAULT_MAX_PLACEMENTS_PER_SLICE = 32;

const IDENTITY = new THREE.Matrix4();

function finiteMatrix(matrix: THREE.Matrix4): boolean {
  return matrix.elements.every((value) => Number.isFinite(value));
}

function collectMaterials(root: THREE.Object3D): Set<THREE.Material> {
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh & {
      isSkinnedMesh?: boolean;
      isInstancedMesh?: boolean;
    };
    const value = mesh.material;
    if (Array.isArray(value)) {
      for (const material of value) if (material) materials.add(material);
    } else if (value) {
      materials.add(value);
    }
  });
  return materials;
}

function collectTextures(materials: ReadonlySet<THREE.Material>): Set<THREE.Texture> {
  const textures = new Set<THREE.Texture>();
  for (const material of materials) {
    for (const key of Object.keys(material)) {
      const value = (material as unknown as Record<string, unknown>)[key];
      if (value && typeof value === 'object' && (value as { isTexture?: boolean }).isTexture) {
        textures.add(value as THREE.Texture);
      }
    }
  }
  return textures;
}

function disposeObjectResources(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = collectMaterials(root);
  root.traverse((object) => {
    const mesh = object as THREE.Mesh & {
      isSkinnedMesh?: boolean;
      isInstancedMesh?: boolean;
    };
    if (mesh.geometry) geometries.add(mesh.geometry);
  });
  const textures = collectTextures(materials);
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

type RenderHooks = Pick<
  Record<'onBeforeRender' | 'onAfterRender', unknown>,
  'onBeforeRender' | 'onAfterRender'
>;

function isDefaultObjectHook(hook: unknown, defaultHook: unknown): boolean {
  return hook == null || hook === defaultHook;
}

/**
 * Validate the static subset emitted by the current GLTFExporter path.
 * Returning a reason instead of throwing lets the caller isolate one DEV and
 * use the existing legacy per-placement loader for that DEV only.
 */
interface TemplateInspection {
  bounds: THREE.Box3;
  geometries: Set<THREE.BufferGeometry>;
  materials: Set<THREE.Material>;
  textures: Set<THREE.Texture>;
}
const preparedInspections = new WeakMap<THREE.Group, TemplateInspection>();
/** Sharing eligibility and display bounds use one node traversal. Position
 * buffers are not rescanned to audit already decoded/cached GLB content. */
export function validateDevGlbTemplate(
  asset: DevGlbParsedAsset,
): { shareable: true } | { shareable: false; reason: string } {
  if (!asset.scene) return { shareable: false, reason: 'missing-scene' };
  const inspection: TemplateInspection = {
    bounds: new THREE.Box3(),
    geometries: new Set(),
    materials: new Set(),
    textures: new Set(),
  };
  let reason = asset.animations?.length ? 'animation-dependency' : '',
    renderable = false;
  const box = new THREE.Box3();
  asset.scene.updateMatrixWorld(true);
  asset.scene.traverse((object) => {
    object.matrixAutoUpdate = false;
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) inspection.geometries.add(mesh.geometry);
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material
        ? [mesh.material]
        : [];
    materials.forEach((material) => inspection.materials.add(material));
    if (reason) return;
    if (!finiteMatrix(object.matrix) || !finiteMatrix(object.matrixWorld)) {
      reason = 'non-finite-matrix';
      return;
    }
    const hooks: RenderHooks = object;
    const defaultHooks: RenderHooks = THREE.Object3D.prototype;
    if (
      !isDefaultObjectHook(hooks.onBeforeRender, defaultHooks.onBeforeRender) ||
      !isDefaultObjectHook(hooks.onAfterRender, defaultHooks.onAfterRender)
    ) {
      reason = 'mutable-render-hook';
      return;
    }
    if (!mesh.isMesh) return;
    if (
      (mesh as THREE.SkinnedMesh).isSkinnedMesh ||
      (mesh as THREE.InstancedMesh).isInstancedMesh
    ) {
      reason = (mesh as THREE.SkinnedMesh).isSkinnedMesh ? 'skinned-mesh' : 'instanced-mesh';
      return;
    }
    if (mesh.morphTargetInfluences || mesh.morphTargetDictionary) {
      reason = 'morph-target';
      return;
    }
    const geometry = mesh.geometry;
    if (!geometry) {
      reason = 'missing-geometry';
      return;
    }
    if (Object.keys(geometry.morphAttributes).length) {
      reason = 'morph-geometry';
      return;
    }
    if (geometry.userData?.__gimMutable === true) {
      reason = 'mutable-geometry-state';
      return;
    }
    for (const material of materials)
      if (
        material.userData?.__gimMutable === true ||
        material.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile ||
        material.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey
      ) {
        reason = 'mutable-material-state';
        return;
      }
    const position = geometry.getAttribute('position');
    if (!position?.count) return;
    // GLTFLoader normally supplies accessor bounds. Compute them only when absent.
    geometry.boundingBox ??= new THREE.Box3();
    if (geometry.boundingBox.isEmpty()) geometry.computeBoundingBox();
    box.copy(geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
    if (![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite)) {
      reason = 'non-finite-bounds';
      return;
    }
    inspection.bounds.union(box);
    renderable = true;
  });
  inspection.textures = collectTextures(inspection.materials);
  preparedInspections.set(asset.scene, inspection);
  if (reason) return { shareable: false, reason };
  if (!renderable) return { shareable: false, reason: 'empty-scene' };
  if (invalidGeometryBounds(inspection.bounds))
    return { shareable: false, reason: 'invalid-bounds' };
  return { shareable: true };
}

/** Convert only the placement translation from source millimetres to metres.
 * The cumulative source matrix remains before the template hierarchy; affine
 * shear, reflection and non-uniform scale are preserved without TRS decomposition. */
export function createSourcePlacementMatrix(rawPlacementMatrix?: number[] | null): THREE.Matrix4 {
  const placement = new THREE.Matrix4();
  if (
    !rawPlacementMatrix ||
    rawPlacementMatrix.length !== 16 ||
    rawPlacementMatrix.some((value) => !Number.isFinite(value))
  ) {
    return placement;
  }
  placement.fromArray(rawPlacementMatrix);
  placement.elements[12] *= 0.001;
  placement.elements[13] *= 0.001;
  placement.elements[14] *= 0.001;
  return placement;
}

/** Own the placement transform outside the immutable source template. This
 * same contract also applies to assets requiring independent per-instance data. */
export function placeSourceGeometry(
  source: THREE.Group,
  options: DevGlbPlacementOptions,
): THREE.Group {
  const wrapper = new THREE.Group();
  wrapper.matrixAutoUpdate = false;
  wrapper.matrix.copy(
    (options.projectSourceToViewerMatrix?.clone() ?? IDENTITY.clone()).multiply(
      createSourcePlacementMatrix(options.placementMatrix),
    ),
  );
  wrapper.add(source);
  wrapper.userData[DEV_GLB_TEMPLATE_PLACEMENT_USER_DATA_KEY] = true;
  wrapper.userData.rootOccurrence = options.rootOccurrence;
  wrapper.userData.instanceKey = options.instanceKey;
  wrapper.updateMatrixWorld(true);
  return wrapper;
}

export class DevGlbTemplate {
  private disposed = false;
  readonly geometryRefs: ReadonlySet<THREE.BufferGeometry>;
  readonly materialRefs: ReadonlySet<THREE.Material>;
  readonly textureRefs: ReadonlySet<THREE.Texture>;
  readonly bounds: THREE.Box3;

  constructor(
    readonly devPath: string,
    readonly scene: THREE.Group,
    readonly session?: ProjectSessionIdentity,
  ) {
    if (!preparedInspections.has(scene)) validateDevGlbTemplate({ scene });
    const inspection = preparedInspections.get(scene)!;
    preparedInspections.delete(scene);
    this.geometryRefs = inspection.geometries;
    this.materialRefs = inspection.materials;
    this.textureRefs = inspection.textures;
    this.bounds = inspection.bounds;
  }

  createPlacement(options: DevGlbPlacementOptions = {}): THREE.Group {
    if (this.disposed) throw new Error(`DEV template 已释放: ${this.devPath}`);
    const clone = this.scene.clone(true);
    const placed = placeSourceGeometry(clone, options);
    placed.userData.devPath = this.devPath;
    return placed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const geometry of this.geometryRefs) geometry.dispose();
    for (const material of this.materialRefs) material.dispose();
    for (const texture of this.textureRefs) texture.dispose();
  }
}

export interface DevGlbTemplatePoolOptions {
  session?: ProjectSessionIdentity;
  isCurrent?: () => boolean;
  parse: (devPath: string, bytes: Uint8Array) => Promise<DevGlbParsedAsset | null>;
}

export class DevGlbTemplatePool {
  private readonly preparations = new Map<string, DevGlbTemplatePreparation>();
  private readonly pending = new Map<string, Promise<DevGlbTemplatePreparation | null>>();
  private disposed = false;
  private metricsState: DevGlbTemplatePoolMetrics = {
    templateParseCount: 0,
    templateParseMs: 0,
    templateShareableCount: 0,
    templateFallbackCount: 0,
    fallbackDevPaths: [],
    fallbackReasons: {},
    sharedGeometryCount: 0,
    sharedMaterialCount: 0,
    sharedTextureCount: 0,
  };

  constructor(private readonly options: DevGlbTemplatePoolOptions) {}

  matchesSession(session: ProjectSessionIdentity): boolean {
    const own = this.options.session;
    if (!own) return true;
    return (
      own.generation === session.generation &&
      own.projectId === session.projectId &&
      own.sourceSha256 === session.sourceSha256 &&
      own.geometryToken === session.geometryToken
    );
  }

  async prepare(devPath: string, bytes: Uint8Array): Promise<DevGlbTemplatePreparation | null> {
    if (this.disposed) return null;
    const key = normalizeDevPath(devPath).toLowerCase();
    const existing = this.preparations.get(key);
    if (existing) return existing;
    const pending = this.pending.get(key);
    if (pending) return pending;

    const work = (async (): Promise<DevGlbTemplatePreparation | null> => {
      const started = performance.now();
      this.metricsState.templateParseCount++;
      let asset: DevGlbParsedAsset | null = null;
      try {
        asset = await this.options.parse(devPath, bytes);
      } catch {
        asset = null;
      } finally {
        this.metricsState.templateParseMs += Math.max(0, performance.now() - started);
      }
      if (!asset) return null;
      if (this.disposed || !this.isCurrent()) {
        disposeObjectResources(asset.scene);
        return null;
      }
      const validation = validateDevGlbTemplate(asset);
      if (!validation.shareable) {
        disposeObjectResources(asset.scene);
        if (validation.reason === 'invalid-bounds') return null;
        const exclusive: DevGlbTemplatePreparation = {
          kind: 'exclusive',
          fallbackReason: validation.reason,
        };
        this.preparations.set(key, exclusive);
        this.metricsState.templateFallbackCount++;
        this.metricsState.fallbackDevPaths.push(normalizeDevPath(devPath));
        this.metricsState.fallbackReasons[normalizeDevPath(devPath)] = validation.reason;
        return exclusive;
      }
      const template = new DevGlbTemplate(
        normalizeDevPath(devPath),
        asset.scene,
        this.options.session,
      );
      const shared: DevGlbTemplatePreparation = { kind: 'shared', template };
      this.preparations.set(key, shared);
      this.metricsState.templateShareableCount++;
      this.metricsState.sharedGeometryCount += template.geometryRefs.size;
      this.metricsState.sharedMaterialCount += template.materialRefs.size;
      this.metricsState.sharedTextureCount += template.textureRefs.size;
      return shared;
    })();
    this.pending.set(key, work);
    try {
      return await work;
    } finally {
      this.pending.delete(key);
    }
  }

  invalidate(devPath: string): void {
    const key = normalizeDevPath(devPath).toLowerCase();
    const existing = this.preparations.get(key);
    if (existing?.kind === 'shared') existing.template.dispose();
    this.preparations.delete(key);
  }

  metrics(): DevGlbTemplatePoolMetrics {
    return {
      ...this.metricsState,
      fallbackDevPaths: this.metricsState.fallbackDevPaths.slice(),
      fallbackReasons: { ...this.metricsState.fallbackReasons },
    };
  }

  /**
   * Current ownership counts, as opposed to the cumulative telemetry above.
   * This is intentionally count-only so memory checkpoints never copy resource
   * buffers or retain a second ownership graph.
   */
  currentResourceCounts(): {
    templateCount: number;
    sharedGeometryCount: number;
    sharedMaterialCount: number;
    sharedTextureCount: number;
  } {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    let templateCount = 0;
    for (const preparation of this.preparations.values()) {
      if (preparation.kind !== 'shared') continue;
      templateCount += 1;
      for (const geometry of preparation.template.geometryRefs) geometries.add(geometry);
      for (const material of preparation.template.materialRefs) materials.add(material);
      for (const texture of preparation.template.textureRefs) textures.add(texture);
    }
    return {
      templateCount,
      sharedGeometryCount: geometries.size,
      sharedMaterialCount: materials.size,
      sharedTextureCount: textures.size,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const preparation of this.preparations.values()) {
      if (preparation.kind === 'shared') preparation.template.dispose();
    }
    this.preparations.clear();
    this.pending.clear();
  }

  private isCurrent(): boolean {
    return this.options.isCurrent?.() ?? true;
  }
}

export function normalizeDevPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.replace(/^(?:\.\/)+/, '');
}

export function attachDevGlbTemplatePool(root: THREE.Group, pool: DevGlbTemplatePool): void {
  const existing: unknown = root.userData[DEV_GLB_TEMPLATE_POOL_USER_DATA_KEY];
  if (existing instanceof DevGlbTemplatePool && existing !== pool) existing.dispose();
  root.userData[DEV_GLB_TEMPLATE_POOL_USER_DATA_KEY] = pool;
}

export function getDevGlbTemplatePool(
  root: THREE.Group | null | undefined,
  session?: ProjectSessionIdentity,
): DevGlbTemplatePool | null {
  const value: unknown = root?.userData?.[DEV_GLB_TEMPLATE_POOL_USER_DATA_KEY];
  if (!(value instanceof DevGlbTemplatePool)) return null;
  return session && !value.matchesSession(session) ? null : value;
}

export function disposeDevGlbTemplatePool(
  root: THREE.Group | null | undefined,
  session?: ProjectSessionIdentity,
): void {
  const pool = getDevGlbTemplatePool(root, session);
  if (!pool) return;
  pool.dispose();
  // Do not delete a newer session's pool if this function was called after a
  // same-root replacement.  The identity check also keeps stale cleanup
  // idempotent when an A→B switch races the final A continuation.
  if (root?.userData?.[DEV_GLB_TEMPLATE_POOL_USER_DATA_KEY] === pool) {
    delete root.userData[DEV_GLB_TEMPLATE_POOL_USER_DATA_KEY];
  }
}

export async function runBudgetedPlacementWork<T>(
  items: readonly T[],
  work: (item: T, index: number) => Promise<void> | void,
  options: PlacementBudgetOptions,
): Promise<PlacementBudgetResult> {
  const maxSliceMs = Math.max(0.1, options.maxSliceMs ?? DEFAULT_MAX_SLICE_MS);
  const maxPlacementsPerSlice = Math.max(
    1,
    Math.floor(options.maxPlacementsPerSlice ?? DEFAULT_MAX_PLACEMENTS_PER_SLICE),
  );
  const sliceDurationsMs: number[] = [];
  let sliceCount = 0;
  let yieldCount = 0;
  let processedCount = 0;
  let sliceStarted = performance.now();
  let inSlice = 0;

  for (let index = 0; index < items.length; index++) {
    if (!options.isCurrent()) break;
    await work(items[index], index);
    processedCount++;
    inSlice++;
    const elapsed = Math.max(0, performance.now() - sliceStarted);
    const last = index === items.length - 1;
    const shouldYield = !last && (inSlice >= maxPlacementsPerSlice || elapsed >= maxSliceMs);
    if (shouldYield) {
      sliceDurationsMs.push(elapsed);
      sliceCount++;
      options.onSlice?.(elapsed, true);
      yieldCount++;
      await options.yieldToMain();
      if (!options.isCurrent()) {
        inSlice = 0;
        break;
      }
      sliceStarted = performance.now();
      inSlice = 0;
    }
  }

  if (inSlice > 0 || items.length === 0) {
    const elapsed = Math.max(0, performance.now() - sliceStarted);
    sliceDurationsMs.push(elapsed);
    sliceCount++;
    options.onSlice?.(elapsed, false);
  }

  return {
    placementCount: processedCount,
    sliceCount,
    yieldCount,
    maxSliceMs: sliceDurationsMs.length > 0 ? Math.max(...sliceDurationsMs) : 0,
    sliceDurationsMs,
  };
}
