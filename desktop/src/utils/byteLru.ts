/** A pin revision changes only when membership changes, not on each reference. */
export class RevisionSet<T> extends Set<T> {
  revision = 0;
  override add(value: T): this { if (!this.has(value)) { super.add(value); this.revision++; } return this; }
  override delete(value: T): boolean { const removed = super.delete(value); if (removed) this.revision++; return removed; }
  override clear(): void { if (this.size) { super.clear(); this.revision++; } }
}

/** Ownership-neutral LRU. Pinned values may exceed the budget; unused values cannot. */
export class ByteLru<T> {
  private rows = new Map<string, { value: T; bytes: number }>();
  private mutation = 0;
  private lastTrim?: { pins: ReadonlySet<string>; revision: number; mutation: number; budget: number };
  bytes = 0;
  constructor(public budget: number, private dispose: (value: T) => void = () => {}) {}
  get size(): number { return this.rows.size; }
  *values(): IterableIterator<T> { for (const row of this.rows.values()) yield row.value; }
  get(key: string): T | undefined {
    const row = this.rows.get(key); if (!row) return;
    this.rows.delete(key); this.rows.set(key, row); return row.value;
  }
  set(key: string, value: T, bytes: number, pinned: ReadonlySet<string> = new Set()): void {
    this.delete(key); this.rows.set(key, { value, bytes }); this.bytes += bytes; this.mutation++; this.trim(pinned);
  }
  trim(pinned: ReadonlySet<string>): void {
    if (this.bytes <= this.budget) return;
    const revision = pinned instanceof RevisionSet ? pinned.revision : undefined;
    const old = this.lastTrim;
    if (revision !== undefined && old?.pins === pinned && old.revision === revision && old.mutation === this.mutation && old.budget === this.budget) return;
    for (const key of this.rows.keys()) { if (this.bytes <= this.budget) break; if (!pinned.has(key)) this.delete(key); }
    if (revision !== undefined) this.lastTrim = { pins: pinned, revision, mutation: this.mutation, budget: this.budget };
  }
  delete(key: string): void { const row = this.rows.get(key); if (!row) return; this.rows.delete(key); this.bytes -= row.bytes; this.mutation++; this.dispose(row.value); }
  clear(): void { for (const key of this.rows.keys()) this.delete(key); }
}
