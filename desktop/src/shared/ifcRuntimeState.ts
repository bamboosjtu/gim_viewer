import { createIfcRuntimeModelId, type ProjectLoadSession } from './projectSession.js';
import type { IfcEntry } from '../gim/types.js';
import type { IfcRegionalRuntime } from '../viewer/ifcRegionalRuntime.js';
import { logger } from '../utils/logger.js';
interface IfcRuntimeHost {
  captureSession(): ProjectLoadSession;
  isCurrentSession(session: ProjectLoadSession): boolean;
  entries(): readonly IfcEntry[];
}
/** Session-owned registry; late deletion must only remove its own runtime address. */
class RegionalSources extends Map<string, IfcRegionalRuntime> {
  revision = 0;
  override set(key: string, value: IfcRegionalRuntime) {
    if (this.get(key) !== value) this.revision++;
    return super.set(key, value);
  }
  override delete(key: string) {
    const removed = super.delete(key);
    if (removed) this.revision++;
    return removed;
  }
  override clear() {
    if (this.size) this.revision++;
    super.clear();
  }
}
export class IfcRuntimeState {
  readonly runtimeModelIds = new Map<string, string>();
  readonly logicalModelIds = new Map<string, string>();
  readonly modelOwners = new Map<string, ProjectLoadSession>();
  readonly loadedModels = new Map<
    string,
    { modelId: string; runtimeModelId: string; visible: boolean }
  >();
  readonly regionalRuntimes = new RegionalSources();
  constructor(private readonly host: IfcRuntimeHost) {}
  getRuntimeModelId(
    logicalModelId: string,
    session: ProjectLoadSession = this.host.captureSession(),
  ): string {
    const sourceIdentity =
      session.sourceSha256?.trim() ||
      `project:${session.projectId ?? 'none'}:generation:${session.generation}`;
    const runtimeModelId = createIfcRuntimeModelId(
      sourceIdentity,
      logicalModelId,
      session.generation,
    );
    if (this.host.isCurrentSession(session)) {
      this.runtimeModelIds.set(logicalModelId, runtimeModelId);
      this.logicalModelIds.set(runtimeModelId, logicalModelId);
    }
    return runtimeModelId;
  }
  registerIfcRuntimeModel(
    logicalModelId: string,
    runtimeModelId: string,
    owner: ProjectLoadSession,
  ): void {
    if (!this.host.isCurrentSession(owner)) return;
    this.runtimeModelIds.set(logicalModelId, runtimeModelId);
    this.logicalModelIds.set(runtimeModelId, logicalModelId);
    this.modelOwners.set(runtimeModelId, owner);
  }
  resolveLogicalModelId(runtimeModelId: string): string | null {
    return this.logicalModelIds.get(runtimeModelId) ?? null;
  }
  isCurrentRuntimeModel(runtimeModelId: string): boolean {
    if (this.modelOwners.has(runtimeModelId)) {
      const owner = this.modelOwners.get(runtimeModelId);
      return owner != null && this.host.isCurrentSession(owner);
    }
    const session = this.host.captureSession();
    return this.host
      .entries()
      .some(
        (entry) =>
          createIfcRuntimeModelId(
            session.sourceSha256?.trim() ||
              `project:${session.projectId ?? 'none'}:generation:${session.generation}`,
            entry.modelId,
            session.generation,
          ) === runtimeModelId,
      );
  }
  remove(runtimeModelId: string): { logicalModelId: string; removed: boolean } {
    const logicalModelId =
      this.resolveLogicalModelId(runtimeModelId) ??
      Array.from(this.loadedModels.values()).find((item) => item.runtimeModelId === runtimeModelId)
        ?.modelId ??
      runtimeModelId;
    const loaded = this.loadedModels.get(logicalModelId);
    const removed = !loaded || loaded.runtimeModelId === runtimeModelId;
    if (removed) {
      this.loadedModels.delete(logicalModelId);
      if (this.runtimeModelIds.get(logicalModelId) === runtimeModelId)
        this.runtimeModelIds.delete(logicalModelId);
    }
    this.logicalModelIds.delete(runtimeModelId);
    this.modelOwners.delete(runtimeModelId);
    return { logicalModelId, removed };
  }
  releaseRuntimes(): void {
    const runtimes = [...this.regionalRuntimes.values()];
    this.regionalRuntimes.clear();
    for (const runtime of runtimes)
      try {
        runtime.release();
      } catch (error) {
        logger.error('[IFC runtime] release failed', error);
      }
  }
  reset(): void {
    this.releaseRuntimes();
    this.runtimeModelIds.clear();
    this.logicalModelIds.clear();
    this.modelOwners.clear();
    this.loadedModels.clear();
  }
}
