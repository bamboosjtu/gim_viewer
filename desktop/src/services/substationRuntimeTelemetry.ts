/** Session-guarded substation memory and Spatial parser observations. */
import type { AppState } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import { type SubstationSpatialIndexObserver } from '../gim/ifcSpatialParser.js';
import { perfRecordSubstationIfcRead, perfRecordSubstationIfcProfile, perfRecordSubstationFinalizeProfile, type PerfSession } from '../utils/perfTimings.js';
import { sampleSubstationRuntimeResources } from './substationResourceTelemetry.js';

export async function sampleSubstationMemory(
  state: AppState,
  label: string,
  session: PerfSession,
  meta?: Record<string, unknown>,
  ctx?: ViewerContext | null,
): Promise<void> {
  await sampleSubstationRuntimeResources(state, label, session, ctx, meta, {
    isCurrent: () => state.isCurrentSession({
      generation: session.generation ?? -1,
      projectId: session.projectId ?? null,
      sourceSha256: session.sourceSha256 ?? null,
      geometryToken: state.geometryLoadToken,
    }),
  });
}

export function createSubstationSpatialObserver(state: AppState, session: PerfSession): SubstationSpatialIndexObserver {
  // 只采一次阶段内存，避免大型工程的每个 IFC 都增加一个 RSS IPC。
  // 回调本身保持同步，采样异步执行且在 sampleSubstationMemory 内再次做
  // session 校验；这样不会阻塞纯解析层。
  let textSampled = false;
  let stepSampled = false;
  return {
    onModelRead: (profile) => {
      perfRecordSubstationIfcRead(profile, session);
      if (!textSampled && profile.bytes > 0) {
        textSampled = true;
        void sampleSubstationMemory(state, 'IFC text 读入后', session, {
          entryPath: profile.entryPath,
          bytes: profile.bytes,
          readMs: profile.readMs,
          decodeMs: profile.decodeMs,
        });
      }
    },
    onStepScan: (profile) => {
      if (!stepSampled) {
        stepSampled = true;
        void sampleSubstationMemory(state, 'STEP scan 后', session, {
          entryPath: profile.entryPath,
          bytes: profile.sourceBytes,
          rawEntityCount: profile.rawEntityCount,
          stepScanMs: profile.stepScanMs,
        });
      }
    },
    onModelParsed: (profile) => {
      perfRecordSubstationIfcProfile(profile, session);
    },
    onFinalize: (profile) => {
      perfRecordSubstationFinalizeProfile(profile, session);
    },
  };
}
