import type { SessionScope } from '../../../../shared/sessionScope.js';
import type {
  SubstationBackgroundCoordinator,
  SubstationBackgroundGate,
} from '../substationBackgroundRuntime.js';
import {
  buildAndCommitSubstationSpatialSemantic,
  commitCachedSubstationSpatialSemantic,
  type SubstationSpatialInput,
} from '../substationSpatialRuntime.js';
import { readSubstationSpatialSemanticCache } from '../substationSpatialSemanticCache.js';
import { createSpatialSemanticStarter } from './spatialSemanticStarter.js';

/** Engineering and background consumers share one restore or rebuild. */
export function createWarmSpatialSemanticStarter(
  input: SubstationSpatialInput,
  scope: SessionScope,
) {
  const { state, session, perfSession, showMessage } = input;
  return createSpatialSemanticStarter(async (onIndexReady) => {
    if (!scope.isCurrent()) return false;
    if (state.substationSpatialIndex) return true;
    const cached = await scope.read(() =>
      readSubstationSpatialSemanticCache(session.projectId, session.sourceSha256),
    );
    if (!scope.isCurrent()) return false;
    if (cached.hit)
      return commitCachedSubstationSpatialSemantic(
        state,
        cached,
        session,
        perfSession,
        showMessage,
        onIndexReady,
      );
    return buildAndCommitSubstationSpatialSemantic(input, '变电 IFC 来源语义（缓存重建）', {
      projectId: session.projectId,
      sourceSha256: session.sourceSha256,
      cacheMissReason: cached.reason,
      onIndexReady,
    });
  });
}

export function scheduleSubstationSpatialSemantic(
  coordinator: SubstationBackgroundCoordinator,
  input: SubstationSpatialInput,
  label: string,
  readinessGate: SubstationBackgroundGate = 'allIfcReady',
  sharedStarter?: () => Promise<boolean>,
): void {
  if (sharedStarter) {
    coordinator.enqueue({
      task: 'spatialSemanticCacheRestore',
      priority: 1,
      heavy: false,
      startAfter: 'interactive',
      run: async () => {
        await sharedStarter();
      },
    });
    return;
  }

  const { state, session, perfSession, showMessage } = input;
  const enqueueRebuild = (cacheMissReason: string): void => {
    coordinator.enqueue({
      task: 'spatialSemanticRebuild',
      priority: 1,
      heavy: true,
      startAfter: readinessGate,
      run: async () => {
        const ready = await buildAndCommitSubstationSpatialSemantic(input, label, {
          projectId: session.projectId,
          sourceSha256: session.sourceSha256,
          cacheMissReason,
        });
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
        if (!committed && state.isCurrentSession(session)) enqueueRebuild('cache-commit-failed');
        return;
      }
      enqueueRebuild(cache.reason);
    },
  });
}
