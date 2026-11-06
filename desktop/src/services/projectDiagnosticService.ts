import { backgroundErrorSnapshot } from '../utils/backgroundErrors.js';
import type {AppState, ProjectLoadSession} from '../app/state.js';
import {getDbPath, getLatestProjectCacheDiagnostic, getProjectDiagnostic} from '@desktop/database.js';
import {getDebugConfigSnapshot} from '../config/debug.js';
import {isWebIfcMultiThreadingAvailable} from '../config/features.js';
import {getBasemapStatusSnapshot} from './basemapStatusService.js';
import {perfCurrentSession, perfSnapshot} from '../utils/perfTimings.js';

const READ_TIMEOUT_MS = 5000;
async function boundedRead<T>(read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(read), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Error('诊断读取超过 5 秒，未取得结果')), READ_TIMEOUT_MS);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** A diagnostic observes existing state; it never triggers source parsing,
 * geometry compilation, cache invalidation or a full capability audit. */
async function collect(state: AppState, session: ProjectLoadSession, perfId: number) {
  const [path, database] = await Promise.allSettled([
    boundedRead(getDbPath), boundedRead(() => session.projectId != null
      ? getProjectDiagnostic(session.projectId) : getLatestProjectCacheDiagnostic()),
  ]);
  if (!state.isCurrentSession(session) || perfCurrentSession().id !== perfId) return null;
  const diagnosticReadErrors: Record<string, string> = {};
  if (path.status === 'rejected') diagnosticReadErrors.dbPath = String(path.reason).slice(0, 512);
  if (database.status === 'rejected') diagnosticReadErrors.project = String(database.reason).slice(0, 512);
  const capabilities = state.currentProjectType === 'substation' ? state.substationCapabilities : null;
  return {
    projectSession: session,
    substationCapabilities: capabilities,
    substationCapabilitiesStatus: state.currentProjectType !== 'substation' ? 'not-applicable'
      : capabilities ? 'available' : 'not-collected',
    dbPath: path.status === 'fulfilled' ? path.value : null,
    diagnostic: database.status === 'fulfilled' ? database.value : null,
    databaseDiagnosticScope: session.projectId != null ? 'active-project' : 'latest-project',
    diagnosticReadErrors,
    debug: getDebugConfigSnapshot(), basemap: getBasemapStatusSnapshot(), timings: perfSnapshot(), backgroundFailures: backgroundErrorSnapshot(),
    webIfcMt: {available: isWebIfcMultiThreadingAvailable()},
    deviceLod: state.deviceLodRuntime?.diagnostics ?? null,
    engineering: {
      status: state.engineeringStatus,
      error: state.engineeringError,
      cacheStatus: state.engineeringCacheStatus,
      cacheError: state.engineeringCacheError,
      complete: state.engineeringSources?.complete ?? false,
      incompleteReasons: state.engineeringSources?.incompleteReasons ?? [],
      sourceRecords: state.engineeringSnapshot?.memberships.length ?? 0,
      wholeCandidates: state.engineeringSnapshot?.entities.length ?? 0,
      pendingWholes: state.engineeringSnapshot?.pending.length ?? 0,
      sourceOnly: state.engineeringSnapshot?.memberships.filter(m => m.disposition === 'source_only').length ?? 0,
      rulesVersion: state.engineeringSnapshot?.rulesVersion ?? null,
      navigationVersion: state.engineeringNavigation?.version ?? null,
      navigationCacheHit: state.engineeringNavigationCacheHit,
      pipeline:state.engineeringPipelineMetrics,
      physicalSourceOccurrences: state.engineeringGeometryCatalog?.occurrences.length ?? 0,
      sourcePlacementWarnings: state.engineeringGeometryCatalog?.diagnostics.length ?? 0,
    },
  };
}
type Snapshot = Awaited<ReturnType<typeof collect>>;
const pending = new WeakMap<AppState, {session: ProjectLoadSession; perfId: number; task: Promise<Snapshot>}>();

/** Repeated exports share the bounded reads only within the same project and
 * performance session. A late previous project cannot clear a newer owner. */
export function collectProjectDiagnostic(state: AppState): Promise<Snapshot> {
  const session = state.captureProjectSession(), perfId = perfCurrentSession().id, existing = pending.get(state);
  if (existing && existing.perfId === perfId && state.isCurrentSession(existing.session)) return existing.task;
  const task = collect(state, session, perfId).finally(() => {
    if (pending.get(state)?.task === task) pending.delete(state);
  });
  pending.set(state, {session, perfId, task});
  return task;
}
