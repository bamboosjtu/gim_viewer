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
import type { ProjectLoadSession } from '../app/state.js';

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
      kind: 'legacy';
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
export const DEV_GLB_LEGACY_PLACEMENT_USER_DATA_KEY = '__gimDevGlbLegacyPlacement';

const DEFAULT_MAX_SLICE_MS = 6;
const DEFAULT_MAX_PLACEMENTS_PER_SLICE = 32;

const IDENTITY = new THREE.Matrix4();

function finiteMatrix(matrix: THREE.Matrix4): boolean {
  return matrix.elements.every((value) => Number.isFinite(value));
}

function finiteAttribute(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined): boolean {
  if (!attribute) return true;
  for (let i = 0; i < attribute.count; i++) {
    for (let component = 0; component < attribute.itemSize; component++) {
      if (!Number.isFinite(attribute.getComponent(i, component))) return false;
    }
  }
  return true;
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

function isDefaultObjectHook(hook: unknown, defaultHook: unknown): boolean {
  return hook == null || hook === defaultHook;
}

/**
 * Validate the static subset emitted by the current GLTFExporter path.
 * Returning a reason instead of throwing lets the caller isolate one DEV and
 * use the existing legacy per-placement loader for that DEV only.
 */
export function validateDevGlbTemplate(
  asset: DevGlbParsedAsset,
): { shareable: true } | { shareable: false; reason: string } {
  if (!asset.scene) return { shareable: false, reason: 'missing-scene' };
  if (asset.animations && asset.animations.length > 0) {
    return { shareable: false, reason: 'animation-dependency' };
  }

  let renderable = false;
  let reason: string | null = null;
  asset.scene.updateMatrixWorld(true);
  asset.scene.traverse((object) => {
    if (reason) return;
    if (!finiteMatrix(object.matrix) || !finiteMatrix(object.matrixWorld)) {
      reason = 'non-finite-matrix';
      return;
    }
    if (!isDefaultObjectHook(object.onBeforeRender, THREE.Object3D.prototype.onBeforeRender)
      || !isDefaultObjectHook(object.onAfterRender, THREE.Object3D.prototype.onAfterRender)) {
      reason = 'mutable-render-hook';
      return;
    }
    const mesh = object as THREE.Mesh & {
      isSkinnedMesh?: boolean;
      isInstancedMesh?: boolean;
    };
    if (!mesh.isMesh) return;
    if (mesh.isSkinnedMesh || mesh.isInstancedMesh) {
      reason = mesh.isSkinnedMesh ? 'skinned-mesh' : 'instanced-mesh';
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
    if (Object.keys(geometry.morphAttributes).length > 0) {
      reason = 'morph-geometry';
      return;
    }
    if ((geometry.userData as Record<string, unknown> | undefined)?.__gimMutable === true) {
      reason = 'mutable-geometry-state';
      return;
    }
    const materialValue = mesh.material;
    const materials = Array.isArray(materialValue) ? materialValue : materialValue ? [materialValue] : [];
    for (const material of materials) {
      if ((material.userData as Record<string, unknown> | undefined)?.__gimMutable === true
        || material.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile
        || material.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey) {
        reason = 'mutable-material-state';
        return;
      }
    }
    const position = geometry.getAttribute('position');
    if (!position || position.count === 0) return;
    if (!finiteAttribute(position)) {
      reason = 'non-finite-geometry';
      return;
    }
    renderable = true;
  });

  if (reason) return { shareable: false, reason };
  if (!renderable) return { shareable: false, reason: 'empty-scene' };
  return { shareable: true };
}

/**
 * Preserve the exact legacy affine semantics:
 * - `applyPlacementTransformToSceneUnits` post-multiplies every mesh geometry
 *   by the CBM matrix after converting its translation from mm to m;
 * - `applyProjectSourceToViewer` calls `group.applyMatrix4(project)`.
 *
 * Therefore CBM belongs after each Mesh's original local matrix, while the
 * project matrix belongs before the original root local matrix.  No TRS
 * decomposition is used, so shear and non-uniform scale survive unchanged.
 */
export function createLegacyEquivalentPlacementMatrix(
  rawPlacementMatrix?: number[] | null,
): THREE.Matrix4 {
  const placement = new THREE.Matrix4();
  if (!rawPlacementMatrix || rawPlacementMatrix.length !== 16
    || rawPlacementMatrix.some((value) => !Number.isFinite(value))) {
    return placement;
  }
  placement.fromArray(rawPlacementMatrix);
  placement.elements[12] *= 0.001;
  placement.elements[13] *= 0.001;
  placement.elements[14] *= 0.001;
  return placement;
}

function freezeHierarchy(root: THREE.Object3D): void {
  root.traverse((object) => {
    object.matrixAutoUpdate = false;
  });
}

export class DevGlbTemplate {
  private disposed = false;
  readonly geometryRefs: ReadonlySet<THREE.BufferGeometry>;
  readonly materialRefs: ReadonlySet<THREE.Material>;
  readonly textureRefs: ReadonlySet<THREE.Texture>;

  constructor(
    readonly devPath: string,
    readonly scene: THREE.Group,
    readonly session?: ProjectLoadSession,
  ) {
    scene.updateMatrixWorld(true);
    freezeHierarchy(scene);
    const geometries = new Set<THREE.BufferGeometry>();
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) geometries.add(mesh.geometry);
    });
    this.geometryRefs = geometries;
    this.materialRefs = collectMaterials(scene);
    this.textureRefs = collectTextures(this.materialRefs);
  }

  createPlacement(options: DevGlbPlacementOptions = {}): THREE.Group {
    if (this.disposed) throw new Error(`DEV template 已释放: ${this.devPath}`);
    const placement = this.scene.clone(true) as THREE.Group;
    const cbm = createLegacyEquivalentPlacementMatrix(options.placementMatrix);
    const project = options.projectSourceToViewerMatrix;

    // A legacy geometry bake is equivalent to changing each Mesh local matrix
    // from L to L×CBM.  This is intentionally not a world-matrix assignment:
    // parent/nested hierarchy transforms must remain in the same order.
    placement.traverse((object) => {
      object.matrixAutoUpdate = false;
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) mesh.matrix.copy(mesh.matrix.clone().multiply(cbm));
    });

    const rootMatrix = (project ? project.clone() : IDENTITY.clone())
      .multiply(this.scene.matrix);
    placement.matrixAutoUpdate = false;
    placement.matrix.copy(rootMatrix);
    placement.updateMatrixWorld(true);
    placement.userData[DEV_GLB_TEMPLATE_PLACEMENT_USER_DATA_KEY] = true;
    placement.userData.devPath = this.devPath;
    if (options.instanceKey) placement.userData.instanceKey = options.instanceKey;
    return placement;
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
  session?: ProjectLoadSession;
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

  matchesSession(session: ProjectLoadSession): boolean {
    const own = this.options.session;
    if (!own) return true;
    return own.generation === session.generation
      && own.projectId === session.projectId
      && own.sourceSha256 === session.sourceSha256
      && own.geometryToken === session.geometryToken;
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
        const legacy: DevGlbTemplatePreparation = {
          kind: 'legacy',
          fallbackReason: validation.reason,
        };
        this.preparations.set(key, legacy);
        this.metricsState.templateFallbackCount++;
        this.metricsState.fallbackDevPaths.push(normalizeDevPath(devPath));
        this.metricsState.fallbackReasons[normalizeDevPath(devPath)] = validation.reason;
        return legacy;
      }
      const template = new DevGlbTemplate(normalizeDevPath(devPath), asset.scene, this.options.session);
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
  return normalized.toLowerCase().startsWith('dev/') ? normalized : `DEV/${normalized}`;
}

