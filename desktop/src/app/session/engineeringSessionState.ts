/** Published engineering results and their worker/listener ownership for one project lifecycle. */
export class EngineeringSessionState {
  sources: import('../../gim/engineering/buildSources.js').EngineeringSources | null = null;
  snapshot: import('../../engineering/types.js').EngineeringSnapshot | null = null;
  navigation: import('../../gim/engineering/navigation.js').EngineeringNavigationData | null = null;
  navigationCacheHit = false;
  treeStatus: 'none' | 'loading' | 'ready' | 'error' = 'none';
  ifcGeometryFinished = false;
  status: 'none' | 'loading' | 'partial' | 'ready' | 'error' = 'none';
  buildPending = false;
  progress: { stage: string; completed: number } | null = null;
  failureCode: string | null = null;
  error = '';
  cacheStatus: 'none' | 'hit' | 'miss' | 'saving' | 'saved' | 'partial' | 'disabled' | 'error' =
    'none';
  pipelineMetrics:
    | (NonNullable<
        import('../../infrastructure/workers/engineeringWorkerProtocol.js').EngineeringBuildResult['metrics']
      > & {
        caches: Array<{
          domain: string;
          encodeMs: number;
          plainBytes: number;
          encodedBytes: number;
        }>;
      })
    | null = null;
  cacheError = '';
  cleanup: (() => void) | null = null;
  listeners = new Set<() => void>();

  release(): void {
    const cleanup = this.cleanup;
    this.cleanup = null;
    cleanup?.();
  }
  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
  reset(): void {
    this.sources = null;
    this.snapshot = null;
    this.navigation = null;
    this.navigationCacheHit = false;
    this.treeStatus = 'none';
    this.ifcGeometryFinished = false;
    this.status = 'none';
    this.buildPending = false;
    this.progress = null;
    this.failureCode = null;
    this.error = '';
    this.cacheStatus = 'none';
    this.pipelineMetrics = null;
    this.cacheError = '';
    this.cleanup = null;
    this.listeners.clear();
  }
}
