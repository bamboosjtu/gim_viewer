import type { AppState } from '../../../app/state.js';
import type { IfcEntry } from '../../../gim/types.js';
import { planSubstationIfcLoad } from './ifcLoadOrder.js';
import { setConnectionStatus } from '../../../services/presentation/shell_statusBar.js';
import type { SessionScope } from '../../../shared/sessionScope.js';
import { logger } from '../../../utils/logger.js';
import {
  perfMark,
  perfMarkProductMoment,
  perfRecordTaskPhase,
  type PerfSession,
} from '../../../utils/perfTimings.js';
import type { loadIfcEntry } from '../../../viewer/ifcEntryLoader.js';
import type { IfcConnectionPreviewRuntime } from '../../../viewer/ifcConnectionPreviewRuntime.js';
import type { ViewerContext } from '../../../viewer/viewerEngine.js';
import type { SubstationIfcLoadProgress } from './substationIfcLoadProgress.js';
import { loadSubstationIfcModel, type SubstationIfcUsableModel } from './substationIfcModelLoad.js';

interface SubstationIfcQueueInput {
  state: AppState;
  ctx: ViewerContext;
  scope: SessionScope;
  entries: IfcEntry[];
  connectionPreview: IfcConnectionPreviewRuntime;
  loadEntry: typeof loadIfcEntry;
  progress: SubstationIfcLoadProgress;
  perfSession: PerfSession;
  measureGeometryTracks: boolean;
  skipLargeIfc: boolean;
  ifcSourceSizes?: ReadonlyMap<string, number>;
  isInteractive: () => boolean;
  onUsable(entry: IfcEntry, model: SubstationIfcUsableModel): Promise<void>;
}

/** Preserve ordered admission and hand committed models back to presentation. */
export async function runSubstationIfcQueue(options: SubstationIfcQueueInput): Promise<number> {
  const {
    state,
    ctx,
    scope,
    entries,
    connectionPreview,
    loadEntry,
    progress,
    perfSession,
    measureGeometryTracks,
  } = options;
  const { session, isCurrent } = scope;
  const connectionFirstBatches = new Set<string>();
  const connectionCompletions = new Set<string>();
  const updateConnectionStatus = (): void => {
    const d = connectionPreview.diagnostics;
    if (d.objects === 0 && d.batches === 0 && d.partialModels === 0) {
      setConnectionStatus('');
      return;
    }
    const completed = d.readyModels > 0 ? ` · ${d.readyModels} 个来源三维就绪` : ' · 增量加载中';
    const partial = d.partialModels > 0 ? ` · 部分 ${d.partialModels}` : '';
    setConnectionStatus(`连接构件 ${d.objects} 个${completed}${partial}`);
  };
  const { queue, skippedLargeIfc, evidencedConnections, hasConnections, sizes } =
    planSubstationIfcLoad(
      entries,
      options.ifcSourceSizes,
      state.currentCbmTree,
      options.skipLargeIfc,
      state.currentFiles,
    );
  if (skippedLargeIfc.length) {
    logger.warn('[IFC] 已按设置跳过超大文件:', skippedLargeIfc);
    perfMark('IFC 跳过超大文件', { skipped: skippedLargeIfc }, perfSession);
  }
  state.ifcLoading.skippedLargeIfc = skippedLargeIfc.map((row) => row.path);
  if (hasConnections) {
    perfMark(
      'IFC 连接线优先',
      {
        order: queue.slice(0, 4).map((entry) => entry.path),
        evidencedModels: [...evidencedConnections],
        anchorPreserved: queue[0]?.modelId === entries[0]?.modelId,
      },
      perfSession,
    );
  }
  // Queue policy is unchanged: later IFC files wait behind earlier ones.
  const ifcQueueReadyAt = measureGeometryTracks ? performance.now() : 0;
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
    if (!isCurrent()) return skippedLargeIfc.length;
    const entry = queue[queueIndex];
    if (measureGeometryTracks) {
      const orderedWaitMs = performance.now() - ifcQueueReadyAt;
      perfMarkProductMoment('ifcFirstLoadAdmitted', { orderedWaitMs }, perfSession);
      perfRecordTaskPhase(
        {
          domain: 'ifc',
          kind: 'entry',
          taskId: 'ifc-entry:' + entry.path,
          sourcePath: entry.path,
        },
        'orderedFileWait',
        orderedWaitMs,
        perfSession,
      );
    }
    const usable = await loadSubstationIfcModel({
      state,
      entry,
      ctx,
      scope,
      perfSession,
      loadEntry,
      progress,
      index: queueIndex,
      queueSize: queue.length,
      sourceSize: sizes.get(entry.path.toLowerCase()) ?? 0,
      isInteractive: options.isInteractive,
      onRegionalBatch: (batch) => {
        const accepted = connectionPreview.acceptBatch({
          ...batch,
          modelId: entry.modelId,
          sourcePath: entry.path,
          sourceIdentity: session.sourceSha256 ?? `session:${session.generation}`,
          coordinateBasis: 'ifc-y-up-m',
        });
        if (
          accepted &&
          !connectionFirstBatches.has(entry.modelId) &&
          batch.chunks?.some((chunk) => chunk.vertices.length > 0)
        ) {
          connectionFirstBatches.add(entry.modelId);
          perfMark(
            'IFC connection preview first batch',
            {
              modelId: entry.modelId,
              entryPath: entry.path,
              sequence: batch.sequence,
              objects: batch.objects.length,
              bytes: batch.bytes,
              source: 'stream',
            },
            perfSession,
          );
        }
        updateConnectionStatus();
      },
      onRegionalComplete: (meta) => {
        connectionPreview.markComplete(entry.modelId, meta);
        if (!connectionCompletions.has(entry.modelId)) {
          connectionCompletions.add(entry.modelId);
          perfMark(
            'IFC connection preview settled',
            {
              modelId: entry.modelId,
              entryPath: entry.path,
              objectCount: meta.objectCount,
              sequence: meta.sequence,
              source: 'regional-index-complete',
            },
            perfSession,
          );
        }
        updateConnectionStatus();
      },
      onModelReady: () => {
        connectionPreview.markModelReady(
          entry.modelId,
          state.ifc.regionalRuntimes.get(entry.modelId)?.index.objects,
        );
        updateConnectionStatus();
      },
      onModelFailed: () => {
        connectionPreview.markFailed?.(entry.modelId);
        updateConnectionStatus();
      },
    });
    if (!isCurrent()) return skippedLargeIfc.length;
    if (usable) {
      try {
        await options.onUsable(entry, usable);
      } catch (error) {
        if (isCurrent()) logger.warn('[GIM] IFC presentation failed after model handoff:', error);
      }
    }
  }
  return skippedLargeIfc.length;
}
