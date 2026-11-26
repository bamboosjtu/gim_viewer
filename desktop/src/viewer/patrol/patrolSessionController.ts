import type {
  NavigationMode,
  ViewerNavigationCommands,
} from '../../shared/viewerNavigationCommands.js';

export type PatrolOperationMode = Extract<
  NavigationMode,
  'operatingDoor' | 'returning' | 'pickingDevice' | 'restoringSelection'
>;

/** One frozen position and one result publisher for each asynchronous patrol operation. */
export class PatrolOperationOwner {
  private active?: AbortController;
  cancel() {
    this.active?.abort();
    this.active = undefined;
  }
  async run(
    port: ViewerNavigationCommands,
    session: AbortSignal,
    mode: PatrolOperationMode,
    message: string,
    stop: () => void,
    work: (signal: AbortSignal) => Promise<() => void>,
    onFailure: (message: string) => void,
  ) {
    this.cancel();
    const owner = new AbortController();
    this.active = owner;
    const signal = AbortSignal.any([owner.signal, session]);
    try {
      signal.throwIfAborted();
      port.set(mode, message);
      stop();
      const commit = await work(signal);
      if (!signal.aborted) commit();
    } catch (error) {
      if (!signal.aborted) onFailure(String(error));
    } finally {
      if (this.active === owner) this.active = undefined;
    }
  }
}

/** Restore independent pieces even when a previous provider fails. */
export async function restorePatrolContext(
  current: () => boolean,
  steps: readonly (readonly [string, () => void | Promise<void>])[],
) {
  const failures: string[] = [];
  for (const [label, restore] of steps) {
    if (!current()) break;
    try {
      await restore();
    } catch (error) {
      failures.push(label + '（' + String(error) + '）');
    }
  }
  return failures;
}
