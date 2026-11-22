import type { AppState, ProjectLoadSession } from '../app/state.js';
import { logger } from '../utils/logger.js';
import { hasErrorCode } from '@desktop/contracts.js';
import { readEngineeringSourceInput } from './engineeringSourceInput.js';
import {
  ENGINEERING_SOURCE_BATCH_BYTES,
  ENGINEERING_SOURCE_BATCH_FILES,
} from '../infrastructure/workers/engineeringWorkerProtocol.js';
import type { SubstationSpatialIndex } from '../gim/ifcSpatialParser.js';
import { engineeringSourceCacheMatchesFiles } from '../infrastructure/cache/engineeringCacheCodec.js';
import { EngineeringCacheStore } from '../infrastructure/cache/engineeringCacheStore.js';
import type { EngineeringBuildResult } from '../infrastructure/workers/engineeringWorkerProtocol.js';
import { EngineeringWorkerClient } from '../infrastructure/workers/engineeringWorkerClient.js';
import {
  SUBSTATION_PARSER_DOMAIN_VERSION,
  SUBSTATION_SPATIAL_SEMANTIC_VERSION,
} from '../infrastructure/cache/substationSpatialCodec.js';
import { isTauri } from '@desktop/runtime.js';
import { readCachedEntry } from '../infrastructure/native/projectFiles.js';
import { perfMark, perfMarkProductMoment } from '../utils/perfTimings.js';
import type { SourceGeometryOccurrenceCatalog } from '../gim/engineering/geometryOccurrences.js';
import { installCompositionProjection } from './compositionProjectionService.js';
import { createNavigationCacheProjection } from '../infrastructure/cache/engineeringNavigationCache.js';
import type { EvidenceQuery, EvidenceRange } from '../engineering/evidence.js';
import { checkEvidenceRange } from '../gim/engineering/evidenceProvider.js';

interface EngineeringJob {
  publishedBuildId: number;
  evidenceReady: Promise<void>;
  resolveEvidence(): void;
  session: ProjectLoadSession;
  isSessionCurrent(): boolean;
  client: EngineeringWorkerClient;
  ready: Promise<void>;
  lastSpatial: SubstationSpatialIndex | null;
  finished: boolean;
  enriching: boolean;
  cache?: EngineeringCacheStore;
  update: () => void;
  resolveGeometry(catalog: SourceGeometryOccurrenceCatalog | null): void;
  projectionReady: Promise<boolean>;
  resolveProjection(complete: boolean): void;
}
const jobs = new WeakMap<AppState, EngineeringJob>();
const current = (state: AppState, job: EngineeringJob) =>
  jobs.get(state) === job && job.isSessionCurrent();
const currentBuild = (state: AppState, job: EngineeringJob, result: EngineeringBuildResult) =>
  current(state, job) && (!result.buildId || result.buildId === job.publishedBuildId);

