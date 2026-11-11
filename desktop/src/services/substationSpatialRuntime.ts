import {SUBSTATION_PARSER_DOMAIN_VERSION,type SubstationSpatialCacheHit,type EncodedSpatialCache} from './substationSpatialCodec.js';
/** Spatial semantic restore, rebuild, persistence and background scheduling. */
import type { IfcEntry, CbmNode } from '../gim/types.js';
import type { AppState, ProjectLoadSession } from '../app/state.js';
import { parseFileDevRelation } from '../gim/fileDevParser.js';
import { notifyEngineeringIfcEvidence, notifyEngineeringIfcFailure } from './engineeringService.js';
import { buildSubstationSpatialIndexInWorker } from './substationSpatialWorkerClient.js';
import { readSubstationSpatialSemanticCache, writeSubstationSpatialSemanticCache } from './substationSpatialSemanticCache.js';

import { SubstationBackgroundCoordinator, type SubstationBackgroundGate } from './substationBackgroundRuntime.js';
import { perfBegin, perfMarkProductMoment, type PerfSession } from '../utils/perfTimings.js';
import { createSubstationSpatialObserver, sampleSubstationMemory } from './substationRuntimeTelemetry.js';
import { renderSubstationCoreUi } from './substationPresentation.js';


export async function buildAndCommitSubstationSpatialSemantic(
  state: AppState,
  files: Map<string, File>,
  ifcEntries: IfcEntry[],
  cbmTree: CbmNode,
  fileDevRelations: Awaited<ReturnType<typeof parseFileDevRelation>>,
  session: ProjectLoadSession,
  perfSession: PerfSession,
  showMessage: (text: string) => void,
  label: string,
  options: {
    projectId?: number | null;
    beforeCacheWrite?: Promise<unknown>;
    sourceSha256?: string | null;
    cacheMissReason?: string;
    onIndexReady?:(available:boolean)=>void;
  } = {},
): Promise<boolean> {
  if (!state.isCurrentSession(session)) return false;
  const rebuildStarted = performance.now();
  const cacheMissReason = options.cacheMissReason ?? 'cache-not-tried';
  try {
    perfMarkProductMoment('spatialSemanticStart', {
      label,
      source: 'rebuild',
      cacheHit: false,
      cacheMissReason,
      models: ifcEntries.length,
    }, perfSession);
    const endSpatial = perfBegin(label, undefined, perfSession);
    let preparedCache:EncodedSpatialCache|undefined;
    const spatialIndex = await buildSubstationSpatialIndexInWorker(
      files,
      ifcEntries,
      cbmTree,
      fileDevRelations,
      createSubstationSpatialObserver(state, perfSession),
      () => state.isCurrentSession(session),
      options.projectId!=null&&options.sourceSha256?{metadata:{sourceSha256:options.sourceSha256,parserVersion:SUBSTATION_PARSER_DOMAIN_VERSION},onEncoded:cache=>{preparedCache=cache;}}:undefined,
    );
    if (!state.isCurrentSession(session)) return false;
    endSpatial(undefined, {
      models: spatialIndex.models.length,
      spatialNodes: spatialIndex.nodes.length,
      containedObjects: spatialIndex.models.reduce((sum, model) => sum + model.containedObjectCount, 0),
      uncontainedIfcObjects: spatialIndex.coverage.uncontainedIfcObjects,
      resourceRecords: spatialIndex.models.reduce((sum, model) => sum + model.resourceCount, 0),
      cbmLinks: spatialIndex.links.length,
    });
    state.substationSpatialIndex = spatialIndex;
    notifyEngineeringIfcEvidence(state);
    options.onIndexReady?.(true);
    const rebuildMs = Math.max(0, performance.now() - rebuildStarted);
    let writeMs = 0;
    let snapshotBytes = 0;
    if (options.projectId != null && options.sourceSha256 && state.isCurrentSession(session)) {
      try {
        await options.beforeCacheWrite;
        if(!state.isCurrentSession(session))return false;
        const cacheWrite = await writeSubstationSpatialSemanticCache(
          options.projectId,
          options.sourceSha256,
          spatialIndex,
          SUBSTATION_PARSER_DOMAIN_VERSION,
          preparedCache,
        );
        writeMs = cacheWrite.writeMs;
        snapshotBytes = cacheWrite.snapshotBytes;
      } catch (writeError) {
        // The complete in-memory projection remains usable.  A failed write
        // is deliberately not reported as a valid cache; the next open will
        // rebuild it again.
        console.warn('[GIM] 空间语义缓存写入失败，本次运行继续:', writeError);
      }
      preparedCache=undefined;
    }
    perfMarkProductMoment('spatialSemanticReady', {
      available: true,
      source: 'rebuild',
      cacheHit: false,
      cacheMissReason,
      readMs: 0,
      deserializeMs: 0,
      hydrateMs: 0,
      rebuildMs,
      writeMs,
      snapshotBytes,
      models: spatialIndex.models.length,
      spatialNodes: spatialIndex.nodes.length,
      objects: spatialIndex.objects.length,
      links: spatialIndex.links.length,
    }, perfSession);
    await sampleSubstationMemory(state, 'SpatialIndex finalize 后', perfSession, {
      models: spatialIndex.models.length,
      spatialNodes: spatialIndex.nodes.length,
      objects: spatialIndex.objects.length,
    });
    await renderSubstationCoreUi(state, showMessage, session, perfSession, '变电 navigation/UI（空间语义）');
    return true;
  } catch (err) {
    options.onIndexReady?.(false);
    if (!state.isCurrentSession(session)) return false;
    state.substationSpatialIndex = null;
    notifyEngineeringIfcFailure(state, String(err));
    perfMarkProductMoment('spatialSemanticReady', {
      available: false,
      source: 'rebuild',
      cacheHit: false,
      cacheMissReason,
      error: err instanceof Error ? err.message : String(err),
    }, perfSession);
    console.warn('[GIM] IFC 空间索引构建失败，保留功能系统视图:', err);
    return false;
  }
}

