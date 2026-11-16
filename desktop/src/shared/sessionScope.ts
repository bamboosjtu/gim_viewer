import type {ProjectLoadSession} from './projectSession.js';

export class StaleSessionError extends Error {
  constructor() {super('Project session no longer owns this work');this.name='StaleSessionError';}
}

/** One project owns cancellation, synchronous publication and registered resources. */
export class SessionScope {
  private readonly abort = new AbortController();
  private readonly disposables = new Set<() => void>();
  constructor(readonly session: ProjectLoadSession, private readonly current: () => boolean,
    private readonly reportError: (error: unknown) => void) {}
  get signal(): AbortSignal { return this.abort.signal; }
  isCurrent = (): boolean => !this.signal.aborted && this.current();

  /** Reject stale preparation. Publication still uses withSession: another
   * microtask can replace the project before the caller resumes its await. */
  async read<T>(prepare: () => Promise<T>): Promise<T> {
    if (!this.isCurrent()) throw new StaleSessionError();
    const value = await prepare();
    if (!this.isCurrent()) throw new StaleSessionError();
    return value;
  }

  /** Async preparation stays outside this synchronous commit boundary. */
  withSession(commit: () => undefined): boolean {
    if (!this.isCurrent()) return false;
    commit();
    return this.isCurrent();
  }
  own(dispose: () => void): () => void {
    let released = false;
    const release = () => {
      if (released) return; released = true; this.disposables.delete(release);
      try { dispose(); } catch (error) { this.reportError(error); }
    };
    if (!this.isCurrent()) release(); else this.disposables.add(release);
    return release;
  }
  dispose(): void {
    if (this.signal.aborted) return;
    this.abort.abort();
    for (const dispose of [...this.disposables]) dispose();
  }
}