function evidenceJob(state: AppState): EngineeringJob {
  const job = jobs.get(state);
  if (!job || !current(state, job)) throw Error('Engineering evidence session unavailable');
  return job;
}
export async function getEngineeringEvidenceSnapshot(
  state: AppState,
  entryIds?: readonly string[],
) {
  const job = evidenceJob(state);
  await job.evidenceReady;
  if (!current(state, job)) throw Error('Stale evidence session');
  const snapshot = await job.client.getEvidenceSnapshot(entryIds);
  if (!current(state, job)) throw Error('Stale evidence session');
  return snapshot;
}
export async function queryEngineeringEvidence(state: AppState, query: EvidenceQuery) {
  const job = evidenceJob(state);
  await job.evidenceReady;
  if (!current(state, job)) throw Error('Stale evidence session');
  const page = await job.client.queryEvidence(query);
  if (!current(state, job)) throw Error('Stale evidence session');
  return page;
}
async function prepareEvidenceEntry(
  state: AppState,
  job: EngineeringJob,
  path: string,
): Promise<void> {
  if ((state.substationEntrySizes.get(path) ?? 0) > 16 * 1024 * 1024)
    throw Error('来源文件超过 16 MiB 整文件读取上限；当前尚未提供分块读取接口');
  const file = state.currentFiles?.get(path);
  let bytes: Uint8Array;
  if (file) {
    if (file.size > 16 * 1024 * 1024)
      throw Error('来源文件超过 16 MiB 整文件读取上限；当前尚未提供分块读取接口');
    bytes = new Uint8Array(await file.arrayBuffer());
  } else {
    if (state.currentProjectId == null) throw Error('Evidence entry unavailable');
    bytes = await readCachedEntry(state.currentProjectId, path);
  }
  if (bytes.byteLength > 16 * 1024 * 1024)
    throw Error('来源文件超过 16 MiB 整文件读取上限；当前尚未提供分块读取接口');
  if (!current(state, job)) throw Error('Stale evidence session');
  await job.client.addFiles([{ path, bytes }]);
}
export async function ensureEngineeringEvidence(state: AppState, range: EvidenceRange) {
  checkEvidenceRange(range);
  const job = evidenceJob(state);
  await job.ready;
  const inventory = await job.client.getEvidenceSnapshot(range.entryIds),
    entries = new Map(inventory.entries.map((e) => [e.id, e])),
    coverage = new Map(inventory.coverage.map((e) => [e.entryId, e]));
  for (const path of range.entryIds) {
    const entry = entries.get(path);
    if (!entry) throw Error('Unknown evidence entry');
    if (
      !coverage.get(path)?.restorable &&
      (entry.status === 'not_requested' ||
        entry.status === 'failed' ||
        coverage.get(path)?.rawAvailable === false)
    )
      await prepareEvidenceEntry(state, job, path);
  }
  const result = await job.client.ensureEvidence(range);
  if (!current(state, job)) throw Error('Stale evidence session');
  const requested = new Set(range.entryIds),
    affectsRecognition = state.engineering.sources?.graph.familyAssignments?.some((a) =>
      requested.has(a.path),
    );
  if (
    affectsRecognition &&
    range.entryIds.some(
      (id) => entries.get(id)?.status === 'failed' || entries.get(id)?.status === 'not_requested',
    ) &&
    result.revision !== inventory.revision
  ) {
    const rebuilt = await job.client.recognizeEvidence(job.cache?.identity);
    if (!current(state, job)) throw Error('Stale evidence session');
    publish(state, job, rebuilt);
    await finishBuild(state, job, rebuilt);
    return job.client.getEvidenceSnapshot(range.entryIds);
  }
  return result;
}
export const ENGINEERING_PARSER_CONTRACT = `${SUBSTATION_PARSER_DOMAIN_VERSION}|${SUBSTATION_SPATIAL_SEMANTIC_VERSION}`;

export interface EngineeringBuildOptions {
  onUpdate?: () => void;
  /** Dependency injection for lifecycle/integration tests; production uses a real Worker. */
  createWorker?: (
    isCurrent: () => boolean,
    signal: AbortSignal,
    onProgress: (stage: string, completed: number) => void,
  ) => EngineeringWorkerClient;
  /** Native early-open sources are not a published cache until extraction commits. */
  beforeCacheWrite?: Promise<unknown>;
  /** Starts shared IFC semantics on demand; has no geometry readiness gate. */
  ensureIfcSemantics?: () => Promise<unknown>;
}

