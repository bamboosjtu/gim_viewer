/** Compose source-layer visibility, browsing isolation and L1/L2 replacement.
 * All item writes use the public Fragments API and share one queue. */
export interface IfcSelectionScope { localIds: Set<number>; globalIds: Set<string>; expressIds: Set<number> }

export interface IfcVisibilityModel {
  modelId: string;
  object: { visible: boolean };
  getItemsIdsWithGeometry(): Promise<number[]>;
  getVisible(ids: number[]): Promise<boolean[]>;
  setVisible(ids: number[] | undefined, visible: boolean): Promise<void>;
  getGuidsByLocalIds(ids: number[]): Promise<(string | null)[]>;
  getLocalIdsByGuids(guids: string[]): Promise<(number | null)[]>;
}

export class IfcModelVisibility {
  private scope: Set<number> | null = null;
  private baseline: Map<number, boolean> | null = null;
  private detailOriginal = new Map<number, boolean>();
  private queue = Promise.resolve();
  private revision = 0;
  private committedRevision = 0;
  private released = false;
  private layer: boolean;
  constructor(readonly model: IfcVisibilityModel) { this.layer = model.object.visible; }
  get layerVisible(): boolean { return this.layer; }
  private enqueue(run: () => Promise<void>): Promise<void> {
    const task = this.queue.catch(() => {}).then(async () => { if (!this.released) await run(); });
    this.queue = task;
    return task;
  }
  private async read(ids: number[]): Promise<Map<number, boolean>> {
    const result = new Map<number, boolean>();
    for (let i = 0; i < ids.length && !this.released; i += 2048) {
      const batch = ids.slice(i, i + 2048), values = await this.model.getVisible(batch);
      if (values.length !== batch.length) throw Error('IFC visibility result length mismatch');
      batch.forEach((id, n) => result.set(id, values[n]));
    }
    return result;
  }
  private async write(values: Map<number, boolean>): Promise<void> {
    for (const visible of [false, true]) {
      const ids = [...values].filter(([, value]) => value === visible).map(([id]) => id);
      for (let i = 0; i < ids.length && !this.released; i += 2048)
        await this.model.setVisible(ids.slice(i, i + 2048), visible);
    }
  }
  setLayerVisible(visible: boolean): void {
    this.layer = visible;
    this.model.object.visible = visible && this.committedRevision === this.revision
      && (this.scope === null || this.scope.size > 0) && !this.released;
  }
  setScope(scope: ReadonlySet<number> | null): Promise<void> {
    if (this.committedRevision === this.revision && (scope === null && this.scope === null
      || scope !== null && this.scope !== null && scope.size === this.scope.size && [...scope].every(id => this.scope!.has(id))))
      return this.queue;
    this.scope = scope === null ? null : new Set(scope);
    const revision = ++this.revision;
    // Hide synchronously until the selected item mask is committed. An empty
    // scope hides a whole unrelated source without enumerating its items.
    this.model.object.visible = false;
    return this.enqueue(async () => {
      if (revision !== this.revision) return;
      const selected = this.scope;
      if (selected?.size && !this.baseline) {
        this.baseline = await this.read(await this.model.getItemsIdsWithGeometry());
        for (const [id, visible] of this.detailOriginal) this.baseline.set(id, visible);
      }
      if (this.released) return;
      if (this.baseline) {
        const values = new Map<number, boolean>();
        for (const [id, visible] of this.baseline)
          values.set(id, visible && !this.detailOriginal.has(id) && (selected === null || selected.has(id)));
        await this.write(values);
        if (selected === null) this.baseline = null;
      }
      if (!this.released && revision === this.revision) {
        this.committedRevision = revision;
        this.model.object.visible = this.layer && (selected === null || selected.size > 0);
      }
    });
  }
  /** Hiding a far item remembers its original visibility; returning to far
   * restores that value, subject to the current isolation mask. */
  setDetailVisible(ids: number[], visible: boolean): Promise<void> {
    return this.enqueue(async () => {
      // A cancelled job may ask to restore an item before ever hiding it.
      // Only undo masks owned here; do not revive a pre-existing hidden item.
      if (visible) ids = ids.filter(id => this.detailOriginal.has(id));
      if (!visible) {
        const missing = ids.filter(id => !this.detailOriginal.has(id));
        const original = this.baseline ?? await this.read(missing);
        if (this.released) return;
        for (const id of missing) this.detailOriginal.set(id, original.get(id) ?? false);
      }
      const values = new Map<number, boolean>();
      for (const id of ids) {
        const original = this.detailOriginal.get(id) ?? this.baseline?.get(id) ?? true;
        if (visible) this.detailOriginal.delete(id);
        values.set(id, visible && original && (this.scope === null || this.scope.has(id)));
      }
      await this.write(values);
    });
  }
  release(): void { this.released = true; this.revision++; this.baseline = null; this.detailOriginal.clear(); }
}
