import { DESKTOP_COMMANDS } from '@desktop/contracts.js';
import { hasErrorCode } from '@gim/contracts-native/errors.js';
import measuredWorkerAsset from './capabilityWorker.ts?worker&url';
import type { AppState } from '../app/state.js';
import {
  measurementSnapshot,
  drainMeasurementEvents,
  measurementPrivateSources,
  measurementRun,
  finishMeasurementOperation,
  measurementContext,
  openMeasurementContext,
} from './runtime.js';
import { perfProductMomentSnapshot, perfCurrentSession } from '../utils/perfTimings.js';
import { createMeasuredWorker, measurementWorkerUrl } from './hostWorker.js';
import { resetMeasurementRun, captureMeasurementResourceCheck } from './runtime.js';
import { installMeasurementStream } from './stream.js';
import { benchmarkEvidence, benchmarkProgress } from './modelEvidence.js';
import { scenarioTargets, runScenarioAction, projectResourceState } from './scenarios.js';

/** Only loaded by an explicit benchmark build; normal release does not expose this API. */
function createCapabilityProbe() {
  let capabilityWorker: Worker | undefined;
  let capabilityResult: unknown = null;
  return {
    start() {
      capabilityWorker?.terminate();
      capabilityResult = null;
      (globalThis as { __GIM_MEASUREMENT_CONFIG__?: unknown }).__GIM_MEASUREMENT_CONFIG__ = {
        mode: 'benchmark',
        runId: 'capability-probe',
      };
      resetMeasurementRun({});
      capabilityWorker = createMeasuredWorker(
        'measurement-probe',
        (identity) =>
          new Worker(measurementWorkerUrl(measuredWorkerAsset, identity), {
            type: 'module',
            ...(identity ? { name: identity } : {}),
          }),
      );
      capabilityWorker.onmessage = ({
        data,
      }: MessageEvent<{
        kind?: string;
        id?: number;
        ready?: boolean;
      }>) => {
        if (data.kind === 'probe-read') {
          const bytes = new Uint8Array([7, 11]).buffer;
          capabilityWorker!.postMessage({ kind: 'read-result', id: data.id, bytes }, [bytes]);
        } else if (data.ready) capabilityResult = data;
      };
      capabilityWorker.postMessage({ type: 'allocate' });
    },
    stop() {
      capabilityWorker?.terminate();
      capabilityWorker = undefined;
    },
    result: () => capabilityResult,
  };
}