async function saveResult(
  state: AppState,
  job: EngineeringJob,
  result: EngineeringBuildResult,
): Promise<void> {
  const { cache } = job;
  const { buildId, cachePlan } = result;
  const isCurrent = () => currentBuild(state, job, result);
  if (!isCurrent() || !cache || !cachePlan?.length || !buildId) return;
  state.engineering.cacheStatus = 'saving';
  job.update();
  try {
    await cache.waitForSourceCommit(isCurrent);
    // Request only after publication and the source commit barrier. Persist and
    // release each buffer before asking the Worker to encode the next domain.
    for (const domain of cachePlan) {
      if (!isCurrent()) return;
      if (domain === 'navigation' && !(await job.projectionReady)) {
        if (isCurrent()) {
          state.engineering.cacheStatus = 'partial';
          job.update();
        }
        return;
      }
      if (!isCurrent()) return;
      let projection: ReturnType<typeof createNavigationCacheProjection> | undefined;
      if (domain === 'navigation' && state.engineering.navigation) {
        try {
          projection = createNavigationCacheProjection(
            result.navigation,
            state.engineering.navigation,
          );
        } catch {
          // The Worker base may not contain the final composition. Never fall
          // back to persisting it as a complete view, or invalidate domains
          // already saved because an optional projection cannot be constructed.
          if (isCurrent()) {
            state.engineering.cacheStatus = 'partial';
            state.engineering.cacheError = 'navigation-projection-unavailable';
            job.update();
          }
          return;
        }
      }
      const saved = await cache.saveDomain(
        domain,
        () => job.client.encodeCache(buildId, domain, projection),
        isCurrent,
        (metrics) => {
          perfMark('工程缓存域编码', { domain, ...metrics });
          state.engineering.pipelineMetrics?.caches.push({ domain, ...metrics });
        },
      );
      if (!isCurrent()) return;
      if (saved.status !== 'saved') {
        state.engineering.cacheStatus = saved.status;
        state.engineering.cacheError = saved.error;
        job.update();
        return;
      }
    }
    if (isCurrent()) {
      state.engineering.cacheStatus = Object.keys(result.stageErrors ?? {}).length
        ? 'partial'
        : 'saved';
      state.engineering.cacheError = '';
      job.update();
    }
  } catch (error) {
    if (isCurrent()) {
      state.engineering.cacheStatus = 'error';
      state.engineering.cacheError = String(error);
      job.update();
    }
  }
}

async function finishBuild(
  state: AppState,
  job: EngineeringJob,
  result: EngineeringBuildResult,
): Promise<void> {
  if (!currentBuild(state, job, result)) return;
  job.finished = true;
  // Domain work is complete. Persistence has its own cache-settled state;
  // optional cache I/O must not extend the automatic geometry load metric.
  const saving = saveResult(state, job, result);
  state.engineering.buildPending = false;
  job.update();
  if (!state.engineering.sources?.models.length && state.engineering.treeStatus === 'loading')
    state.engineeringGeometryEvidenceChanged?.();
  try {
    await saving;
  } finally {
    // Retain metadata/checkpoint; an idle reconstructible Worker can terminate.
    await job.client.releaseModel?.(result.buildId);
    if (currentBuild(state, job, result)) job.update();
  }
}

function publish(state: AppState, job: EngineeringJob, result: EngineeringBuildResult): void {
  if (!current(state, job)) return;
  if (result.buildId && result.buildId <= job.publishedBuildId) return;
  if (result.buildId) job.publishedBuildId = result.buildId;
  state.engineering.sources = result.sources;
  state.engineering.snapshot = result.snapshot;
  state.engineering.navigation = result.navigation;
  state.engineering.navigationCacheHit = result.navigationCacheHit === true;
  const noIfc = result.sources.graph.ifcPaths.length === 0;
  const finalNavigation =
    !result.navigation.projectionErrors &&
    ((result.navigationCacheHit === true &&
      result.navigation.compositionComplete === true &&
      result.navigation.compositionCoverage === 'full') ||
      noIfc);
  state.engineering.treeStatus =
    finalNavigation || result.navigation.projectionErrors ? 'ready' : 'loading';
  if (result.navigation.projectionErrors) {
    result.navigation.compositionCoverage = 'partial';
    job.resolveProjection(false);
  }
  if (finalNavigation) {
    result.navigation.compositionComplete = true;
    result.navigation.compositionCoverage = 'full';
    job.resolveProjection(true);
    perfMarkProductMoment('engineeringTreeReady', {
      available: true,
      source: 'engineering-publish',
    });
  }
  state.engineering.pipelineMetrics = result.metrics ? { ...result.metrics, caches: [] } : null;
  state.engineeringRepresentationChanged?.();
  state.engineering.status =
    result.sources.complete && !Object.keys(result.stageErrors ?? {}).length ? 'ready' : 'partial';
  state.engineering.error = Object.entries(result.stageErrors ?? {})
    .map(([stage, error]) => `${stage}: ${error}`)
    .join('\n');
  state.engineering.failureCode = null;
  if (!result.sources.complete) state.engineering.cacheStatus = 'partial';
  if (result.cacheError) {
    state.engineering.cacheStatus = 'error';
    state.engineering.cacheError = result.cacheError;
  }
  if (result.cacheDisabled) {
    state.engineering.cacheStatus = 'disabled';
    state.engineering.cacheError = result.cacheDisabled;
  }
  perfMark('工程实体就绪', {
    complete: result.sources.complete,
    sources: result.snapshot.memberships.length,
    entities: result.snapshot.entities.length,
    pending: result.snapshot.pending.length,
    entityCacheHit: result.entityCacheHit === true,
    navigationCacheHit: result.navigationCacheHit === true,
  });
  job.update();
  state.engineeringGeometryEvidenceChanged?.();
  // Engineering semantics publish is independent of geometry compilation.
  // Source-template GLB assets are materialized by the DEV path; no entity GLB
  // is scheduled here.
}

