import type { FamSourceProperty } from '../../gim/famParser.js';
import type {
  FamPropertyRecord,
  LineFamPropertyRecord,
  LineDevPropertyRecord,
} from '@desktop/database.js';

type FamRow = Pick<
  FamPropertyRecord,
  'source_path' | 'section_name' | 'prop_key' | 'prop_value' | 'raw_property_json'
>;
const MAX_FAM_PATHS_PER_QUERY = 128; // Matches the native indexed FAM reader.
const emptySections = () => new Map([['默认', new Map<string, string>()]]);

interface WarmFamReader {
  resolve: (path: string) => string | null;
  read: (paths: readonly string[]) => Promise<readonly FamRow[]>;
  pending: Map<string, Promise<void>>;
}

export class ProjectPropertyCache {
  #warmFamReader: WarmFamReader | undefined;
  cachedFamSourceProperties = new Map<string, FamSourceProperty[]>();
  cachedIfcPaths = new Map<string, string>();
  cachedFamProperties = new Map<string, Map<string, Map<string, string>>>();
  cachedDevProperties = new Map<string, Record<string, string>>();
  cachedLineFamProperties = new Map<string, Map<string, LineFamPropertyRecord[]>>();
  cachedLineFamDisplayKeys = new Map<string, Map<string, string | null>>();
  cachedLineDevProperties = new Map<string, Map<string, LineDevPropertyRecord[]>>();

  private clearFamProperties(): void {
    this.cachedFamSourceProperties.clear();
    this.cachedFamProperties.clear();
  }

  restoreFamProperties(rows: readonly FamRow[], familyPaths: Iterable<string>): void {
    this.#warmFamReader = undefined;
    this.clearFamProperties();
    this.cacheFamRows(rows, familyPaths);
  }

  setWarmFamReader(resolve: WarmFamReader['resolve'], read: WarmFamReader['read']): void {
    this.clearFamProperties();
    this.#warmFamReader = { resolve, read, pending: new Map() };
  }

  invalidateWarmFamProperties(): boolean {
    const reader = this.#warmFamReader;
    if (!reader) return false;
    this.setWarmFamReader(reader.resolve, reader.read);
    return true;
  }

  async loadWarmFamProperties(paths: Iterable<string>): Promise<void> {
    const reader = this.#warmFamReader;
    if (!reader) return;
    const pending = new Set<Promise<void>>();
    const missing = new Set<string>();
    const resolvedPaths = new Set<string>();
    for (const path of paths) {
      const source = reader.resolve(path);
      if (!source) continue;
      resolvedPaths.add(source);
      if (this.cachedFamProperties.has(source)) continue;
      const active = reader.pending.get(source);
      if (active) pending.add(active);
      else missing.add(source);
    }
    const requested = [...missing];
    for (let offset = 0; offset < requested.length; offset += MAX_FAM_PATHS_PER_QUERY) {
      const chunk = requested.slice(offset, offset + MAX_FAM_PATHS_PER_QUERY);
      const task = reader
        .read(chunk)
        .then((rows) => {
          if (this.#warmFamReader === reader) this.cacheFamRows(rows, chunk);
        })
        .finally(() => {
          for (const path of chunk) reader.pending.delete(path);
        });
      for (const path of chunk) reader.pending.set(path, task);
      pending.add(task);
    }
    await Promise.all(pending);
    // A property repair can invalidate data while this inspector is waiting.
    // Retry only for that same reader, never after replacing the project.
    if (this.#warmFamReader !== reader && this.#warmFamReader?.read === reader.read)
      await this.loadWarmFamProperties(resolvedPaths);
  }

  private cacheFamRows(rows: readonly FamRow[], familyPaths: Iterable<string>): void {
    for (const row of rows) {
      let sections = this.cachedFamProperties.get(row.source_path);
      if (!sections) {
        sections = emptySections();
        this.cachedFamProperties.set(row.source_path, sections);
      }
      let section = sections.get(row.section_name);
      if (!section) {
        section = new Map();
        sections.set(row.section_name, section);
      }
      // The simple view keeps the last value; the raw view keeps duplicate rows.
      if (typeof row.prop_value === 'string') section.set(row.prop_key, row.prop_value);
      if (row.raw_property_json) {
        try {
          const property = JSON.parse(row.raw_property_json) as FamSourceProperty;
          const raw = this.cachedFamSourceProperties.get(row.source_path) ?? [];
          raw.push(property);
          this.cachedFamSourceProperties.set(row.source_path, raw);
        } catch {
          /* Keep the simple property when the raw row cannot be read. */
        }
      }
    }
    for (const path of familyPaths) {
      if (this.cachedFamProperties.has(path)) continue;
      this.cachedFamProperties.set(path, emptySections());
      this.cachedFamSourceProperties.set(path, []);
    }
  }

  reset(): void {
    this.#warmFamReader = undefined;
    this.clearFamProperties();
    this.cachedIfcPaths.clear();
    this.cachedDevProperties.clear();
    this.cachedLineFamProperties.clear();
    this.cachedLineFamDisplayKeys.clear();
    this.cachedLineDevProperties.clear();
  }
}
