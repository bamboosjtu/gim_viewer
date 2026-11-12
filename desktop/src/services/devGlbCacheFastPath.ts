/** Bounded cached GLB reads, validation and occurrence placement. */
import * as THREE from 'three';
import type { SourceGeometryOccurrence } from '../gim/engineering/geometryOccurrences.js';
import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { DevCheckpointHandler } from './substationBackgroundRuntime.js';
import type { GeometryCacheManifest, GeometryCacheManifestEntry } from '@desktop/database.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import { createDevGeometryTelemetry, type DevGeometryTelemetry } from './devGeometryTelemetry.js';
import { attachDevGlbTemplatePool, disposeDevGlbTemplatePool, getDevGlbTemplatePool, DevGlbTemplatePool, runBudgetedPlacementWork, DEV_GLB_EXCLUSIVE_PLACEMENT_USER_DATA_KEY, placeSourceGeometry, getLoadedDevOccurrenceKind, type DevGlbParsedAsset } from './devGlbTemplateRuntime.js';
import { diagnosticForFailure, diagnosticFromManifest, setGeometryDiagnostic } from '../gim/geometry/geometryDiagnostics.js';
import { isGeometryContextValid } from './modGeometryContracts.js';
import type { AutoLoadProgress } from './modGeometryContracts.js';
import { normalizeDevEntryPath, createLazyGeometrySourceFiles } from './modGeometrySourceFiles.js';
import { ensureGeometryLayers, diagnoseGroupBBox } from './modGeometryScene.js';
import { stlSourceEnvelopeProof } from '../viewer/geometryBounds.js';

/**
 * 主入口：自动发现并加载变电工程中所有非 IFC 的 MOD/STL 几何。
 *
 * 调用时机：IFC 加载完成后（ViewerRuntime 已存在，scene 已可用）。
 *
 * @param state 全局 AppState（currentFiles 必须非空；currentCbmTree 必须非空）
 * @param scene THREE.Scene（来自 ctx.world.scene.three）
 * @param showProgress 进度回调（传入当前进度快照）
 * @returns 加载计数
 */

/**
 * 方案 C v3：DEV 粒度 GLB 快速路径。
 *
 * 先按 unique DEV 校验 manifest，再以二进制批次读取 GLB；同一 DEV 的 bytes
 * 只读一次，并进入 session-local template pool。clean static DEV 只 parse 一次，
 * placement 只 clone Object3D 节点并共享 immutable geometry/material；无法证明
 * 可共享的 DEV 才按 DEV 回退 legacy placement。
 *
 * 数学等价性：两次 applyPlacementTransformToSceneUnits（各 ×0.001）
 * 等价于一次完整应用（CBM × DEV × PHM，×0.001）。详见
 * docs/architecture.md。
 *
 * @returns loaded=true 表示 manifest 结构可用，成功/empty DEV 与失败 DEV
 * 均已按粒度归类；loaded=false 仅表示 manifest/工程级前置条件不可用，
 * 调用方才应整体回退到原始 MOD 粒度。
 */
/**
 * 主入口：自动发现并加载变电工程中所有非 IFC 的 MOD/STL 几何。
 *
 * 调用时机：IFC 加载完成后（ViewerRuntime 已存在，scene 已可用）。
 *
 * @param state 全局 AppState（currentFiles 必须非空；currentCbmTree 必须非空）
 * @param scene THREE.Scene（来自 ctx.world.scene.three）
 * @param showProgress 进度回调（传入当前进度快照）
 * @returns 加载计数
 */
/**
 * 方案 C v3：DEV 粒度 GLB 快速路径。
 *
 * 先按 unique DEV 校验 manifest，再以二进制批次读取 GLB；同一 DEV 的 bytes
 * 只读一次，并进入 session-local template pool。clean static DEV 只 parse 一次，
 * placement 只 clone Object3D 节点并共享 immutable geometry/material；无法证明
 * 可共享的 DEV 才按 DEV 回退 legacy placement。
 *
 * 数学等价性：两次 applyPlacementTransformToSceneUnits（各 ×0.001）
 * 等价于一次完整应用（CBM × DEV × PHM，×0.001）。详见
 * docs/architecture.md。
 *
 * @returns loaded=true 表示 manifest 结构可用，成功/empty DEV 与失败 DEV
 * 均已按粒度归类；loaded=false 仅表示 manifest/工程级前置条件不可用，
 * 调用方才应整体回退到原始 MOD 粒度。
 */
