/** Per-DEV cache repair; successful templates remain owned by their session. */
import * as THREE from 'three';
import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { DevCheckpointHandler } from './substationBackgroundRuntime.js';
import type { GeometryCacheManifest, GeometryCacheManifestEntry } from '@desktop/database.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import { normalizeDevEntryPath, buildFileMapFromDiskCache } from './modGeometrySourceFiles.js';
import { isGeometryContextValid } from './modGeometryContracts.js';
import { validateCachedGlbBytes, hasRenderableGlbGeometry, disposeFastPathGroup } from './devGlbCacheFastPath.js';

export interface DevGlbCacheRecoveryResult {
  repairedDevPaths: string[];
  emptyDevPaths: string[];
  unsupportedDevPaths?: string[];
  unresolvedDevPaths: string[];
}

export interface DevGlbCacheRecoveryDependencies {
  serializeDevToGlb?: (devPath: string, files: Map<string, File>) => Promise<Uint8Array | null>;
  serializeDevToGlbDetailed?: (devPath: string, files: Map<string, File>) => Promise<import('./glbCacheService.js').DevGlbSerializationResult>;
  loadDevGlb?: (devPath: string, bytes: Uint8Array) => Promise<THREE.Group | null>;
  readGeometryCacheManifest?: (projectId: number) => Promise<GeometryCacheManifest>;
  writeGeometryCacheManifest?: (projectId: number, sourceSha256: string, entries: GeometryCacheManifestEntry[]) => Promise<string>;
  writeGlbFile?: (projectId: number, entryPath: string, bytes: Uint8Array, sourceSha256?: string | null) => Promise<string>;
  invalidateGlbCacheEntry?: (projectId: number, entryPath: string, sourceSha256?: string | null) => Promise<void>;
}

/**
 * Rebuild only DEV GLB entries which failed the warm fast path.
 *
 * The cache entry is removed before source compilation and is advertised as
 * `glb` only after both a fresh GLB parse/renderability check and an atomic
 * manifest write succeed.  The caller can then run the existing fast path
 * once more; that keeps placement/scene behaviour in one code path and avoids
 * introducing a second GLB renderer just for recovery.
 */
