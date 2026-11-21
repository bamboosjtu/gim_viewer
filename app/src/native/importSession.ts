import type { PowerlineProject } from '@gim/powerline-core';
import { commit, deleteProject, prepareNative, type Prepared } from './bridge';

/** Owns the native writes started by one import until they settle. */
export class NativeImportSession {
  private preparation?: Promise<Prepared>;
  private cacheWrite?: Promise<void>;
  private rollbackTask?: Promise<void>;

  prepare(input: Parameters<typeof prepareNative>[0]): Promise<Prepared> {
    this.preparation = prepareNative(input);
    return this.preparation;
  }

  commit(project: PowerlineProject): Promise<void> {
    this.cacheWrite = commit(project);
    return this.cacheWrite;
  }

  rollback(): Promise<void> {
    return this.rollbackTask ??= this.rollbackWrites();
  }

  private async rollbackWrites(): Promise<void> {
    const prepared = await this.preparation?.catch(() => undefined);
    await this.cacheWrite?.catch(() => undefined);
    if (prepared && !prepared.duplicate) {
      await deleteProject(prepared.meta.id).catch(() => {});
    }
  }
}
