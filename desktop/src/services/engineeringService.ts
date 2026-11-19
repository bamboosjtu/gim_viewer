import { sourceGeometryCacheEntry, decodeSourceGeometryCache } from './sourceGeometryCache.js';
import type { AppState, ProjectLoadSession } from '../app/state.js';
import { logger } from '../utils/logger.js';
import { hasErrorCode } from '@desktop/contracts.js';
import { readEngineeringSourceInput } from './engineeringSourceInput.js';
import {
  ENGINEERING_SOURCE_BATCH_BYTES,
  ENGINEERING_SOURCE_BATCH_FILES,
} from './engineeringWorkerProtocol.js';
import type { SubstationSpatialIndex } from '../gim/ifcSpatialParser.js';
import {
  engineeringCacheEntry,
  engineeringSourceCacheMatchesFiles,
  type EngineeringCacheIdentity,
} from './engineeringCacheCodec.js';
import type { EngineeringBuildResult } from './engineeringWorkerProtocol.js';
import { EngineeringWorkerClient } from './engineeringWorkerClient.js';
import {
  SUBSTATION_PARSER_DOMAIN_VERSION,
  SUBSTATION_SPATIAL_SEMANTIC_VERSION,
} from './substationSpatialCodec.js';
import { isTauri } from '@desktop/runtime.js';
import { readCachedEntry, writeCacheFile } from '@desktop/database.js';
import { perfMark, perfMarkProductMoment } from '../utils/perfTimings.js';
import type { SourceGeometryOccurrenceCatalog } from '../gim/engineering/geometryOccurrences.js';
import { installCompositionProjection } from './compositionProjectionService.js';
import { createNavigationCacheProjection } from './engineeringNavigationCache.js';
import type { EvidenceQuery, EvidenceRange } from '../engineering/evidence.js';
import { checkEvidenceRange } from '../gim/engineering/evidenceProvider.js';