export async function recoverFailedDevGlbCaches(
  state: AppState,
  failedDevPaths: string[],
  sourceFiles: Map<string, File> | null,
  context: {
    token?: number;
    generation: number;
    projectId: number | null;
    sourceSha256: string | null;
    session: ProjectLoadSession;
    onDevCheckpoint?: DevCheckpointHandler;
  },
  dependencies: DevGlbCacheRecoveryDependencies = {},
): Promise<DevGlbCacheRecoveryResult> {
  const normalizedTargets = new Map<string, string>();
  for (const path of failedDevPaths) {
    const normalized = normalizeDevEntryPath(path);
    normalizedTargets.set(normalized.toLowerCase(), normalized);
  }
  const unresolved = (): DevGlbCacheRecoveryResult => ({
    repairedDevPaths: [],
    emptyDevPaths: [],
    unresolvedDevPaths: Array.from(normalizedTargets.values()),
  });
  if (
    normalizedTargets.size === 0
    || context.projectId == null
    || !context.sourceSha256
    || !isGeometryContextValid(
      state,
      context.token,
      context.generation,
      context.projectId,
      context.sourceSha256,
    )
  ) {
    return unresolved();
  }

  const isCurrent = () => isGeometryContextValid(
    state,
    context.token,
    context.generation,
    context.projectId,
    context.sourceSha256,
  ) && (typeof state.isCurrentSession === 'function'
    ? state.isCurrentSession(context.session)
    : true);
  const projectId = context.projectId;
  const sourceSha256 = context.sourceSha256;
  const readManifest = dependencies.readGeometryCacheManifest
    ?? (await import('@desktop/database.js')).readGeometryCacheManifest;
  const writeManifest = dependencies.writeGeometryCacheManifest
    ?? (await import('@desktop/database.js')).writeGeometryCacheManifest;
  const writeGlb = dependencies.writeGlbFile
    ?? (await import('@desktop/database.js')).writeGlbFile;
  const invalidateEntry = dependencies.invalidateGlbCacheEntry
    ?? (await import('@desktop/database.js')).invalidateGlbCacheEntry;
  const serialize = dependencies.serializeDevToGlb
    ?? (await import('./glbCacheService.js')).serializeDevToGlb;
  const serializeDetailed = dependencies.serializeDevToGlbDetailed
    ?? (dependencies.serializeDevToGlb
      ? undefined
      : (await import('./glbCacheService.js')).serializeDevToGlbDetailed);
  const loadGlb = dependencies.loadDevGlb
    ?? (await import('./glbCacheService.js')).loadDevGlb;

  let manifest: GeometryCacheManifest;
  try {
    manifest = await readManifest(projectId);
  } catch (error) {
    debugLog(DEBUG_IFC_LOAD, '[autoLoad] DEV GLB recovery manifest 不可读', error);
    return unresolved();
  }
  if (!isCurrent() || manifest.source_sha256 !== sourceSha256 || !Array.isArray(manifest.entries)) {
    return unresolved();
  }

  let files = sourceFiles;
  if (!files) {
    try {
      files = await buildFileMapFromDiskCache(projectId, Array.from(normalizedTargets.values()), state.substationEntryPaths);
    } catch (error) {
      debugLog(DEBUG_IFC_LOAD, '[autoLoad] DEV GLB recovery 源文件准备失败', error);
      return unresolved();
    }
  }
  if (!files || !isCurrent()) return unresolved();

  const invalidatedKeys = new Set<string>();
  const recoveredEntries = new Map<string, GeometryCacheManifestEntry>();
  const repairedDevPaths: string[] = [];
  const emptyDevPaths: string[] = [];
  const unsupportedDevPaths: string[] = [];
  const unresolvedDevPaths: string[] = [];

  for (const [key, devPath] of normalizedTargets) {
    if (!isCurrent()) return {
      repairedDevPaths,
      emptyDevPaths,
      unresolvedDevPaths: [
        ...unresolvedDevPaths,
        ...Array.from(normalizedTargets.entries())
          .filter(([targetKey]) => !repairedDevPaths.some((path) => path.toLowerCase() === targetKey))
          .map(([, path]) => path),
      ],
    };
    const unitStarted = performance.now();
    try {
      try {
        // Invalidate exactly this DEV.  Other DEV GLBs and their manifest
        // entries remain untouched even when this source rebuild fails.
        await invalidateEntry(projectId, devPath, sourceSha256);
        if (!isCurrent()) return {
          repairedDevPaths,
          emptyDevPaths,
          unresolvedDevPaths: Array.from(normalizedTargets.values()),
        };
        invalidatedKeys.add(key);
      } catch (error) {
        unresolvedDevPaths.push(devPath);
        debugLog(DEBUG_IFC_LOAD, `[autoLoad] DEV GLB recovery invalidate 失败: ${devPath}`, error);
        continue;
      }

      try {
        let bytes: Uint8Array | null;
        let serializationStatus: 'complete' | 'partial' | 'empty' | 'unsupported' = 'complete';
        if (serializeDetailed) {
          const serialized = await serializeDetailed(devPath, files);
          bytes = serialized.bytes;
          serializationStatus = serialized.status;
        } else {
          bytes = await serialize(devPath, files);
          serializationStatus = bytes ? 'complete' : 'empty';
        }
        if (!isCurrent()) return {
          repairedDevPaths,
          emptyDevPaths,
          unresolvedDevPaths: Array.from(normalizedTargets.values()),
        };
        if (bytes == null) {
          recoveredEntries.set(key, {
            entry_path: devPath,
            status: serializationStatus === 'unsupported' ? 'unsupported' : 'empty',
            size: 0,
          });
          if (serializationStatus === 'unsupported') unsupportedDevPaths.push(devPath);
          else emptyDevPaths.push(devPath);
          continue;
        }
        if (!validateCachedGlbBytes(bytes)) {
          unresolvedDevPaths.push(devPath);
          continue;
        }
        // Parse once before publishing the bytes.  A syntactically valid but
        // empty/undecodable GLB must never become a warm-path cache hit.
        const validationGroup = await loadGlb(devPath, bytes);
        if (!validationGroup || !hasRenderableGlbGeometry(validationGroup)) {
          if (validationGroup) disposeFastPathGroup(validationGroup);
          unresolvedDevPaths.push(devPath);
          continue;
        }
        disposeFastPathGroup(validationGroup);
        await writeGlb(projectId, devPath, bytes, sourceSha256);
        if (!isCurrent()) return {
          repairedDevPaths,
          emptyDevPaths,
          unresolvedDevPaths: Array.from(normalizedTargets.values()),
        };
        recoveredEntries.set(key, {
          entry_path: devPath,
          status: serializationStatus === 'partial' ? 'partial' : 'glb',
          size: bytes.byteLength,
        });
      } catch (error) {
        unresolvedDevPaths.push(devPath);
        debugLog(DEBUG_IFC_LOAD, `[autoLoad] DEV GLB recovery 编译失败: ${devPath}`, error);
      }
    } finally {
      if (isCurrent()) await context?.onDevCheckpoint?.({ phase: 'cache-repair', path: devPath, durationMs: performance.now() - unitStarted });
    }
  }

  if (!isCurrent() || invalidatedKeys.size === 0) {
    return { repairedDevPaths, emptyDevPaths, unresolvedDevPaths };
  }

  const entries = manifest.entries
    .filter((entry) => !invalidatedKeys.has(normalizeDevEntryPath(entry.entry_path).toLowerCase()))
    .concat(Array.from(recoveredEntries.values()));
  try {
    await writeManifest(projectId, sourceSha256, entries);
    if (!isCurrent()) return {
      repairedDevPaths: [],
      emptyDevPaths: [],
      unresolvedDevPaths: Array.from(normalizedTargets.values()),
    };
  } catch (error) {
    // Do not leave an unadvertised success around as a future cache source.
    for (const entry of recoveredEntries.values()) {
      if (entry.status !== 'glb' && entry.status !== 'partial') continue;
      try {
        await invalidateEntry(projectId, entry.entry_path, sourceSha256);
      } catch {
        // The manifest was not published; the next validation still rejects
        // the orphan unless a later explicit cleanup removes it.
      }
    }
    debugLog(DEBUG_IFC_LOAD, '[autoLoad] DEV GLB recovery manifest 原子提交失败', error);
    return {
      repairedDevPaths: [],
      emptyDevPaths: [],
      unresolvedDevPaths: Array.from(normalizedTargets.values()),
    };
  }

  for (const path of recoveredEntries.values()) {
    if (path.status === 'glb' || path.status === 'partial') repairedDevPaths.push(path.entry_path);
  }
  // A deterministic empty DEV is a valid cache result and must not be sent
  // to the raw fallback path on the next warm open.
  return {
    repairedDevPaths,
    emptyDevPaths,
    ...(unsupportedDevPaths.length > 0 ? { unsupportedDevPaths } : {}),
    unresolvedDevPaths: Array.from(new Set(unresolvedDevPaths)),
  };
}