async function enrich(state: AppState, job: EngineeringJob): Promise<void> {
  if (!current(state, job) || job.finished || job.enriching) return;
  job.enriching = true;
  try {
    // Notifications can carry a newer immutable spatial snapshot while the
    // Worker is assembling the previous one. Drain them through one owner;
    // closing an earlier job must never cancel a later assembly request.
    while (current(state, job) && !job.finished) {
      const spatial = state.substationSpatialIndex;
      if (!spatial || spatial === job.lastSpatial) return;
      job.lastSpatial = spatial;
      const result = await job.client.assemble(
        spatial.objects,
        spatial.models,
        job.cache?.identity,
        spatial.nodes,
      );
      if (!current(state, job)) return;
      if (state.substationSpatialIndex !== spatial) continue;
      publish(state, job, result);
      await finishBuild(state, job, result);
    }
  } finally {
    job.enriching = false;
  }
}

/** IFC semantic readiness is independent of rendering and LOD completion. */
export function notifyEngineeringIfcEvidence(state: AppState): void {
  const job = jobs.get(state);
  if (!job) return;
  void job.ready.then(() => enrich(state, job)).catch((error) => fail(state, job, error));
}
export function notifyEngineeringIfcFailure(state: AppState, reason: string): void {
  const job = jobs.get(state);
  if (!job || !current(state, job) || job.finished) return;
  job.ready
    .then(() => {
      if (!current(state, job) || job.finished) return;
      job.finished = true;
      job.client.close();
      state.engineering.buildPending = false;
      job.resolveProjection(false);
      state.engineering.treeStatus = state.engineering.navigation ? 'ready' : 'error';
      if (state.engineering.navigation)
        state.engineering.navigation = {
          ...state.engineering.navigation,
          compositionCoverage: 'partial',
        };
      state.engineering.error = reason;
      state.engineering.failureCode = 'ifc-semantic-failed';
      state.engineering.status = state.engineering.snapshot ? 'partial' : 'error';
      state.engineering.cacheStatus = 'partial';
      job.update();
    })
    .catch((error) => fail(state, job, error));
}

function fail(state: AppState, job: EngineeringJob, error: unknown): void {
  if (!current(state, job) || job.finished) return;
  job.client.close();
  job.resolveEvidence();
  job.resolveGeometry(null);
  logger.warn('[工程来源] 构建失败', error instanceof Error ? error.stack : String(error));
  job.finished = true;
  state.engineering.buildPending = false;
  job.resolveProjection(false);
  state.engineering.treeStatus = state.engineering.navigation ? 'ready' : 'error';
  if (state.engineering.navigation)
    state.engineering.navigation = {
      ...state.engineering.navigation,
      compositionCoverage: 'partial',
    };
  state.engineering.error = String(error);
  state.engineering.failureCode = hasErrorCode(error, 'WORKER_TIMEOUT')
    ? 'engineering-progress-stalled'
    : 'engineering-build-failed';
  state.engineering.status = state.engineering.snapshot ? 'partial' : 'error';
  job.update();
}

