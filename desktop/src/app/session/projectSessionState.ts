import type { GimProjectType } from '../../gim/projectType.js';
import { isCurrentProject, type ProjectLoadSession } from '../../shared/projectSession.js';
import { SessionScope, StaleSessionError } from '../../shared/sessionScope.js';
import { logger } from '../../utils/logger.js';

export function reportProjectReleaseError(error: unknown): void {
  logger.error('[Session] 资源释放失败', error);
}

/** Owns the project identity, transition, scope and open-request lifetimes. */
export class ProjectSessionState {
  projectType: GimProjectType | null = null;
  private generation = 0;
  private geometryToken = 0;
  private projectId: number | null = null;
  private sourceSha256: string | null = null;
  private accepting = true;
  private releasing = false;
  private scope: SessionScope | null = null;
  private openIntent: symbol | undefined;
  private openControls: symbol | undefined;
  private attachmentControls: symbol | undefined;
  private cleaning?: Promise<boolean>;

  constructor(private readonly release: (stillClosing: () => boolean) => void) {}

  get projectGeneration(): number {
    return this.generation;
  }
  get geometryLoadToken(): number {
    return this.geometryToken;
  }
  get currentProjectId(): number | null {
    return this.projectId;
  }
  get currentSourceSha256(): string | null {
    return this.sourceSha256;
  }

  advanceGeometryBatch(): void {
    this.geometryToken++;
  }

  capture(): ProjectLoadSession {
    return Object.freeze({
      generation: this.generation,
      projectId: this.projectId,
      sourceSha256: this.sourceSha256,
      geometryToken: this.geometryToken,
    }) as ProjectLoadSession;
  }

  isCurrent(session: ProjectLoadSession): boolean {
    return this.accepts(session) && !this.scope?.signal.aborted;
  }

  private accepts(session: ProjectLoadSession): boolean {
    return this.accepting && isCurrentProject(this, session);
  }

  scopeFor(session: ProjectLoadSession): SessionScope {
    if (this.scope && this.accepts(session)) return this.scope;
    const scope = new SessionScope(session, () => this.accepts(session), reportProjectReleaseError);
    if (this.accepts(session)) this.scope = scope;
    else scope.dispose();
    return scope;
  }

  invalidate(): number {
    const needsRelease = this.accepting || this.releasing;
    const generation = ++this.generation;
    this.geometryToken++;
    this.accepting = false;
    const scope = this.scope;
    this.scope = null;
    if (!needsRelease) return generation;
    const stillClosing = () => this.generation === generation;
    const releasing = this.releasing;
    this.releasing = true;
    try {
      scope?.dispose();
      if (stillClosing()) this.release(stillClosing);
    } finally {
      this.releasing = releasing;
    }
    return generation;
  }

  activate(projectId: number | null, sourceSha256?: string | null): ProjectLoadSession {
    const generation = this.invalidate();
    if (generation !== this.generation) throw new StaleSessionError();
    this.projectId = projectId;
    this.sourceSha256 = sourceSha256 ?? null;
    this.accepting = true;
    return this.capture();
  }

  finishCleanup(generation: number, admitEmptySession: boolean): boolean {
    if (generation !== this.generation || this.accepting) return false;
    this.projectId = null;
    this.sourceSha256 = null;
    this.accepting = admitEmptySession;
    return true;
  }

  queueCleanup(cleanup: () => Promise<boolean>): Promise<boolean> {
    const previous = this.cleaning ?? Promise.resolve();
    const current = previous.then(cleanup, cleanup).finally(() => {
      if (this.cleaning === current) this.cleaning = undefined;
    });
    this.cleaning = current;
    return current;
  }

  claimIntent() {
    const intent = Symbol('open-intent');
    const generation = this.generation;
    this.openIntent = intent;
    const isLatest = () => this.openIntent === intent;
    return { isLatest, isCurrent: () => isLatest() && this.generation === generation };
  }

  claimAttachmentControls(): () => boolean {
    const owner = Symbol('attachment-controls');
    this.attachmentControls = owner;
    return () => this.attachmentControls === owner;
  }

  beginOpen() {
    const controls = Symbol('open-controls');
    const generation = this.invalidate();
    const ownsControls = () => this.openControls === controls;
    if (this.generation === generation) this.openControls = controls;
    let session: ProjectLoadSession | undefined;
    return {
      generation,
      ownsControls,
      isCurrent: () =>
        ownsControls() && (session ? this.isCurrent(session) : this.generation === generation),
      setSession: (active: ProjectLoadSession) => {
        session = active;
      },
    };
  }
}
