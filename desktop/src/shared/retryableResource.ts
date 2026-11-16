export type ResourcePhase = 'idle' | 'creating' | 'ready' | 'failed';

/** Share one initialization attempt; only successful resources remain cached. */
export class RetryableResource<T> {
  private pending: Promise<T> | null = null;
  phase: ResourcePhase = 'idle';
  peek(): Promise<T> | null { return this.pending; }
  get(create: () => T | Promise<T>): Promise<T> {
    if (this.pending) return this.pending;
    this.phase = 'creating';
    this.pending = Promise.resolve().then(create).then(value => {
      this.phase = 'ready';
      return value;
    }, error => {
      this.pending = null;
      this.phase = 'failed';
      throw error;
    });
    return this.pending;
  }
}
