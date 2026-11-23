/** Owns ordered, time-sliced scene submission for one DEV session. */
export class DevLodSceneCommits {
  constructor(
    private readonly current: () => boolean,
    private readonly cameraMovingUntil: () => number,
  ) {}

  get size(): number {
    return this.commits.length;
  }

  promote(root: string): void {
    for (const commit of this.commits) if (commit.root === root) commit.priority = 0;
    this.commits.sort((a, b) => a.priority - b.priority);
  }

  close(): void {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    for (const commit of this.commits)
      commit.reject(new DOMException('DEV session expired', 'AbortError'));
    this.commits = [];
    this.commitTimer = null;
  }

  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private commits: Array<{
    priority: number;
    root?: string;
    queuedAt: number;
    deferWhileMoving: boolean;
    run: () => void;
    reject: (e: Error) => void;
  }> = [];
  submit(priority: number, run: () => void, root?: string, deferWhileMoving = true): Promise<void> {
    return new Promise((resolve, reject) => {
      const commit = {
        priority,
        root,
        queuedAt: performance.now(),
        deferWhileMoving,
        run: () => {
          try {
            run();
            resolve();
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        },
        reject,
      };
      // Most station occurrences have the same priority. A linear search for
      // each insertion turns a full-station warm queue into quadratic work.
      // Insert after equal-priority rows to preserve their FIFO order.
      let low = 0,
        high = this.commits.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (this.commits[mid].priority <= priority) low = mid + 1;
        else high = mid;
      }
      if (low === this.commits.length) this.commits.push(commit);
      else this.commits.splice(low, 0, commit);
      this.drainCommits();
    });
  }
  private drainCommits(): void {
    if (!this.current()) {
      if (this.commitTimer) clearTimeout(this.commitTimer);
      this.commitTimer = null;
      for (const commit of this.commits.splice(0))
        commit.reject(new DOMException('Geometry session expired', 'AbortError'));
      return;
    }
    if (this.commitTimer) return;
    const firstViewBasePending = (this.commits[0]?.priority ?? Infinity) <= 1;
    // During first-view L0 admission, do not impose a fixed 16 ms gap on
    // every small placement. Bound each turn to 8 ms and yield to the event
    // loop; background commits use the less aggressive cadence.
    this.commitTimer = setTimeout(
      () => {
        this.commitTimer = null;
        const started = performance.now();

        while (this.commits.length && this.current()) {
          const now = performance.now();
          // Camera updates must not gate the first representation. A deferred
          // refinement must also not block lower-priority L0 behind it, and
          // continuous controls updates cannot starve a ready commit forever.
          const index =
            now >= this.cameraMovingUntil()
              ? 0
              : this.commits.findIndex(
                  (commit) =>
                    !commit.deferWhileMoving ||
                    commit.priority === 0 ||
                    now - commit.queuedAt >= 1000,
                );
          if (index < 0) break;
          this.commits.splice(index, 1)[0].run();
          if (performance.now() - started >= (firstViewBasePending ? 8 : 6)) break;
        }
        if (this.commits.length) this.drainCommits();
      },
      firstViewBasePending ? 0 : 8,
    );
  }
}
