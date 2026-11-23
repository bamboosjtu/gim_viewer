import type * as THREE from 'three';
import type { AppState, ProjectLoadSession } from '../../app/state.js';
import type { ViewerContext } from '../../viewer/viewerEngine.js';
import type { GeometryTrack } from '../../viewer/modelPresentation.js';
import { reportBackgroundError } from '../../utils/backgroundErrors.js';
import {
  perfCurrentSession,
  perfGeometryTracksEnabled,
  perfMark,
  perfMarkProductMoment,
  type PerfSession,
} from '../../utils/perfTimings.js';
const loadObservation = () => import('../../viewer/modelPresentation.js');
type Observation = ReturnType<
  (typeof import('../../viewer/modelPresentation.js'))['observeModelPresentation']
>;
const jobs = new WeakMap<
  AppState,
  {
    session: ProjectLoadSession;
    promise: Promise<Observation>;
    callbacks: Set<() => void>;
    presented: boolean;
    measureTracks: boolean;
  }
>();
/** Source/semantic readiness remains independent from a submitted model frame. */
export async function observeFirstGeometry(
  state: AppState,
  ctx: ViewerContext,
  root: THREE.Object3D,
  session: ProjectLoadSession,
  onPresented?: () => void,
  perf: PerfSession = perfCurrentSession(),
  track?: GeometryTrack,
  diagnosticOnly = false,
): Promise<void> {
  const scope = state.sessionScope(session);
  const current = scope.isCurrent;
  if (!current() || (diagnosticOnly && !perfGeometryTracksEnabled())) return;
  let job = jobs.get(state);
  if (
    !job ||
    job.session.generation !== session.generation ||
    job.session.sourceSha256 !== session.sourceSha256
  ) {
    if (job)
      void job.promise.then(
        (observer) => observer.dispose(),
        () => {},
      );
    const owned = {
      session,
      promise: null as unknown as Promise<Observation>,
      callbacks: new Set<() => void>(),
      presented: false,
      measureTracks: perfGeometryTracksEnabled(),
    };
    jobs.set(state, owned);
    job = owned;
    owned.promise = loadObservation().then(({ observeModelPresentation }) =>
      observeModelPresentation(
        ctx,
        current,
        () => {
          if (!current()) return;
          owned.presented = true;
          perfMarkProductMoment(
            'firstVisibleGeometryReady',
            { scope: 'in-viewport-model-draw-submitted', gpuCompletionWaited: false },
            perf,
          );
          perfMarkProductMoment(
            'firstGeometryReady',
            { scope: 'in-viewport-model-draw-submitted', gpuCompletionWaited: false },
            perf,
          );
          perfMarkProductMoment(
            'interactive',
            { scope: 'in-viewport-model-draw-submitted', inputLatencyVerified: false },
            perf,
          );
          for (const callback of owned.callbacks) callback();
          owned.callbacks.clear();
        },
        owned.measureTracks
          ? (track) =>
              perfMarkProductMoment(
                track === 'dev' ? 'devFirstDrawSubmitted' : 'ifcFirstDrawSubmitted',
                {
                  scope: 'authoritative-in-viewport-model-draw-submitted',
                  gpuCompletionWaited: false,
                },
                perf,
              )
          : undefined,
      ),
    );
    scope.own(() => {
      if (jobs.get(state) === owned) jobs.delete(state);
      owned.callbacks.clear();
      void owned.promise.then((observer) => observer.dispose(), reportBackgroundError);
    });
  }
  if (job.presented) {
    if (!diagnosticOnly) onPresented?.();
    if (!job.measureTracks || !track) return;
  } else if (!diagnosticOnly && onPresented) job.callbacks.add(onPresented);
  const observer = await job.promise;
  if (current()) {
    const started = performance.now(),
      objects = observer.watch(root, track, !diagnosticOnly);
    if (objects)
      perfMark('首次绘制观察注册', { objects, registrationMs: performance.now() - started }, perf);
  } else observer.dispose();
}