export function installBenchmarkHost(state: AppState): void {
  let opening = false,
    openError = false,
    openErrorCode: string | null = null,
    openStarted: number | null = null,
    openSequence = 0;
  const capability = createCapabilityProbe();
  let stream: ReturnType<typeof installMeasurementStream> | undefined;
  let closedResources: ReturnType<typeof captureMeasurementResourceCheck> | undefined;
  const host = {
    async ifcConnectionProbe() {
      return (await import('./ifcConnectionVerification.js')).verifyNativeIfcConnections();
    },
    stream() {
      if (stream) return;
      const binding = (globalThis as { __gimMeasurementEmit?: (value: string) => void })
        .__gimMeasurementEmit;
      if (!binding) throw Error('measurement-binding-unavailable');
      stream = installMeasurementStream(binding);
    },
    ack(runId: string, batchId: number) {
      stream?.acknowledge(runId, batchId);
    },
    transport() {
      return stream?.status() ?? [];
    },
    capabilityProbe: () => capability.start(),
    endCapabilityProbe: () => capability.stop(),
    async open(
      sampleId: string,
      nonce: string,
      config: {
        runId: string;
        sourceSha256: string;
        buildId: string;
        mode: 'off' | 'summary' | 'benchmark' | 'diagnostic';
      },
    ) {
      const sequence = ++openSequence;
      opening = true;
      openError = false;
      openErrorCode = null;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const path = await invoke<string>(DESKTOP_COMMANDS.benchmark_authorize_sample, {
          sampleId,
          nonce,
        });
        if (sequence !== openSequence) return;
        (globalThis as { __GIM_MEASUREMENT_CONFIG__?: unknown }).__GIM_MEASUREMENT_CONFIG__ = {
          ...config,
          sampleId,
        };
        const { openGimForBenchmark } = await import('../app/composition/projectActions.js');
        if (sequence !== openSequence) return;
        openStarted = performance.now();
        await openGimForBenchmark(state, path);
      } catch (error) {
        if (sequence === openSequence) {
          openError = true;
          openErrorCode = hasErrorCode(error, 'INPUT_CORRUPT') ? 'INPUT_CORRUPT' : null;
        }
        throw error;
      } finally {
        if (sequence === openSequence) opening = false;
      }
    },
    snapshot() {
      const productMoments = perfProductMomentSnapshot();
      const lastCacheWriteAtMs = state.deviceLodRuntime?.diagnostics.lastCacheWriteAtMs;
      return {
        snapshotAtMs: performance.now(),
        opening,
        openError,
        openErrorCode,
        projectType: state.currentProjectType,
        session: perfCurrentSession(),
        measurement: measurementSnapshot(),
        capabilityResult: capability.result(),
        openElapsedMs: openStarted === null ? null : performance.now() - openStarted,
        devArtifactWriteElapsedMs:
          openStarted === null ||
          typeof lastCacheWriteAtMs !== 'number' ||
          !Number.isFinite(lastCacheWriteAtMs)
            ? null
            : Math.max(0, lastCacheWriteAtMs - openStarted),
        visibility: document.visibilityState,
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        progress: benchmarkProgress(state),
        moments: Object.fromEntries(
          Object.entries(productMoments).map(([key, value]) => [key, value?.atMs ?? null]),
        ),
        geometryTrackDetails: {
          ifcFirstOrderedWaitMs: productMoments.ifcFirstLoadAdmitted?.meta?.orderedWaitMs,
          ifcFirstConversionSlotWaitMs: productMoments.ifcFirstConversionStart?.meta?.slotWaitMs,
          ifcFirstConversionPath: productMoments.ifcFirstConversionStart?.meta?.source,
          ifcFirstUsableSource: productMoments.ifcFirstUsable?.meta?.source,
        },
        cachePersistence: ((moment) => ({
          observed: moment !== null,
          available: moment?.meta?.available !== false,
        }))(productMoments.cachePersistenceReady),
        engineering: {
          status: state.engineering.status,
          cacheStatus: state.engineering.cacheStatus,
          complete: state.engineering.sources?.complete ?? false,
        },
      };
    },
    finishOperation(settledAtMs: number | null) {
      const run = measurementRun();
      if (settledAtMs !== null)
        run.probe.trace(
          openMeasurementContext() ?? measurementContext(),
          { type: 'milestone', action: 'observed', name: 'settledMs' },
          settledAtMs,
        );
      finishMeasurementOperation();
    },
    async evidence() {
      const evidence = await benchmarkEvidence(state);
      return { ...evidence, evidenceAtMs: performance.now() };
    },
    templateDiagnostics() {
      return (
        (
          state.deviceLodRuntime as { templateDiagnostics?: () => unknown[] } | null
        )?.templateDiagnostics?.() ?? []
      );
    },
    privateSources() {
      return measurementPrivateSources(measurementRun().collector.identity.runId);
    },
    targets() {
      return scenarioTargets(state);
    },
    action(action: Parameters<typeof runScenarioAction>[1]) {
      return runScenarioAction(state, action);
    },
    resources() {
      return projectResourceState(state, closedResources);
    },
    drain: drainMeasurementEvents,
    async close() {
      openSequence++;
      opening = false;
      closedResources = captureMeasurementResourceCheck();
      const { closeProject } = await import('../app/composition/projectActions.js');
      await closeProject(state);
    },
    async memory() {
      const { getProcessMemory } = await import('@desktop/database.js');
      return getProcessMemory();
    },
  };
  (globalThis as { __gimBenchmark?: unknown }).__gimBenchmark = host;
}
