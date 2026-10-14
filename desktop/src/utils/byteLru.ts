/** Ownership-neutral LRU. Pinned values may exceed the budget; unused values cannot. */
export class ByteLru<T> {
  private rows = new Map<string, { value: T; bytes: number }>();
  bytes = 0;
  constructor(readonly budget: number, private dispose: (value: T) => void = () => {}) {}
  get(key: string): T | undefined {
    const row = this.rows.get(key); if (!row) return;
    this.rows.delete(key); this.rows.set(key, row); return row.value;
  }
  set(key: string, value: T, bytes: number, pinned: ReadonlySet<string> = new Set()): void {
    this.delete(key); this.rows.set(key, { value, bytes }); this.bytes += bytes; this.trim(pinned);
  }
  trim(pinned: ReadonlySet<string>): void {
    for (const key of this.rows.keys()) { if (this.bytes <= this.budget) break; if (!pinned.has(key)) this.delete(key); }
  }
  delete(key: string): void { const row = this.rows.get(key); if (!row) return; this.rows.delete(key); this.bytes -= row.bytes; this.dispose(row.value); }
  clear(): void { for (const key of this.rows.keys()) this.delete(key); }
}