async function loadPhysicalCatalog(
  state: AppState,
  job: EngineeringJob,
  files: Map<string, File>,
  initialized: Promise<void>,
): Promise<void> {
  const { cache, client } = job;
  let physical: SourceGeometryOccurrenceCatalog | undefined;
  if (cache) {
    try {
      physical = await cache.readGeometry(files);
    } catch {
      /* Rebuild only the small physical directory; semantic caches are independent. */
    }
  }
  if (!current(state, job)) return;
  let physicalRebuilt = false;
  if (!physical) {
    await initialized;
    physicalRebuilt = true;
    if (!current(state, job)) return;
    try {
      physical = await client.extractGeometry(!!cache);
    } catch (error) {
      if (!current(state, job)) return;
      job.resolveGeometry(null);
      perfMark('来源物理目录失败', { reason: String(error) });
    }
  }
  if (!current(state, job)) return;
  if (physical) {
    state.sourceGeometry.catalog = physical;
    job.resolveGeometry(physical);
    job.update();
    perfMark('来源物理目录就绪', {
      occurrences: physical.occurrences.length,
      diagnostics: physical.diagnostics.length,
    });
    if (
      cache &&
      physicalRebuilt &&
      !physical.diagnostics.some((d) => d.reason === 'source-read-failed')
    ) {
      // Cache persistence is a background publication, never a render prerequisite.
      state.sourceGeometry.cachePending = true;
      void (async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (!current(state, job)) return;
        // Encode the Worker's retained catalog; no clone back to the Worker
        // and no model-sized stringify on the rendering thread.
        const saved = await cache.saveGeometry(() => client.encodeGeometryCache());
        if (!saved && current(state, job)) {
          state.sourceGeometry.cacheError = '来源物理目录缓存编码未返回内容';
          job.update();
        }
      })()
        .catch((error) => {
          if (current(state, job)) {
            state.sourceGeometry.cacheError = String(error);
            perfMark('来源物理目录缓存未写入', { reason: String(error) });
          }
        })
        .finally(() => {
          if (current(state, job)) {
            state.sourceGeometry.cachePending = false;
            job.update();
          }
        });
    }
  }
}

async function restoreEngineeringCache(
  state: AppState,
  job: EngineeringJob,
  files: Map<string, File>,
): Promise<boolean> {
  const { cache, client } = job;
  if (cache) {
    const reads = await cache.readDomains();
    if (!current(state, job)) return true;
    if (reads.sources) {
      try {
        const result = await client.restore(
          reads.sources,
          reads.entities,
          cache.identity,
          reads.navigation,
        );
        if (!current(state, job)) return true;
        if (
          !result.sources.complete ||
          !engineeringSourceCacheMatchesFiles(result.sources, files.keys())
        ) {
          // Never turn a decoded-but-IFC-less body into a partial "hit".
          // Fall through to a controlled rebuild from the actual inventory.
          state.engineering.cacheStatus = 'partial';
          state.engineering.cacheError = '缓存来源未覆盖当前 IFC 清单，已从来源重建';
        } else {
          // A source-only restore is not a full warm hit: entity/navigation
          // were rebuilt from the source body and still need re-encoding.
          const completeHit = result.entityCacheHit === true && result.navigationCacheHit === true;
          state.engineering.cacheStatus = completeHit ? 'hit' : 'partial';
          if (!completeHit)
            state.engineering.cacheError = '部分缓存命中：实体/导航缓存已从来源重建';
          publish(state, job, result);
          await finishBuild(state, job, result);
          return true;
        }
      } catch (error) {
        if (!current(state, job)) return true;
        state.engineering.cacheError = String(error);
      }
    }
    state.engineering.cacheStatus = 'miss';
    job.update();
  }
  return false;
}

/** Start from actual source files, never the old tree's object/grain projection.
 * Cold File blobs and warm lazy sources share one extraction protocol.
 */