export interface DevGlbFastPathProfile {
  cbmInstanceCount: number;
  uniqueDevCount: number;
  glbDevCount: number;
  emptyDevCount: number;
  /** DEV 内有非空但当前 renderer 不支持的 geometry source。 */
  unsupportedDevCount?: number;
  glbBatchReadMs: number;
  glbReadBytes: number;
  glbParseCount: number;
  glbParseMs: number;
  /** 兼容旧诊断：全局回退为 1，partial fallback 为失败 DEV 数，成功为 0。 */
  rawModFallbackCount: number;
  /** 仅失败 DEV 的定向 raw fallback 数。 */
  partialRawFallbackCount: number;
  /** 失败 DEV 对应的 CBM placement 实例数。 */
  partialRawFallbackInstanceCount: number;
  /** 只有该 DEV 的所有 GLB placement 均成功时才计数。 */
  successfulGlbDevCount: number;
  /** 成功加载的 GLB placement 数。 */
  successfulGlbInstanceCount: number;
  /** project-level fallback 次数；partial failure 时必须为 0。 */
  fullProjectRawFallbackCount: number;
  /** 按规范化 DEV 路径记录失败类型。 */
  failureType: Record<string, DevGlbFailureType>;
  failedDevCount: number;
  failedDevPaths: string[];
  /** scoped raw fallback 诊断（不影响旧字段语义）。 */
  partialRawFallbackMs: number;
  partialRawFallbackReadMs: number;
  partialRawFallbackParseMs: number;
  partialRawFallbackRows: number;
  /** 单 DEV cache recovery 诊断，不改变旧 fallback 字段语义。 */
  cacheRecoveryAttemptCount?: number;
  cacheRecoverySuccessCount?: number;
  cacheRecoveryEmptyCount?: number;
  cacheRecoveryFailureCount?: number;
  cacheRecoveryDevPaths?: string[];
  fallbackReason?: string;
  /** Phase 4 template/placement diagnostics. */
  uniqueGlbDevCount?: number;
  templateParseCount?: number;
  templateParseMs?: number;
  templateShareableCount?: number;
  templateFallbackCount?: number;
  fallbackDevPaths?: string[];
  fallbackReasons?: Record<string, string>;
  sharedPlacementCount?: number;
  exclusiveFallbackPlacementCount?: number;
  sharedGeometryCount?: number;
  sharedMaterialCount?: number;
  sharedTextureCount?: number;
  placementMatrixMs?: number;
  bboxMs?: number;
  sceneCommitMs?: number;
  placementYieldCount?: number;
  placementSliceCount?: number;
  maxPlacementSliceMs?: number;
  placementSliceP50Ms?: number;
  placementSliceP95Ms?: number;
  /** Warm DEV GLB aggregate spans; placement-level traces are histogrammed. */
  deepTelemetry?: DevGeometryTelemetry;
}

export type DevGlbFailureType = 'missing' | 'invalid' | 'parse-exception' | 'empty-scene' | 'unsupported';

export interface DevGlbFastPathResult {
  loaded: boolean;
  modCount: number;
  stlCount: number;
  profile: DevGlbFastPathProfile;
}

export interface DevGlbFastPathDependencies {
  loadDevGlb: (devPath: string, bytes: Uint8Array) => Promise<THREE.Group | null>;
  /** Phase 4 production parser retains animations for shareability validation. */
  parseDevGlbAsset?: (devPath: string, bytes: Uint8Array) => Promise<DevGlbParsedAsset | null>;
  applyPlacementTransformToSceneUnits: (group: THREE.Group, transformMatrix: number[] | null | undefined) => void;
  /** v3：仅读取 manifest 描述；缺省时由 bridge 动态提供。 */
  readGeometryCacheManifest?: (projectId: number) => Promise<GeometryCacheManifest>;
  /** v3：GIMR 二进制 envelope 批读；缺省时由 bridge 动态提供。 */
  batchReadGlbFiles?: (projectId: number, entryPaths: string[]) => Promise<Map<string, Uint8Array | null>>;
}

export const GLB_BATCH_MAX_FILES = 256;

export const GLB_BATCH_MAX_BYTES = 64 * 1024 * 1024;

export function disposeFastPathGroup(group: THREE.Group): void {
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material ? [mesh.material] : [];
    for (const material of materials) material?.dispose?.();
  });
}

export function validateCachedGlbBytes(bytes: Uint8Array | null | undefined): boolean {
  if (!bytes || bytes.byteLength < 12) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, false) === 0x676c5446 // "glTF"
    && view.getUint32(4, true) === 2
    && view.getUint32(8, true) === bytes.byteLength;
}

/**
 * A syntactically valid GLB can still decode to an empty scene when its
 * payload was produced by a broken/partial exporter. Treat that as a parse
 * failure so the caller falls back to the raw MOD/STL source. A valid cache
 * generated by serializeDevToGlb always contains at least one positioned
 * mesh; bbox rejects (for example, a runaway placement) remain a per-instance
 * quality decision handled below.
 */
export function hasRenderableGlbGeometry(group: THREE.Group): boolean {
  let found = false;
  group.traverse((object) => {
    if (found) return;
    const mesh = object as THREE.Mesh;
    const position = mesh.geometry?.getAttribute?.('position');
    if ((mesh as THREE.Mesh).isMesh && position && position.count > 0) found = true;
  });
  return found;
}