export function attachDevGlbTemplatePool(root: THREE.Group, pool: DevGlbTemplatePool): void {
  const existing = root.userData[DEV_GLB_TEMPLATE_POOL_USER_DATA_KEY];
  if (existing instanceof DevGlbTemplatePool && existing !== pool) existing.dispose();
  root.userData[DEV_GLB_TEMPLATE_POOL_USER_DATA_KEY] = pool;
}

export function getDevGlbTemplatePool(
  root: THREE.Group | null | undefined,
  session?: ProjectLoadSession,
): DevGlbTemplatePool | null {
  const value = root?.userData?.[DEV_GLB_TEMPLATE_POOL_USER_DATA_KEY];
  if (!(value instanceof DevGlbTemplatePool)) return null;
  return session && !value.matchesSession(session) ? null : value;
}

export function disposeDevGlbTemplatePool(
  root: THREE.Group | null | undefined,
  session?: ProjectLoadSession,
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
  const maxPlacementsPerSlice = Math.max(1, Math.floor(options.maxPlacementsPerSlice ?? DEFAULT_MAX_PLACEMENTS_PER_SLICE));
  const sliceDurationsMs: number[] = [];
  let sliceCount = 0;
  let yieldCount = 0;
  let processedCount = 0;
  let sliceStarted = performance.now();
  let inSlice = 0;

  for (let index = 0; index < items.length; index++) {
    if (!options.isCurrent()) break;
    await work(items[index]!, index);
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
