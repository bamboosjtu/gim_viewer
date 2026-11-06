/** Incremental per-occurrence readiness accounting; no scene, IO or UI ownership. */
import type { DeviceLod } from '../viewer/devLodPolicy.js';
import type { Occurrence } from './devLodTypes.js';
interface ReadinessContribution {
  visible: boolean;
  finished: boolean;
  shown: boolean;
  empty: boolean;
  unsupported: boolean;
  partial: boolean;
  failed: boolean;
  viewPending: boolean;
  viewSettled: boolean;
  viewReady: boolean;
  baseSettled: boolean;
  baseReady: boolean;
  allReady: boolean;
}

type ReadinessCounterKey = keyof ReadinessContribution;

type ReadinessCounters = Record<ReadinessCounterKey, number> & { total: number };

function emptyReadinessCounters(): ReadinessCounters {
  return {
    total: 0, visible: 0, finished: 0, shown: 0, empty: 0, unsupported: 0,
    partial: 0, failed: 0, viewPending: 0, viewSettled: 0, viewReady: 0,
    baseSettled: 0, baseReady: 0, allReady: 0,
  };
}

function addReadinessContribution(counters: ReadinessCounters, contribution: ReadinessContribution, sign: 1 | -1): void {
  for (const key of Object.keys(contribution) as ReadinessCounterKey[]) {
    if (contribution[key]) counters[key] += sign;
  }
}

export function contributionForRow(row: Occurrence, keyFor: (dev: string, lod: DeviceLod) => string): ReadinessContribution {
  const terminal = row.entry.templateStatus === 'empty' || row.entry.templateStatus === 'unsupported';
  const keyLod = row.desired ?? 0;
  const key = keyFor(row.entry.devPath, keyLod);
  const browseKey = keyFor(row.entry.devPath, row.browseDesired ?? Math.min(1, keyLod) as DeviceLod);
  const complete = !!row.group || terminal;
  const requested = terminal || (row.group != null && row.displayed >= (row.browseDesired ?? row.desired ?? 0)) || row.key === browseKey;
  const failure = row.failedKey === key;
  return {
    visible: row.inView,
    finished: complete || failure,
    shown: !!row.group,
    empty: row.entry.templateStatus === 'empty',
    unsupported: row.entry.templateStatus === 'unsupported',
    partial: row.geometryStatus === 'partial',
    failed: row.entry.templateStatus === 'failed',
    viewPending: row.inView && !requested && !failure,
    viewSettled: !row.inView || requested || failure,
    viewReady: !row.inView || (requested && !failure),
    baseSettled: complete || failure,
    baseReady: complete,
    allReady: terminal || (row.geometryStatus === 'complete' && row.displayed === 2),
  };
}
export class DevLodReadiness {
  private get rows() { return this.getRows(); }
  constructor(private readonly getRows: () => Map<string, Occurrence>, private readonly key: (dev: string, lod: DeviceLod) => string, private readonly reportError: (message: string) => void) { this.readinessRowsSource = getRows(); }
  /** Readiness is maintained on row state transitions rather than scanning the
    * full occurrence map on every status refresh.  A bounded opt-in audit can
    * still recompute the counters to catch future transition omissions. */
  readonly readinessRows = new Map<string, ReadinessContribution>();

  readonly readinessCounters = emptyReadinessCounters();

  readinessRowsSource: Map<string, Occurrence>;

  readinessAuditCount = 0;

  updateReadiness(row: Occurrence): void {
    const key = row.entry.rootOccurrence ?? row.entry.instanceKey;
    const previous = this.readinessRows.get(key);
    if (previous) addReadinessContribution(this.readinessCounters, previous, -1);
    else this.readinessCounters.total++;
    const next = contributionForRow(row, (dev, lod) => this.key(dev, lod));
    addReadinessContribution(this.readinessCounters, next, 1);
    this.readinessRows.set(key, next);
  }

  removeReadiness(rootOccurrence: string): void {
    const previous = this.readinessRows.get(rootOccurrence);
    if (!previous) return;
    addReadinessContribution(this.readinessCounters, previous, -1);
    this.readinessCounters.total = Math.max(0, this.readinessCounters.total - 1);
    this.readinessRows.delete(rootOccurrence);
  }

  private recomputeReadinessForAudit(): ReadinessCounters {
    const counters = emptyReadinessCounters();
    for (const row of this.rows.values()) {
      counters.total++;
      addReadinessContribution(counters, contributionForRow(row, (dev, lod) => this.key(dev, lod)), 1);
    }
    return counters;
  }

  private readinessCountersMatch(expected: ReadinessCounters): boolean {
    const keys = Object.keys(expected) as (keyof ReadinessCounters)[];
    return keys.every((key) => this.readinessCounters[key] === expected[key]);
  }

  /**
     * Keep the transition-maintained counters usable when a diagnostic/test
     * consumer replaces the occurrence map wholesale. Production transitions
     * update the counters directly; this repair path is only taken when the
     * map identity no longer matches the tracked rows (and in Vitest, where
     * tests intentionally mutate rows to model late results).
     */
  syncReadinessCounters(): void {
    const counters = emptyReadinessCounters();
    const rows = new Map<string, ReadinessContribution>();
    for (const row of this.rows.values()) {
      const key = row.entry.rootOccurrence ?? row.entry.instanceKey;
      const contribution = contributionForRow(row, (dev, lod) => this.key(dev, lod));
      counters.total++;
      addReadinessContribution(counters, contribution, 1);
      rows.set(key, contribution);
    }
    Object.assign(this.readinessCounters, counters);
    this.readinessRows.clear();
    for (const [key, contribution] of rows) this.readinessRows.set(key, contribution);
    this.readinessRowsSource = this.rows;
  }

  readinessRowsMatch(): boolean {
    // Do not scan the full catalog here. The source-map identity catches
    // wholesale replacement by a diagnostic/test consumer; normal production
    // mutations are accounted for by updateReadiness on each transition.
    return this.readinessRowsSource === this.rows
      && this.readinessRows.size === this.rows.size
      && this.readinessCounters.total === this.rows.size;
  }

  auditReadinessCounters(enabled: boolean): void {
    if (!enabled) return;
    this.readinessAuditCount++;
    if (this.readinessAuditCount % 20 !== 0) return;
    const expected = this.recomputeReadinessForAudit();
    if (this.readinessCountersMatch(expected)) return;
    this.reportError(`readiness counter mismatch: incremental=${JSON.stringify(this.readinessCounters)} full=${JSON.stringify(expected)}`);
  }
  clear(): void { this.readinessRows.clear(); Object.assign(this.readinessCounters, emptyReadinessCounters()); }
}
