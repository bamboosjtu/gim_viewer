/** Stable diagnostic shape; storage and scene owners update the same instance. */
import type { BoxViewIndex } from '../viewer/boxViewIndex.js';
import type { DevInstanceBatches } from '../viewer/devInstanceBatches.js';
import type { DevGeometryPreprocessor } from './devGeometryWorkerClient.js';
import type { CacheDecision, MemoryPressure } from './devLodTypes.js';
export function createDevLodDiagnostics() {
    return ({
        catalogReady: false, currentViewReady: false, currentViewSettled: false, baseRepresentationsSettled: false, baseRepresentationsReady: false, allStationReady: false, catalogHits: 0,
        templateHits: 0, compiled: [0, 0, 0], /** Per-LOD cache/compile facts; index is LOD. */ lodHits: [0, 0, 0], lodCompiled: [0, 0, 0],
        lodReadErrors: [0, 0, 0], lodInvalid: [0, 0, 0], lodWriteFailed: [0, 0, 0], lodPersisted: [0, 0, 0],
        occurrences: 0, uniqueDevSources: 0, sceneCommitCount: 0, sceneCommitMaxMs: 0, shown: 0, pending: 0, unknownBounds: 0,
        absoluteConeCount: 0, templateResidentBytes: 0, directoryCompleted: 0, readyOccurrences: 0, failedOccurrences: 0,
        emptyOccurrences: 0, unsupportedOccurrences: 0, partialOccurrences: 0, templateParses: 0, templateEvictions: 0, workerCount: 0, activeDevices: [] as string[],
        inputBudgetBytes: 0, inputBudgetPeakBytes: 0,
        cacheWriteReservedBytes: 0, cacheWritePeakBytes: 0, cacheWriteWaitingBytes: 0,
        cacheWritePendingCount: 0, cacheWritesSettled: true, cacheWritesReady: true, cacheWriteCancelled: 0,
        cacheReadBatches: 0, cacheReadEntries: 0, cacheReadDeferred: 0, viewPendingOccurrences: 0,
        cacheHits: 0, cacheMisses: 0, cacheReadErrorCount: 0, cacheInvalidCount: 0,
        lodMisses: [0, 0, 0],
        artifactWriteAttempts: 0, artifactWriteFailures: 0, catalogWriteFailures: 0,
        workerReads: 0, workerRpcReads: 0, workerSourceHits: 0, workerDocumentHits: 0, workerReadRpcMs: 0, workerParseMs: 0, workerQueueWaitMs: 0,
        workerSourceAffinityHits: 0, workerSourceAffinityDeferrals: 0,
        cacheDecisions: [] as CacheDecision[], readinessBlockers: [] as string[], viewPendingSamples: [] as string[],
        resultQueuedBytes: 0, resultPeakBytes: 0, resultQueueCount: 0,
        workerScheduling: null as ReturnType<DevGeometryPreprocessor['schedulingSnapshot']> | null,
        workerStages: {} as Record<string, {
            count: number;
            totalMs: number;
            maxMs: number;
        }>,
        workerTimedOutTasks: 0, workerStallSnapshots: 0,
        memoryPressure: 'unknown' as MemoryPressure,
        externalMemoryPressure: 'unknown' as MemoryPressure,
        jsHeapUsedBytes: null as number | null, jsHeapLimitBytes: null as number | null,
        autoLodSuppressed: false, memoryTrimCount: 0,
        viewIndex: null as BoxViewIndex['diagnostics'] | null,
        backgroundPaused: false,
        instancing: null as null | ({
            enabled: boolean;
        } & DevInstanceBatches['statistics']),
        browseState: 'loading' as 'loading' | 'browseable' | 'base-settled' | 'partial',
        fineFailures: [] as string[],
        anchorReady: false, sourcePlacementWarnings: 0, errors: [] as string[], fingerprints: [] as Record<string, unknown>[]
    });
}
export type DevLodDiagnostics = ReturnType<typeof createDevLodDiagnostics>;
