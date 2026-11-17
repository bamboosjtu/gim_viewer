import type {
  SourceGeometryOccurrence,
  SourceGeometryOccurrenceCatalog,
} from '../gim/engineering/geometryOccurrences.js';

/** Physical source publication is independent of semantic/entity readiness. */
export class SourceGeometryState {
  catalog: SourceGeometryOccurrenceCatalog | null = null;
  ready: Promise<SourceGeometryOccurrenceCatalog | null> | null = null;
  cachePending = false;
  cacheError = '';

  async read(isCurrent: () => boolean): Promise<SourceGeometryOccurrence[]> {
    if (!isCurrent()) return [];
    const catalog = this.catalog ?? (await this.ready);
    if (!isCurrent()) return [];
    if (!catalog) throw Error('来源物理实例尚不可用，请查看来源解析诊断');
    return catalog.occurrences;
  }

  reset(): void {
    this.catalog = null;
    this.ready = null;
    this.cachePending = false;
    this.cacheError = '';
  }
}