export function emptyFastPathProfile(cbmInstanceCount: number, uniqueDevCount: number): DevGlbFastPathProfile {
  return {
    cbmInstanceCount,
    uniqueDevCount,
    glbDevCount: 0,
    emptyDevCount: 0,
    unsupportedDevCount: 0,
    glbBatchReadMs: 0,
    glbReadBytes: 0,
    glbParseCount: 0,
    glbParseMs: 0,
    rawModFallbackCount: 0,
    partialRawFallbackCount: 0,
    partialRawFallbackInstanceCount: 0,
    successfulGlbDevCount: 0,
    successfulGlbInstanceCount: 0,
    fullProjectRawFallbackCount: 0,
    failureType: {},
    failedDevCount: 0,
    failedDevPaths: [],
    partialRawFallbackMs: 0,
    partialRawFallbackReadMs: 0,
    partialRawFallbackParseMs: 0,
    partialRawFallbackRows: 0,
    cacheRecoveryAttemptCount: 0,
    cacheRecoverySuccessCount: 0,
    cacheRecoveryEmptyCount: 0,
    cacheRecoveryFailureCount: 0,
    cacheRecoveryDevPaths: [],
    uniqueGlbDevCount: uniqueDevCount,
    templateParseCount: 0,
    templateParseMs: 0,
    templateShareableCount: 0,
    templateFallbackCount: 0,
    fallbackDevPaths: [],
    fallbackReasons: {},
    sharedPlacementCount: 0,
    exclusiveFallbackPlacementCount: 0,
    sharedGeometryCount: 0,
    sharedMaterialCount: 0,
    sharedTextureCount: 0,
    placementMatrixMs: 0,
    bboxMs: 0,
    sceneCommitMs: 0,
    placementYieldCount: 0,
    placementSliceCount: 0,
    maxPlacementSliceMs: 0,
    placementSliceP50Ms: 0,
    placementSliceP95Ms: 0,
  };
}