interface EngineeringJob {
  publishedBuildId: number;
  evidenceReady: Promise<void>;
  resolveEvidence(): void;
  session: ProjectLoadSession;
  controller: AbortController;
  client: EngineeringWorkerClient;
  ready: Promise<void>;
  lastSpatial: SubstationSpatialIndex | null;
  finished: boolean;
  enriching: boolean;
  identity?: EngineeringCacheIdentity;
  update: () => void;
  beforeCacheWrite?: Promise<unknown>;
  resolveGeometry(catalog: SourceGeometryOccurrenceCatalog | null): void;
  projectionReady: Promise<boolean>;
  resolveProjection(complete: boolean): void;
}
const jobs = new WeakMap<AppState, EngineeringJob>();
const current = (state: AppState, job: EngineeringJob) =>
  jobs.get(state) === job && !job.controller.signal.aborted && state.isCurrentSession(job.session);
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
    const rebuilt = await job.client.recognizeEvidence(job.identity);
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
  if (
    !currentBuild(state, job, result) ||
    !job.identity ||
    job.session.projectId == null ||
    !result.cachePlan?.length ||
    !result.buildId
  )
    return;
  state.engineering.cacheStatus = 'saving';
  job.update();
  try {
    await job.beforeCacheWrite;
    if (!currentBuild(state, job, result)) return;
    // Request only after publication and the source commit barrier. Persist and
    // release each buffer before asking the Worker to encode the next domain.
    for (const domain of result.cachePlan) {
      if (!currentBuild(state, job, result)) return;
      if (domain === 'navigation' && !(await job.projectionReady)) {
        if (currentBuild(state, job, result)) {
          state.engineering.cacheStatus = 'partial';
          job.update();
        }
        return;
      }
      if (!currentBuild(state, job, result)) return;
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
          if (currentBuild(state, job, result)) {
            state.engineering.cacheStatus = 'partial';
            state.engineering.cacheError = 'navigation-projection-unavailable';
            job.update();
          }
          return;
        }
      }
      const encoded = await job.client.encodeCache(result.buildId, domain, projection);
      if (!currentBuild(state, job, result)) return;
      perfMark('工程缓存域编码', { domain, ...encoded.metrics });
      state.engineering.pipelineMetrics?.caches.push({ domain, ...encoded.metrics });
      if (encoded.error || !encoded.bytes) {
        state.engineering.cacheStatus = encoded.disabled ? 'disabled' : 'error';
        state.engineering.cacheError =
          encoded.disabled ?? encoded.error ?? '工程缓存编码未返回内容';
        job.update();
        return;
      }
      await writeCacheFile(
        job.session.projectId,
        engineeringCacheEntry(job.identity, domain),
        encoded.bytes,
        job.identity.sourceSha256,
      );
      encoded.bytes = undefined;
    }
    if (currentBuild(state, job, result)) {
      state.engineering.cacheStatus = Object.keys(result.stageErrors ?? {}).length
        ? 'partial'
        : 'saved';
      state.engineering.cacheError = '';
      job.update();
    }
  } catch (error) {
    if (currentBuild(state, job, result)) {
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
        job.identity,
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

/** Start from actual source files, never the old tree's object/grain projection.
 * Cold File blobs and warm lazy sources share one extraction protocol.
 */
export function beginEngineeringBuild(
  state: AppState,
  files: Map<string, File>,
  options: EngineeringBuildOptions = {},
): Promise<void> {
  state.engineering.cleanup?.();
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
  const session = state.captureProjectSession(),
    controller = new AbortController();
  if (typeof Worker === 'undefined' && !options.createWorker) {
    state.engineering.buildPending = false;
    resolveGeometry(null);
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
  const update = () => {
    if (state.isCurrentSession(session) && !controller.signal.aborted) {
      state.notifyEngineeringChanged();
      options.onUpdate?.();
    }
  };
  const client = (options.createWorker ?? EngineeringWorkerClient.create)(
    () => !!job && current(state, job),
    controller.signal,
    (stage, completed) => {
      if (job && current(state, job)) state.engineering.progress = { stage, completed };
    },
  );
  const persistent =
    isTauri() && session.projectId != null && /^[a-f\d]{64}$/i.test(session.sourceSha256 ?? '');
  const job: EngineeringJob = {
    session,
    controller,
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
    beforeCacheWrite: options.beforeCacheWrite,
    identity: persistent
      ? {
          sourceSha256: session.sourceSha256!,
          parserVersion: ENGINEERING_PARSER_CONTRACT,
          entries: [...files.keys()],
        }
      : undefined,
  };
  jobs.set(state, job);
  const disposeProjection = installCompositionProjection(state, (complete) =>
    job.resolveProjection(complete),
  );
  state.engineering.cleanup = () => {
    disposeProjection();
    resolveGeometry(null);
    resolveProjection(false);
    resolveEvidence();
    controller.abort();
    client.close();
    if (jobs.get(state) === job) {
      state.engineering.buildPending = false;
      jobs.delete(state);
    }
  };
  state.engineering.sources = null;
  state.engineering.snapshot = null;
  state.engineering.navigation = null;
  state.engineering.navigationCacheHit = false;
  state.engineering.status = 'loading';
  state.engineering.error = '';
  state.engineering.cacheStatus = 'none';
  state.engineering.cacheError = '';
  update();
  state.engineering.treeStatus = 'loading';
  state.engineering.pipelineMetrics = null;
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
    let physical: SourceGeometryOccurrenceCatalog | undefined;
    if (job.identity) {
      try {
        physical = await decodeSourceGeometryCache(
          await readCachedEntry(
            session.projectId!,
            sourceGeometryCacheEntry(job.identity.sourceSha256),
          ),
          job.identity.sourceSha256,
          files,
        );
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
        physical = await client.extractGeometry(!!job.identity);
      } catch (error) {
        if (!current(state, job)) return;
        resolveGeometry(null);
        perfMark('来源物理目录失败', { reason: String(error) });
      }
    }
    if (!current(state, job)) return;
    if (physical) {
      state.sourceGeometry.catalog = physical;
      resolveGeometry(physical);
      update();
      perfMark('来源物理目录就绪', {
        occurrences: physical.occurrences.length,
        diagnostics: physical.diagnostics.length,
      });
      if (
        job.identity &&
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
          const bytes = await client.encodeGeometryCache();
          if (!bytes) {
            if (current(state, job)) {
              state.sourceGeometry.cacheError = '来源物理目录缓存编码未返回内容';
              job.update();
            }
            return;
          }
          await job.beforeCacheWrite;
          if (!current(state, job)) return;
          if (current(state, job))
            await writeCacheFile(
              session.projectId!,
              sourceGeometryCacheEntry(job.identity!.sourceSha256),
              bytes,
              job.identity!.sourceSha256,
            );
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
              update();
            }
          });
      }
    }
    // Allow the independently resolved geometry consumer to dispatch work first.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await initialized;
    if (job.identity) {
      const reads = await Promise.allSettled([
        readCachedEntry(session.projectId!, engineeringCacheEntry(job.identity, 'sources')),
        readCachedEntry(session.projectId!, engineeringCacheEntry(job.identity, 'entities')),
        readCachedEntry(session.projectId!, engineeringCacheEntry(job.identity, 'navigation')),
      ]);
      if (!current(state, job)) return;
      if (reads[0].status === 'fulfilled') {
        try {
          const result = await client.restore(
            reads[0].value,
            reads[1].status === 'fulfilled' ? reads[1].value : undefined,
            job.identity,
            reads[2].status === 'fulfilled' ? reads[2].value : undefined,
          );
          if (!current(state, job)) return;
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
            const completeHit =
              result.entityCacheHit === true && result.navigationCacheHit === true;
            state.engineering.cacheStatus = completeHit ? 'hit' : 'partial';
            if (!completeHit)
              state.engineering.cacheError = '部分缓存命中：实体/导航缓存已从来源重建';
            publish(state, job, result);
            await finishBuild(state, job, result);
            return;
          }
        } catch (error) {
          if (!current(state, job)) return;
          state.engineering.cacheError = String(error);
        }
      }
      state.engineering.cacheStatus = 'miss';
      update();
    }
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
      job.identity,
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
