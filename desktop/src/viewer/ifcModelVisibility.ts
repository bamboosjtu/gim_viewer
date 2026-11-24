import { setRenderVisibility } from './demandRendering.js';
/** Compose source-layer visibility, browsing isolation and L1/L2 replacement.
 * All item writes use the public Fragments API and share one queue. */
export interface IfcSelectionScope {
  localIds: Set<number>;
  globalIds: Set<string>;
  expressIds: Set<number>;
}

export interface IfcVisibilityModel {
  modelId: string;
  object: { visible: boolean };
  getItemsIdsWithGeometry(): Promise<number[]>;
  getVisible(ids: number[]): Promise<boolean[]>;
  setVisible(ids: number[] | undefined, visible: boolean): Promise<void>;
  getGuidsByLocalIds(ids: number[]): Promise<(string | null)[]>;
  getLocalIdsByGuids(guids: string[]): Promise<(number | null)[]>;
}

function sameMembers(a: ReadonlySet<number> | null, b: ReadonlySet<number> | null): boolean {
  return a === b || (!!a && !!b && a.size === b.size && [...a].every((id) => b.has(id)));
}

export class IfcModelVisibility {
  private scope: Set<number> | null = null;
  private allowed: ReadonlySet<number> | null = null;
  private hidden: ReadonlySet<number> = new Set();
  setBrowseMask(allowed: ReadonlySet<number> | null, hidden: ReadonlySet<number>) {
    const changed = !sameMembers(allowed, this.allowed) || !sameMembers(hidden, this.hidden);
    this.allowed = allowed;
    this.hidden = hidden;
    return this.setScope(this.scope, changed);
  }
  private geometryIds: number[] | null = null;
  private readonly masked = new Map<number, boolean>();
  private readonly pendingHide = new Set<number>();
  private detailOriginal = new Map<number, boolean>();
  private queue = Promise.resolve();
  private revision = 0;
  private committedRevision = 0;
  private released = false;
  private layer: boolean;
  constructor(readonly model: IfcVisibilityModel) {
    this.layer = model.object.visible;
  }
  get layerVisible(): boolean {
    return this.layer;
  }
  private enqueue(run: () => Promise<void>): Promise<void> {
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        if (!this.released) await run();
      });
    this.queue = task;
    return task;
  }
  private async read(ids: number[]): Promise<Map<number, boolean>> {
    const result = new Map<number, boolean>();
    for (let i = 0; i < ids.length && !this.released; i += 2048) {
      const batch = ids.slice(i, i + 2048),
        values = await this.model.getVisible(batch);
      if (values.length !== batch.length) throw Error('IFC visibility result length mismatch');
      batch.forEach((id, n) => result.set(id, values[n]));
    }
    return result;
  }
  private async writeIds(ids: number[], visible: boolean): Promise<void> {
    for (let i = 0; i < ids.length && !this.released; i += 2048)
      await this.model.setVisible(ids.slice(i, i + 2048), visible);
  }
  private async write(values: Map<number, boolean>): Promise<void> {
    for (const visible of [false, true]) {
      const ids = [...values].filter(([, value]) => value === visible).map(([id]) => id);
      await this.writeIds(ids, visible);
    }
  }
  setLayerVisible(visible: boolean): void {
    this.layer = visible;
    setRenderVisibility(
      this.model.object,
      visible &&
        (this.allowed === null || this.allowed.size > 0) &&
        this.committedRevision === this.revision &&
        (this.scope === null || this.scope.size > 0) &&
        !this.released,
    );
  }
  setScope(scope: ReadonlySet<number> | null, force = false): Promise<void> {
    if (!force && this.committedRevision === this.revision && sameMembers(scope, this.scope))
      return this.queue;
    this.scope = scope === null ? null : new Set(scope);
    const revision = ++this.revision;
    // Hide synchronously until the selected item mask is committed. An empty
    // scope hides a whole unrelated source without enumerating its items.
    setRenderVisibility(this.model.object, false);
    return this.enqueue(async () => {
      if (revision !== this.revision) return;
      const selected = this.scope,
        allowed = this.allowed,
        hidden = this.hidden;
      if (selected?.size !== 0 && allowed?.size !== 0)
        await this.updateMask(selected, allowed, hidden, revision);
      if (!this.released && revision === this.revision) {
        this.committedRevision = revision;
        setRenderVisibility(
          this.model.object,
          this.layer &&
            (this.allowed === null || this.allowed.size > 0) &&
            (selected === null || selected.size > 0),
        );
      }
    });
  }
  private async updateMask(
    selected: ReadonlySet<number> | null,
    allowed: ReadonlySet<number> | null,
    hidden: ReadonlySet<number>,
    revision: number,
  ): Promise<void> {
    // A deny-only filter has exact item addresses already. Allow lists need
    // the complement, which uses the model's immutable geometry ID list.
    let denied = hidden;
    if (selected || allowed) {
      const ids = this.geometryIds ?? (await this.model.getItemsIdsWithGeometry());
      if (this.released || revision !== this.revision) return;
      this.geometryIds = ids;
      denied = new Set(
        ids.filter(
          (id) =>
            hidden.has(id) || (selected && !selected.has(id)) || (allowed && !allowed.has(id)),
        ),
      );
    }
    const missing: number[] = [];
    for (const id of denied)
      if (!this.masked.has(id) && !this.detailOriginal.has(id)) missing.push(id);
    const original = await this.read(missing);
    if (this.released || revision !== this.revision) return;
    for (const id of denied) {
      if (this.masked.has(id)) continue;
      const before = this.detailOriginal.get(id) ?? original.get(id) ?? false;
      this.masked.set(id, before);
      if (before && !this.detailOriginal.has(id)) this.pendingHide.add(id);
    }
    const hide = [...this.pendingHide].filter((id) => denied.has(id));
    await this.writeIds(hide, false);
    if (this.released) return;
    for (const id of hide) this.pendingHide.delete(id);
    const unmasked = [...this.masked.keys()].filter((id) => !denied.has(id));
    const show = unmasked.filter((id) => this.masked.get(id) && !this.detailOriginal.has(id));
    try {
      await this.writeIds(show, true);
    } catch (error) {
      // A later mask can require these items hidden after a partially successful write.
      for (const id of show) this.pendingHide.add(id);
      throw error;
    }
    for (const id of unmasked) {
      this.masked.delete(id);
      this.pendingHide.delete(id);
    }
  }
  /** Hiding a far item remembers its original visibility; returning to far
   * restores that value, subject to the current isolation mask. */
  setDetailVisible(ids: number[], visible: boolean): Promise<void> {
    return this.enqueue(async () => {
      // A cancelled job may ask to restore an item before ever hiding it.
      // Only undo masks owned here; do not revive a pre-existing hidden item.
      if (visible) ids = ids.filter((id) => this.detailOriginal.has(id));
      if (!visible) {
        const missing = ids.filter((id) => !this.detailOriginal.has(id));
        const original = await this.read(missing.filter((id) => !this.masked.has(id)));
        if (this.released) return;
        for (const id of missing)
          this.detailOriginal.set(id, this.masked.get(id) ?? original.get(id) ?? false);
      }
      const values = new Map<number, boolean>();
      for (const id of ids) {
        const original = this.detailOriginal.get(id) ?? true;
        values.set(id, visible && original && !this.masked.has(id));
      }
      await this.write(values);
      if (visible) for (const id of ids) this.detailOriginal.delete(id);
    });
  }
  release(): void {
    this.released = true;
    this.revision++;
    this.geometryIds = null;
    this.masked.clear();
    this.pendingHide.clear();
    this.detailOriginal.clear();
  }
}