export async function commitCachedSubstationSpatialSemantic(
  state: AppState,
  result: SubstationSpatialCacheHit,
  session: ProjectLoadSession,
  perfSession: PerfSession,
  showMessage: (text: string) => void,
  onIndexReady?:(available:boolean)=>void,
): Promise<boolean> {
  if (!state.isCurrentSession(session)) return false;
  const endRestore = perfBegin('变电空间语义缓存恢复', undefined, perfSession);
  perfMarkProductMoment('spatialSemanticStart', {
    source: 'cache',
    cacheHit: true,
    readMs: result.readMs,
    deserializeMs: result.deserializeMs,
    hydrateMs: result.hydrateMs,
    snapshotBytes: result.snapshotBytes,
    models: result.models,
    nodes: result.nodes,
    objects: result.objects,
    links: result.links,
  }, perfSession);
  state.substationSpatialIndex = result.index;
  notifyEngineeringIfcEvidence(state);
  onIndexReady?.(true);
  if (!state.isCurrentSession(session)) return false;
  await renderSubstationCoreUi(state, showMessage, session, perfSession, '变电 navigation/UI（空间语义缓存）');
  if (!state.isCurrentSession(session)) return false;
  endRestore(undefined, {
    source: 'cache',
    models: result.models,
    nodes: result.nodes,
    objects: result.objects,
    links: result.links,
  });
  perfMarkProductMoment('spatialSemanticReady', {
    available: true,
    source: 'cache',
    cacheHit: true,
    readMs: result.readMs,
    deserializeMs: result.deserializeMs,
    hydrateMs: result.hydrateMs,
    rebuildMs: 0,
    writeMs: 0,
    snapshotBytes: result.snapshotBytes,
    models: result.models,
    spatialNodes: result.nodes,
    objects: result.objects,
    links: result.links,
  }, perfSession);
  await sampleSubstationMemory(state, 'SpatialIndex cache hydrate 后', perfSession, {
    source: 'cache',
    models: result.models,
    spatialNodes: result.nodes,
    objects: result.objects,
  });
  return true;
}

export function scheduleSubstationSpatialSemantic(
  coordinator: SubstationBackgroundCoordinator,
  state: AppState,
  files: Map<string, File>,
  ifcEntries: IfcEntry[],
  cbmTree: CbmNode,
  fileDevRelations: Awaited<ReturnType<typeof parseFileDevRelation>>,
  session: ProjectLoadSession,
  perfSession: PerfSession,
  showMessage: (text: string) => void,
  label: string,
  readinessGate: SubstationBackgroundGate = 'allIfcReady',
  sharedStarter?: () => Promise<boolean>,
): void {
  if (sharedStarter) {
    coordinator.enqueue({
      task: 'spatialSemanticCacheRestore', priority: 1, heavy: false, startAfter: 'interactive',
      run: async () => { await sharedStarter(); }
    });
    return;
  }
  let cacheMissReason = 'cache-not-tried';
  const enqueueRebuild = (): void => {
    coordinator.enqueue({
      task: 'spatialSemanticRebuild',
      priority: 1,
      heavy: true,
      startAfter: readinessGate,
      run: async () => {
        const ready = await buildAndCommitSubstationSpatialSemantic(
          state,
          files,
          ifcEntries,
          cbmTree,
          fileDevRelations,
          session,
          perfSession,
          showMessage,
          label,
          {
            projectId: session.projectId,
            sourceSha256: session.sourceSha256,
            cacheMissReason,
          },
        );
        if (!ready && state.isCurrentSession(session)) {
          throw new Error('空间语义 rebuild 未生成可用索引');
        }
      },
    });
  };
  coordinator.enqueue({
    task: 'spatialSemanticCacheRestore',
    priority: 1,
    heavy: false,
    startAfter: 'interactive',
    blocksHeavy: true,
    run: async () => {
      const cache = await readSubstationSpatialSemanticCache(
        session.projectId,
        session.sourceSha256,
        SUBSTATION_PARSER_DOMAIN_VERSION,
      );
      if (!state.isCurrentSession(session)) return;
      if (cache.hit) {
        const committed = await commitCachedSubstationSpatialSemantic(
          state,
          cache,
          session,
          perfSession,
          showMessage,
        );
        if (!committed && state.isCurrentSession(session)) {
          cacheMissReason = 'cache-commit-failed';
          enqueueRebuild();
        }
        return;
      }
      cacheMissReason = cache.reason;
      enqueueRebuild();
    },
  });
}