export function beginEngineeringBuild(
  state: AppState,
  files: Map<string, File>,
  options: EngineeringBuildOptions = {},
): Promise<void> {
  const session = state.captureProjectSession();
  const scope = state.sessionScope(session);
  if (!scope.isCurrent()) return Promise.resolve();
  state.engineering.release();
  if (!scope.isCurrent()) return Promise.resolve();
  state.engineering.buildPending = true;
  state.sourceGeometry.cachePending = false;
  state.sourceGeometry.cacheError = '';
  state.engineering.progress = null;
  state.engineering.failureCode = null;
  let resolveGeometry!: EngineeringJob['resolveGeometry'];
  let resolveProjection!: EngineeringJob['resolveProjection'];
  let resolveEvidence!: EngineeringJob['resolveEvidence'];
  const evidenceReady = new Promise<void>((resolve) => {
    resolveEvidence = resolve;
  });
  const projectionReady = new Promise<boolean>((resolve) => {
    resolveProjection = resolve;
  });
  state.sourceGeometry.ready = new Promise((resolve) => {
    resolveGeometry = resolve;
  });
  state.sourceGeometry.catalog = null;
  const settleBuild = () => {
    resolveGeometry(null);
    resolveProjection(false);
    resolveEvidence();
  };
  let client: EngineeringWorkerClient;
  const ownsJob = () => {
    const job = jobs.get(state);
    return job !== undefined && job.client === client && scope.isCurrent();
  };
  try {
    client = (options.createWorker ?? EngineeringWorkerClient.create)(
      ownsJob,
      scope.signal,
      (stage, completed) => {
        if (ownsJob()) state.engineering.progress = { stage, completed };
      },
    );
  } catch (error) {
    settleBuild();
    if (!scope.isCurrent()) return Promise.resolve();
    logger.warn('[工程来源] Worker 启动失败', error);
    state.engineering.buildPending = false;
    state.engineering.sources = null;
    state.engineering.snapshot = null;
    state.engineering.navigation = null;
    state.engineering.navigationCacheHit = false;
    state.engineering.treeStatus = 'error';
    state.engineering.status = 'error';
    state.engineering.error = '当前环境无法启动工程实体构建 Worker';
    state.notifyEngineeringChanged();
    options.onUpdate?.();
    return Promise.resolve();
  }
  if (!scope.isCurrent()) {
    settleBuild();
    client.close();
    return Promise.resolve();
  }
  const update = () => {
    if (!ownsJob()) return;
    state.notifyEngineeringChanged();
    if (ownsJob()) options.onUpdate?.();
  };
  const { projectId, sourceSha256 } = session;
  const cache =
    isTauri() && projectId != null && sourceSha256 && /^[a-f\d]{64}$/i.test(sourceSha256)
      ? new EngineeringCacheStore(
          projectId,
          { sourceSha256, parserVersion: ENGINEERING_PARSER_CONTRACT, entries: [...files.keys()] },
          ownsJob,
          options.beforeCacheWrite,
        )
      : undefined;
  const job: EngineeringJob = {
    session,
    isSessionCurrent: scope.isCurrent,
    client,
    resolveGeometry,
    projectionReady,
    resolveProjection,
    evidenceReady,
    resolveEvidence,
    publishedBuildId: 0,
    ready: Promise.resolve(),
    lastSpatial: null,
    finished: false,
    enriching: false,
    update,
    cache,
  };
  jobs.set(state, job);
  const disposeProjection = installCompositionProjection(state, (complete) =>
    job.resolveProjection(complete),
  );
  const cleanup = () => release();
  const release = scope.own(() => {
    if (state.engineering.cleanup === cleanup) state.engineering.cleanup = null;
    if (jobs.get(state) === job) {
      state.engineering.buildPending = false;
      state.sourceGeometry.cachePending = false;
      jobs.delete(state);
    }
    cache?.close();
    settleBuild();
    try {
      client.close();
    } finally {
      disposeProjection();
    }
  });
  state.engineering.cleanup = cleanup;
  state.engineering.sources = null;
  state.engineering.snapshot = null;
  state.engineering.navigation = null;
  state.engineering.navigationCacheHit = false;
  state.engineering.status = 'loading';
  state.engineering.error = '';
  state.engineering.cacheStatus = 'none';
  state.engineering.cacheError = '';
  state.engineering.treeStatus = 'loading';
  state.engineering.pipelineMetrics = null;
  update();
  if (!ownsJob()) return job.ready;
  const run = async () => {
    const initialized = client
      .init(session.sourceSha256 || `session:${session.generation}`, [...files.keys()])
      .then(() => job.resolveEvidence());
    void initialized.catch(() => {});
    const preparedPaths = new Set<string>();
    const readInputs = async (paths: readonly string[]) => {
      const wanted = paths.filter((path) => !preparedPaths.has(path));
      const input = await readEngineeringSourceInput(files, wanted, session.projectId, () =>
        current(state, job),
      );
      for (const path of wanted) preparedPaths.add(path);
      return input;
    };
    client.setSourceReader(readInputs);
    const prepareEntries = async (entries: Array<[string, File]>) => {
      for (let offset = 0; offset < entries.length;) {
        const paths: string[] = [];
        let bytes = 0;
        while (offset < entries.length && paths.length < ENGINEERING_SOURCE_BATCH_FILES) {
          const [path, file] = entries[offset];
          if (paths.length && bytes + file.size > ENGINEERING_SOURCE_BATCH_BYTES) break;
          offset++;
          paths.push(path);
          bytes += file.size;
        }
        const input = await readInputs(paths);
        for (const batch of input.batches) {
          if (!current(state, job)) return;
          await client.addPackedFiles(batch);
        }
        if (input.files.length || input.errors.length) {
          if (!current(state, job)) return;
          await client.addFiles(input.files, input.errors);
        }
      }
    };
    await loadPhysicalCatalog(state, job, files, initialized);
    if (!current(state, job)) return;
    // Allow the independently resolved geometry consumer to dispatch work first.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await initialized;
    if (await restoreEngineeringCache(state, job, files)) return;
    if (!current(state, job)) return;
    const graph = await client.extract();
    if (!current(state, job)) return;
    // Raw CBM/DEV demand is finished. Do not retain the initial source map
    // through an otherwise idle checkpoint client for the entire session.
    client.setSourceReader();
    const familyPaths = new Set(
      graph.familyPaths ?? [...files.keys()].filter((path) => /\.fam$/i.test(path)),
    );
    await prepareEntries([...files].filter(([path]) => familyPaths.has(path)));
    if (!current(state, job)) return;
    // The geometry catalog is already usable. When a source-semantic starter
    // exists, join it before encoding a full DEV-only model that would be
    // immediately superseded by the same graph plus IFC records. This does
    // not wait for Viewer/LOD readiness and keeps the original failure path.
    const ifcPreparation =
      graph.ifcPaths.length && !state.substationSpatialIndex && options.ensureIfcSemantics
        ? Promise.resolve().then(options.ensureIfcSemantics)
        : undefined;
    if (ifcPreparation) {
      try {
        await ifcPreparation;
      } catch {
        /* Publish available DEV evidence below; the terminal handler retains the failure. */
      }
      if (!current(state, job)) return;
    }
    const spatial = state.substationSpatialIndex;
    job.lastSpatial = spatial;
    const result = await client.assemble(
      spatial?.objects ?? [],
      spatial?.models ?? [],
      cache?.identity,
      spatial?.nodes ?? [],
    );
    if (!current(state, job)) return;
    if (spatial === state.substationSpatialIndex) publish(state, job, result);
    if ((spatial && spatial === state.substationSpatialIndex) || graph.ifcPaths.length === 0) {
      await finishBuild(state, job, result);
    } else {
      // Also catch a spatial publication which arrived during the initial
      // assembly, before a notification could register against job.ready.
      void job.ready.then(() => enrich(state, job)).catch((error) => fail(state, job, error));
      if (options.ensureIfcSemantics)
        void (ifcPreparation ?? Promise.resolve().then(options.ensureIfcSemantics))
          .then((ready) => {
            if (!current(state, job)) return;
            if (ready === false) notifyEngineeringIfcFailure(state, 'IFC 来源语义未能完成');
            // A warm cache hit or a deferred IFC semantic build can publish the
            // spatial index without going through the cold commit callback. Ask the
            // engineering job to enrich IFC records explicitly in both cases.
            else notifyEngineeringIfcEvidence(state);
          })
          .catch((error) => {
            if (current(state, job)) notifyEngineeringIfcFailure(state, String(error));
          });
    }
  };
  job.ready = run().catch((error) => fail(state, job, error));
  return job.ready;
}