export async function tryDevGlbFastPath(
  state: AppState,
  scene: THREE.Scene,
  deviceNodes: SourceGeometryOccurrence[],
  showProgress: (p: AutoLoadProgress) => void,
  token?: number,
  dependencies?: DevGlbFastPathDependencies,
  context?: {
    generation?: number;
    projectId?: number | null;
    sourceSha256?: string | null;
    session?: ProjectLoadSession;
    geometryCacheValid?: boolean;
    onDevCheckpoint?: DevCheckpointHandler;
  },
): Promise<DevGlbFastPathResult> {
  const uniqueKeys = new Set<string>();
  for (const seed of deviceNodes) if (seed.devPath) uniqueKeys.add(normalizeDevEntryPath(seed.devPath).toLowerCase());
  const fastPathStarted = performance.now();
  const deepTelemetry = createDevGeometryTelemetry('warm', uniqueKeys.size, deviceNodes.length);
  const profile = emptyFastPathProfile(deviceNodes.length, uniqueKeys.size);
  const failedDevPaths = new Map<string, string>();
  const failureTypes: Record<string, DevGlbFailureType> = {};
  const devOrder: string[] = [];
  const seedsByDev = new Map<string, SourceGeometryOccurrence[]>();

  const syncFailureProfile = (): void => {
    const paths = Array.from(failedDevPaths.values());
    profile.failedDevCount = paths.length;
    profile.failedDevPaths = paths;
    profile.failureType = { ...failureTypes };
    profile.partialRawFallbackCount = paths.length;
    profile.partialRawFallbackInstanceCount = paths.reduce(
      (sum, path) => sum + (seedsByDev.get(path.toLowerCase())?.length ?? 0),
      0,
    );
    profile.rawModFallbackCount = paths.length;
  };

  const markDevFailure = (devPath: string, type: DevGlbFailureType): void => {
    const key = normalizeDevEntryPath(devPath).toLowerCase();
    if (!failedDevPaths.has(key)) {
      const canonical = devOrder.find((path) => path.toLowerCase() === key) ?? normalizeDevEntryPath(devPath);
      failedDevPaths.set(key, canonical);
      failureTypes[canonical] = type;
    }
    syncFailureProfile();
    if (isCurrent()) {
      setGeometryDiagnostic(
        state,
        diagnosticForFailure(
          devPath,
          type === 'missing' ? 'missing-dependency' : 'parse-failed',
          'warm',
          type === 'missing'
            ? '缓存条目或几何依赖缺失；仅该 DEV 进入原始几何回退。'
            : undefined,
        ),
      );
    }
  };

  const fail = (reason: string, modCount = 0): DevGlbFastPathResult => ({
    loaded: false,
    modCount,
    stlCount: 0,
    profile: {
      ...profile,
      rawModFallbackCount: 1,
      fullProjectRawFallbackCount: 1,
      fallbackReason: reason,
      failureType: { ...failureTypes },
      failedDevCount: failedDevPaths.size,
      failedDevPaths: Array.from(failedDevPaths.values()),
      deepTelemetry: deepTelemetry.snapshot(performance.now() - fastPathStarted),
    },
  });
  const success = (modCount: number): DevGlbFastPathResult => ({
    loaded: true,
    modCount,
    stlCount: 0,
    profile: {
      ...profile,
      rawModFallbackCount: profile.partialRawFallbackCount,
      fullProjectRawFallbackCount: 0,
      failureType: { ...failureTypes },
      failedDevCount: failedDevPaths.size,
      failedDevPaths: Array.from(failedDevPaths.values()),
      deepTelemetry: deepTelemetry.snapshot(performance.now() - fastPathStarted),
    },
  });

  const capturedProjectId = context?.session?.projectId ?? context?.projectId ?? state.currentProjectId;
  const capturedGeneration = context?.session?.generation ?? context?.generation ?? state.projectGeneration;
  const capturedSourceSha256 = context?.session?.sourceSha256 ?? context?.sourceSha256 ?? state.currentSourceSha256;
  const session: ProjectLoadSession = context?.session ?? {
    generation: capturedGeneration,
    projectId: capturedProjectId,
    sourceSha256: capturedSourceSha256,
    geometryToken: token ?? state.geometryLoadToken,
  };
  const isCurrent = () => {
    const stateSessionCheck = typeof state.isCurrentSession === 'function'
      ? state.isCurrentSession(session)
      : isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256);
    return stateSessionCheck && (token === undefined || state.geometryLoadToken === token);
  };

  if (capturedProjectId == null || deviceNodes.length === 0 || uniqueKeys.size === 0) return fail('no-project-or-dev');
  // 1. 按 unique DEV 建立 placement 映射；同一 DEV 的不同 CBM 实例保留全部。
  for (const seed of deviceNodes) {
    if (!seed.devPath) continue;
    const devPath = normalizeDevEntryPath(seed.devPath);
    const key = devPath.toLowerCase();
    const existing = seedsByDev.get(key);
    if (existing) existing.push(seed);
    else {
      seedsByDev.set(key, [seed]);
      devOrder.push(devPath);
    }
  }
  deepTelemetry.record('discovery', performance.now() - fastPathStarted);

  const manifestEntries = new Map<string, GeometryCacheManifestEntry>();
  {
    const readManifest = dependencies?.readGeometryCacheManifest
      ?? (await import('@desktop/database.js')).readGeometryCacheManifest;
    let manifest: GeometryCacheManifest;
    try {
      manifest = await readManifest(capturedProjectId);
    } catch (err) {
      debugLog(DEBUG_IFC_LOAD, '[autoLoad] DEV GLB manifest 不可读，回退原始 MOD', err);
      return fail('manifest-read-failed');
    }
    if (!isCurrent()) return fail('session-invalid');
    if (capturedSourceSha256 && manifest.source_sha256 !== capturedSourceSha256) return fail('manifest-source-mismatch');
    if (!Array.isArray(manifest.entries) || manifest.entries.length > 200_000) return fail('manifest-invalid');
    for (const entry of manifest.entries) {
      if (!entry || typeof entry.entry_path !== 'string') return fail('manifest-entry-invalid');
      const key = normalizeDevEntryPath(entry.entry_path).toLowerCase();
      if (manifestEntries.has(key)
        || !/\.dev$/i.test(entry.entry_path)
        || !(['glb', 'partial', 'empty', 'unsupported', 'source-invalid'] as string[]).includes(entry.status)
        || (entry.status === 'source-invalid' && (entry.size !== 0 || !entry.diagnostic?.trim()))
        || ((entry.status === 'empty' || entry.status === 'unsupported') && entry.size !== 0)
        || ((entry.status === 'glb' || entry.status === 'partial')
          && (!Number.isSafeInteger(entry.size) || entry.size <= 0))) {
        return fail(`manifest-entry-invalid:${entry.entry_path}`);
      }
      manifestEntries.set(key, entry);
    }
  }

  // Keep track of what the persisted manifest actually advertised. Missing
  // DEV paths below receive an internal synthetic entry so the placement loop
  // can stay uniform, but that placeholder must not inflate `glbDevCount`.
  const advertisedManifestKeys = new Set(manifestEntries.keys());

  // manifest 结构本身有效但缺少某个 DEV 时，只把该 DEV 标记为 missing。
  // 这样一个半成品/旧 manifest 不会清理其它已经可用的 GLB 实例。
  const selectedEntries = devOrder.map((devPath) => {
    const entry = manifestEntries.get(devPath.toLowerCase());
    if (entry) return entry;
    markDevFailure(devPath, 'missing');
    const missingEntry = { entry_path: devPath, status: 'glb' as const, size: 0 };
    manifestEntries.set(devPath.toLowerCase(), missingEntry);
    return missingEntry;
  });
  // Warm manifest is the persisted source of truth for deterministic
  // empty/unsupported/partial results.  Do not overwrite a missing-entry
  // failure recorded above with the synthetic `glb` placeholder.
  for (const entry of selectedEntries) {
    const key = normalizeDevEntryPath(entry.entry_path).toLowerCase();
    if (!failedDevPaths.has(key)) {
      setGeometryDiagnostic(state, diagnosticFromManifest(entry.entry_path, entry));
    }
  }
  // `glbDevCount` describes what the manifest advertised.  Keep it separate
  // from `successfulGlbDevCount`, which is populated after parse/scene
  // validation; otherwise a corrupt entry disappears from diagnostics and a
  // partial failure looks like a smaller project rather than an isolated
  // failed DEV.
  profile.glbDevCount = selectedEntries.filter((entry) =>
    (entry.status === 'glb' || entry.status === 'partial')
    && advertisedManifestKeys.has(normalizeDevEntryPath(entry.entry_path).toLowerCase()),
  ).length;
  profile.emptyDevCount = selectedEntries.filter((entry) => entry.status === 'empty').length;
  profile.unsupportedDevCount = selectedEntries.filter((entry) => entry.status === 'unsupported').length;

  // 2. 先读取全部 unique DEV GLB bytes，再进入 placement parse；空 DEV 不读取。
  const glbBytesByDev = new Map<string, Uint8Array | null>();
  // Missing manifest entries are represented by a synthetic zero-size entry
  // so the per-DEV state is explicit, but they must not be sent back through
  // the batch reader.  Doing so would turn one missing DEV into a second
  // pointless IPC miss (and can obscure the original `missing` diagnosis).
  const glbPaths = selectedEntries
    .filter((entry) => (entry.status === 'glb' || entry.status === 'partial')
      && !failedDevPaths.has(normalizeDevEntryPath(entry.entry_path).toLowerCase()))
    .map((entry) => entry.entry_path);
  const batchStarted = performance.now();
  try {
    {
      const batchReadGlbFiles = dependencies?.batchReadGlbFiles
        ?? (await import('@desktop/database.js')).batchReadGlbFiles;
      for (let start = 0;start < glbPaths.length;) {
        if (!isCurrent()) return fail('session-invalid');
        const unitStarted = performance.now();
        const batch: string[] = [];
        let expectedBytes = 0;
        while (start < glbPaths.length && batch.length < GLB_BATCH_MAX_FILES) {
          const batchPath = normalizeDevEntryPath(glbPaths[start]);
          const entry = manifestEntries.get(batchPath.toLowerCase())!;
          const nextSize = Math.max(0, entry.size);
          if (batch.length > 0 && expectedBytes + nextSize > GLB_BATCH_MAX_BYTES) break;
          batch.push(glbPaths[start]);
          expectedBytes += nextSize;
          start++;
        }
        if (batch.length === 0) {
          // 单个大 GLB 独占一个批次；Rust 侧仍有 512 MiB 单文件上限。
          batch.push(glbPaths[start]);
          start++;
        }
        let bytesMap: Map<string, Uint8Array | null>;
        try {
          bytesMap = await batchReadGlbFiles(capturedProjectId, batch);
        } catch (error) {
          if (!isCurrent()) return fail('session-invalid');
          // 单批 IPC 失败时只隔离这一批 DEV；其它批次仍可继续命中。
          for (const path of batch) {
            glbBytesByDev.set(normalizeDevEntryPath(path).toLowerCase(), null);
            markDevFailure(path, 'missing');
          }
          debugLog(DEBUG_IFC_LOAD, '[autoLoad] 单批 DEV GLB 读取失败，转为 scoped fallback', error);
          await context?.onDevCheckpoint?.({ phase: 'warm-glb-read', path: batch.join('|'), durationMs: performance.now() - unitStarted });
          continue;
        }
        if (!isCurrent()) return fail('session-invalid');
        const normalizedResults = new Map<string, Uint8Array | null>();
        for (const [path, bytes] of bytesMap) normalizedResults.set(normalizeDevEntryPath(path).toLowerCase(), bytes);
        for (const path of batch) {
          const key = normalizeDevEntryPath(path).toLowerCase();
          glbBytesByDev.set(key, normalizedResults.get(key) ?? null);
        }
        await context?.onDevCheckpoint?.({ phase: 'warm-glb-read', path: batch.join('|'), durationMs: performance.now() - unitStarted });
      }
    }
  } catch (err) {
    debugLog(DEBUG_IFC_LOAD, '[autoLoad] DEV GLB 批量读取失败，回退原始 MOD', err);
    return fail('glb-batch-read-failed');
  }
  profile.glbBatchReadMs = Math.max(0, performance.now() - batchStarted);
  deepTelemetry.record('glbRead', profile.glbBatchReadMs);

  for (const entry of selectedEntries) {
    if (entry.status !== 'glb' && entry.status !== 'partial') continue;
    // The batch response map is keyed by the canonical slash-separated path;
    // manifests produced by older/exporter variants may still use backslashes.
    // Normalize here as well as during manifest lookup so a valid cache is not
    // mistaken for a missing GLB on a path-separator-only variation.
    const bytes = glbBytesByDev.get(normalizeDevEntryPath(entry.entry_path).toLowerCase());
    if (!bytes) {
      markDevFailure(entry.entry_path, 'missing');
      continue;
    }
    if ((bytes.byteLength !== entry.size || !validateCachedGlbBytes(bytes))) {
      markDevFailure(entry.entry_path, 'invalid');
      continue;
    }
    if (bytes) profile.glbReadBytes += bytes.byteLength;
  }
  if (!isCurrent()) return fail('session-invalid');

  const glbCache = dependencies?.loadDevGlb
    ? null
    : await import('./glbCacheService.js');
  const loadDevGlb = dependencies?.loadDevGlb ?? glbCache!.loadDevGlb;
  const parseDevGlbAsset = dependencies?.parseDevGlbAsset
    ?? (dependencies?.loadDevGlb
      ? async (devPath: string, bytes: Uint8Array): Promise<DevGlbParsedAsset | null> => {
        const group = await loadDevGlb(devPath, bytes);
        return group ? { scene: group, animations: [] } : null;
      }
      : glbCache!.parseDevGlbAsset);
  const { modRoot } = ensureGeometryLayers(state, scene);
  let proofSourceFiles=state.currentFiles;
  const verifySourceEnvelope=async(devPath:string,asset:THREE.Group)=>{
    if(!stlSourceEnvelopeProof(asset))return;
    const {verifyDevGlbSourceEnvelope}=await import('./devGlbSourceEvidence.js');
    proofSourceFiles??=createLazyGeometrySourceFiles(capturedProjectId,state.substationEntryPaths,state.substationEntrySizes,isCurrent);
    await verifyDevGlbSourceEnvelope(asset,devPath,proofSourceFiles,isCurrent);
  };
  const templatePool = getDevGlbTemplatePool(modRoot, session) ?? new DevGlbTemplatePool({
    session,
    isCurrent,
    parse: parseDevGlbAsset,
    verifySourceEnvelope,
  });
  attachDevGlbTemplatePool(modRoot, templatePool);
  const syncTemplateMetrics = (): void => {
    const metrics = templatePool.metrics();
    profile.uniqueGlbDevCount = profile.glbDevCount;
    profile.templateParseCount = metrics.templateParseCount;
    profile.templateParseMs = metrics.templateParseMs;
    profile.templateShareableCount = metrics.templateShareableCount;
    profile.templateFallbackCount = metrics.templateFallbackCount;
    profile.fallbackDevPaths = metrics.fallbackDevPaths;
    profile.fallbackReasons = metrics.fallbackReasons;
    profile.sharedGeometryCount = metrics.sharedGeometryCount;
    profile.sharedMaterialCount = metrics.sharedMaterialCount;
    profile.sharedTextureCount = metrics.sharedTextureCount;
    deepTelemetry.setTemplateMetrics({
      uniqueGlbDevCount: profile.glbDevCount,
      templateParseCount: metrics.templateParseCount,
      templateParseMs: metrics.templateParseMs,
      templateShareableCount: metrics.templateShareableCount,
      templateFallbackCount: metrics.templateFallbackCount,
      fallbackDevPaths: metrics.fallbackDevPaths,
      fallbackReasons: metrics.fallbackReasons,
      sharedGeometryCount: metrics.sharedGeometryCount,
      sharedMaterialCount: metrics.sharedMaterialCount,
      sharedTextureCount: metrics.sharedTextureCount,
    });
  };
  type AddedGroup = { instanceKey: string; group: THREE.Group; shared: boolean };
  const addedGroups: AddedGroup[] = [];
  const addedGroupsByDev = new Map<string, AddedGroup[]>();
  const totalSeeds = deviceNodes.length;
  let loadedCount = 0;
  let processedCount = 0;
  showProgress({ phase: 'loading_mod', collectedDevPaths: deviceNodes.length, discoveredMods: totalSeeds, discoveredStls: 0, loadedMods: 0, loadedStls: 0, totalMods: totalSeeds, totalStls: 0 });

  const cleanupAndFail = (reason: string): DevGlbFastPathResult => {
    for (const { instanceKey, group, shared } of addedGroups) {
      modRoot.remove(group);
      state.loadedXmlModGroups.delete(instanceKey);
      if (!shared) disposeFastPathGroup(group);
    }
    disposeDevGlbTemplatePool(modRoot, session);
    return fail(reason);
  };

  const removeDevGroups = (devPath: string): void => {
    const key = devPath.toLowerCase();
    const groups = addedGroupsByDev.get(key) ?? [];
    for (const { instanceKey, group, shared } of groups) {
      modRoot.remove(group);
      state.loadedXmlModGroups.delete(instanceKey);
      const index = addedGroups.findIndex((item) => item.instanceKey === instanceKey);
      if (index >= 0) addedGroups.splice(index, 1);
      if (!shared) disposeFastPathGroup(group);
      loadedCount = Math.max(0, loadedCount - 1);
    }
    addedGroupsByDev.delete(key);
  };

  const markProcessed = (): void => {
    processedCount++;
    showProgress({ phase: 'loading_mod', collectedDevPaths: deviceNodes.length, discoveredMods: totalSeeds, discoveredStls: 0, loadedMods: loadedCount, loadedStls: 0, totalMods: totalSeeds, totalStls: 0, processedMods: processedCount });
  };

  const yieldToPlacementMain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  for (const devPath of devOrder) {
    if (!isCurrent()) return cleanupAndFail('session-invalid');
    const devTelemetryStarted = deepTelemetry.beginDev(
      devPath,
      seedsByDev.get(devPath.toLowerCase())?.length ?? 0,
    );
    const entry = manifestEntries.get(devPath.toLowerCase())!;
    const bytes = (entry.status === 'glb' || entry.status === 'partial')
      ? glbBytesByDev.get(devPath.toLowerCase())!
      : null;
    const failedKey = devPath.toLowerCase();
    const devSeeds = seedsByDev.get(failedKey) ?? [];
    if (failedDevPaths.has(failedKey)) {
      for (const _seed of devSeeds) markProcessed();
      deepTelemetry.finishDev(devPath, devTelemetryStarted);
      await context?.onDevCheckpoint?.({ phase: 'warm-dev', path: devPath, durationMs: performance.now() - devTelemetryStarted });
      continue;
    }

    let preparation: Awaited<ReturnType<DevGlbTemplatePool['prepare']>> = null;
    if ((entry.status === 'glb' || entry.status === 'partial') && bytes) {
      const parseBefore = templatePool.metrics();
      preparation = await templatePool.prepare(devPath, bytes);
      const parseAfter = templatePool.metrics();
      if (parseAfter.templateParseCount > parseBefore.templateParseCount) {
        deepTelemetry.recordTemplateParse(
          Math.max(0, parseAfter.templateParseMs - parseBefore.templateParseMs),
          devPath,
        );
      }
      syncTemplateMetrics();
      const metrics = templatePool.metrics();
      profile.glbParseCount = metrics.templateParseCount;
      profile.glbParseMs = metrics.templateParseMs;
      if (!isCurrent()) return cleanupAndFail('session-invalid');
      if (!preparation) markDevFailure(devPath, 'parse-exception');
    }

    let devInvalidated = false;
    await runBudgetedPlacementWork(devSeeds, async (seed) => {
      if (failedDevPaths.has(failedKey) || devInvalidated) {
        markProcessed();
        return;
      }
      if (!isCurrent()) {
        devInvalidated = true;
        return;
      }
      const instanceKey = `dev:${devPath}#${seed.id}`;
      if (state.loadedXmlModGroups.has(instanceKey) || getLoadedDevOccurrenceKind(state, seed.id)) {
        loadedCount++;
        markProcessed();
        return;
      }
      if (entry.status === 'empty' || entry.status === 'unsupported' || !bytes || !preparation) {
        markProcessed();
        return;
      }

      let loadedGroup: THREE.Group | null = null;
      const shared = preparation.kind === 'shared';
      try {
        const cbmTransform = seed.placementMatrix;
        if (preparation.kind === 'shared') {
          const matrixStarted = performance.now();
          loadedGroup = preparation.template.createPlacement({
            instanceKey,
            placementMatrix: cbmTransform,
            projectSourceToViewerMatrix: state.projectSourceToViewerMatrix,
          });
          deepTelemetry.recordPlacementMatrix(performance.now() - matrixStarted, devPath);
        } else {
          const parseStarted = performance.now();
          profile.glbParseCount++;
          try {
            loadedGroup = await loadDevGlb(devPath, bytes);
          } finally {
            const parseMs = Math.max(0, performance.now() - parseStarted);
            profile.glbParseMs += parseMs;
            deepTelemetry.record('glbParse', parseMs, devPath);
          }
          if (!loadedGroup) {
            markDevFailure(devPath, 'parse-exception');
            removeDevGroups(devPath);
            return;
          }
          if (!hasRenderableGlbGeometry(loadedGroup)) {
            disposeFastPathGroup(loadedGroup);
            loadedGroup = null;
            markDevFailure(devPath, 'empty-scene');
            removeDevGroups(devPath);
            return;
          }
          const transformStarted = performance.now();
          await verifySourceEnvelope(devPath,loadedGroup);
          loadedGroup = placeSourceGeometry(loadedGroup, {
            rootOccurrence: seed.id, instanceKey,
            placementMatrix: cbmTransform, projectSourceToViewerMatrix: state.projectSourceToViewerMatrix
          });
          deepTelemetry.record('placementTransform', performance.now() - transformStarted, devPath);
        }

        if (!isCurrent()) {
          if (loadedGroup && !shared) disposeFastPathGroup(loadedGroup);
          devInvalidated = true;
          return;
        }
        if (!loadedGroup) {
          markDevFailure(devPath, 'parse-exception');
          removeDevGroups(devPath);
          return;
        }
        const bboxStarted = performance.now();
        const bboxValid = diagnoseGroupBBox(loadedGroup, devPath, { disposeOnFailure: !shared });
        deepTelemetry.record('bbox', performance.now() - bboxStarted, devPath);
        if (!bboxValid) {
          if (loadedGroup && !shared) disposeFastPathGroup(loadedGroup);
          loadedGroup = null;
          return;
        }

        loadedGroup.userData.devPath = devPath;
        if (getLoadedDevOccurrenceKind(state, seed.id)) {
          if (!shared) disposeFastPathGroup(loadedGroup);
          loadedCount++; markProcessed(); return;
        }
        loadedGroup.userData.rootOccurrence = seed.id;
        loadedGroup.userData.instanceKey = instanceKey;
        if (!shared) loadedGroup.userData[DEV_GLB_EXCLUSIVE_PLACEMENT_USER_DATA_KEY] = true;
        const sceneCommitStarted = performance.now();
        modRoot.add(loadedGroup);
        state.loadedXmlModGroups.set(instanceKey, loadedGroup);
        deepTelemetry.record('sceneCommit', performance.now() - sceneCommitStarted, devPath);
        if (shared) {
          deepTelemetry.recordSharedPlacement(devPath);
          profile.sharedPlacementCount = (profile.sharedPlacementCount ?? 0) + 1;
        } else {
          deepTelemetry.recordExclusiveFallbackPlacement(devPath);
          profile.exclusiveFallbackPlacementCount = (profile.exclusiveFallbackPlacementCount ?? 0) + 1;
        }
        const added: AddedGroup = { instanceKey, group: loadedGroup, shared };
        addedGroups.push(added);
        const perDev = addedGroupsByDev.get(failedKey) ?? [];
        perDev.push(added);
        addedGroupsByDev.set(failedKey, perDev);
        loadedGroup = null;
        loadedCount++;
      } catch (err) {
        if (loadedGroup && !shared) disposeFastPathGroup(loadedGroup);
        console.error(`[autoLoad] DEV GLB placement 加载失败: ${devPath} #${seed.id}`, err);
        markDevFailure(devPath, 'parse-exception');
        if (shared) templatePool.invalidate(devPath);
        removeDevGroups(devPath);
      } finally {
        markProcessed();
      }
    }, {
      maxSliceMs: 6,
      maxPlacementsPerSlice: 32,
      yieldToMain: yieldToPlacementMain,
      isCurrent,
      onSlice: (durationMs, yielded) => {
        deepTelemetry.recordPlacementSlice(durationMs, yielded, devPath);
      },
    });
    syncTemplateMetrics();
    if (!isCurrent() || devInvalidated) return cleanupAndFail('session-invalid');
    deepTelemetry.finishDev(devPath, devTelemetryStarted);
    await context?.onDevCheckpoint?.({ phase: 'warm-dev', path: devPath, durationMs: performance.now() - devTelemetryStarted });
  }

  if (!isCurrent()) return cleanupAndFail('session-invalid');
  debugLog(DEBUG_IFC_LOAD, `[autoLoad] DEV GLB 快速路径完成: ${loadedCount} 个 CBM placement，${profile.glbDevCount} 个 GLB DEV，${profile.emptyDevCount} 个 empty DEV`);
  showProgress({ phase: 'done', collectedDevPaths: deviceNodes.length, discoveredMods: totalSeeds, discoveredStls: 0, loadedMods: loadedCount, loadedStls: 0, totalMods: totalSeeds, totalStls: 0, processedMods: processedCount });
  profile.successfulGlbInstanceCount = loadedCount;
  profile.successfulGlbDevCount = devOrder.filter((devPath) => {
    const entry = manifestEntries.get(devPath.toLowerCase());
    return (entry?.status === 'glb' || entry?.status === 'partial')
      && !failedDevPaths.has(devPath.toLowerCase());
  }).length;
  syncFailureProfile();
  syncTemplateMetrics();
  const finalTemplateMetrics = templatePool.metrics();
  const finalTelemetry = deepTelemetry.snapshot(0);
  profile.sharedPlacementCount = finalTelemetry.sharedPlacementCount;
  profile.exclusiveFallbackPlacementCount = finalTelemetry.exclusiveFallbackPlacementCount;
  profile.placementMatrixMs = finalTelemetry.placementMatrixMs;
  profile.bboxMs = finalTelemetry.bboxMs;
  profile.sceneCommitMs = finalTelemetry.sceneCommitMs;
  profile.placementYieldCount = finalTelemetry.placementYieldCount;
  profile.placementSliceCount = finalTelemetry.placementSliceCount;
  profile.maxPlacementSliceMs = finalTelemetry.maxPlacementSliceMs;
  profile.placementSliceP50Ms = finalTelemetry.placementSliceP50Ms;
  profile.placementSliceP95Ms = finalTelemetry.placementSliceP95Ms;
  profile.templateParseCount = finalTemplateMetrics.templateParseCount;
  profile.templateParseMs = finalTemplateMetrics.templateParseMs;
  profile.deepTelemetry = deepTelemetry.snapshot(performance.now() - fastPathStarted);
  return success(loadedCount);
}
