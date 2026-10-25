import { ByteWorkBudget } from '../utils/byteWorkBudget.js';
import {DevTemplateCacheReader} from './devTemplateCacheReader.js';
import * as THREE from 'three';
import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import { chooseDeviceLod, deviceViewMetrics, createDeviceViewContext, type DeviceLod } from '../viewer/devLodPolicy.js';
import { ByteLru, RevisionSet } from '../utils/byteLru.js';
import { collectCbmDeviceInstances, parseCbmTransformMatrix, ensureGeometryLayers } from './modAutoLoadService.js';
import { DevGlbTemplate, createLegacyEquivalentPlacementMatrix, validateDevGlbTemplate } from './devGlbTemplateRuntime.js';
import { parseDevGlbAsset, type DevGlbSerializationResult } from './glbCacheService.js';
import { createDevGeometryPreprocessor, type DevGeometryPreprocessor } from './devGeometryWorkerClient.js';
import { invalidGeometryExtent, GEOMETRY_MAX_EXTENT_M } from '../viewer/geometryBounds.js';
import { DEV_GEOMETRY_VERSION, DEV_SPATIAL_CATALOG_VERSION, boxTuple, tupleBox, type DevSourceBounds, type DevSpatialOccurrence } from './devSpatialCatalog.js';
import { readDevArtifactResult, readDevArtifactBatch, writeDevArtifactDetailed, prepareDevArtifact, deleteDevArtifact, type DevArtifactRead, type DevArtifactReadStatus } from '@desktop/devLodCache.js';
import { readCachedEntry } from '@desktop/database.js';
import { batchReadCachedFiles } from '@desktop/database.js';
import { perfCurrentSession, perfMark, perfMarkProductMoment, perfMeasureTaskPhase, perfRecordTaskPhase, type PerfTaskIdentity } from '../utils/perfTimings.js';
import { diagnosticForFailure, diagnosticFromSerialization, setGeometryDiagnostic } from '../gim/geometry/geometryDiagnostics.js';
import { resetModHighlight, highlightModGroups } from '../viewer/highlight.js';
import { InvalidDevGeometryError } from '../gim/geometry/sourceGeometryError.js';
import { WorkQueue } from '../utils/workQueue.js';
import { startSubstationResourceMonitor } from './substationResourceTelemetry.js';
import { BoxViewIndex } from '../viewer/boxViewIndex.js';
import { DevInstanceBatches } from '../viewer/devInstanceBatches.js';
import { isDevInstanceBatchesEnabled } from '../config/features.js';

interface CachedTemplate { result: DevGlbSerializationResult; sha: string; sourceInvalid?: { message: string; evidence: string } }
interface TemplateRow { bounds: THREE.Box3; template: DevGlbTemplate; sha: string; status: DevGlbSerializationResult['status']; diagnostics: DevGlbSerializationResult['diagnostics']; task?: PerfTaskIdentity }
interface CacheDecision { key: string; devPath: string; lod: DeviceLod; status: DevArtifactReadStatus | 'compiled' | 'write-failed'; reason?: string }
interface Occurrence { entry: DevSpatialOccurrence; inView: boolean; box: THREE.Box3 | null; desired: DeviceLod | null; browseDesired: DeviceLod | null; displayed: DeviceLod; geometryStatus?: DevGlbSerializationResult['status']; group?: THREE.Group; key?: string; failedKey?: string }
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

const READINESS_AUDIT_STORAGE_KEY = 'GIM_READINESS_AUDIT';

function readinessAuditEnabled(): boolean {
  try { return window.localStorage.getItem(READINESS_AUDIT_STORAGE_KEY) === '1'; } catch { return false; }
}

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

function contributionForRow(row: Occurrence, keyFor: (dev: string, lod: DeviceLod) => string): ReadinessContribution {
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
type MemoryPressure = 'unknown' | 'normal' | 'high' | 'critical';
const pressureRank = (pressure: MemoryPressure): number => ({ unknown: -1, normal: 0, high: 1, critical: 2 }[pressure]);
const maxMemoryPressure = (left: MemoryPressure, right: MemoryPressure): MemoryPressure =>
  pressureRank(left) >= pressureRank(right) ? left : right;
const normalize = (path: string) => /^dev\//i.test(path.replace(/\\/g, '/')) ? path.replace(/\\/g, '/') : `DEV/${path}`;
const hash = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map(v => v.toString(16).padStart(2, '0')).join('');
const belongsTo = (object: THREE.Object3D, root?: THREE.Object3D) => {
  for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (parent === root) return true;
  return false;
};

/** Session owner for catalog, templates and camera-driven occurrence representations. */
export class DevLodRuntime {
  private readonly batchEnabled = isDevInstanceBatchesEnabled();
  private instances?: DevInstanceBatches;
  private readonly viewIndex = new BoxViewIndex();
  readonly diagnostics = { catalogReady: false, currentViewReady: false, currentViewSettled: false, baseRepresentationsSettled: false, baseRepresentationsReady: false, allStationReady: false, catalogHits: 0,
    templateHits: 0, compiled: [0, 0, 0], /** Per-LOD cache/compile facts; index is LOD. */ lodHits: [0, 0, 0], lodCompiled: [0, 0, 0],
    lodReadErrors: [0, 0, 0], lodInvalid: [0, 0, 0], lodWriteFailed: [0, 0, 0], lodPersisted: [0, 0, 0],
    occurrences: 0, uniqueDevSources: 0, sceneCommitCount: 0, sceneCommitMaxMs: 0, shown: 0, pending: 0, unknownBounds: 0,
    absoluteConeCount: 0, templateResidentBytes: 0, directoryCompleted: 0, readyOccurrences: 0, failedOccurrences: 0,
    emptyOccurrences: 0, unsupportedOccurrences: 0, partialOccurrences: 0, templateParses: 0, templateEvictions: 0, workerCount: 0, activeDevices: [] as string[],
    inputBudgetBytes: 0, inputBudgetPeakBytes: 0,
    cacheWriteReservedBytes: 0, cacheWritePeakBytes: 0, cacheWriteWaitingBytes: 0,
    cacheWritePendingCount: 0, cacheWritesSettled: true, cacheWritesReady: true, cacheWriteCancelled: 0,
    cacheReadBatches:0,cacheReadEntries:0,cacheReadDeferred:0,viewPendingOccurrences:0,
    cacheHits:0,cacheMisses:0,cacheReadErrorCount:0,cacheInvalidCount:0,
    lodMisses:[0,0,0],
    artifactWriteAttempts:0,artifactWriteFailures:0,catalogWriteFailures:0,
    workerReads:0,workerRpcReads:0,workerSourceHits:0,workerDocumentHits:0,workerReadRpcMs:0,workerParseMs:0,workerQueueWaitMs:0,
    workerSourceAffinityHits:0, workerSourceAffinityDeferrals:0,
    cacheDecisions: [] as CacheDecision[], readinessBlockers:[] as string[],viewPendingSamples:[] as string[],
    resultQueuedBytes: 0, resultPeakBytes: 0, resultQueueCount: 0,
    workerScheduling: null as ReturnType<DevGeometryPreprocessor['schedulingSnapshot']> | null,
    workerStages: {} as Record<string, { count: number; totalMs: number; maxMs: number }>,
    workerTimedOutTasks: 0, workerStallSnapshots: 0,
    memoryPressure: 'unknown' as MemoryPressure,
    externalMemoryPressure: 'unknown' as MemoryPressure,
    jsHeapUsedBytes: null as number | null, jsHeapLimitBytes: null as number | null,
    autoLodSuppressed: false, memoryTrimCount: 0,
    viewIndex: null as BoxViewIndex['diagnostics'] | null,
    backgroundPaused: false,
    instancing: null as null | ({enabled: boolean} & DevInstanceBatches['statistics']),
    browseState: 'loading' as 'loading' | 'browseable' | 'base-settled' | 'partial',
    fineFailures: [] as string[],
    anchorReady: false, errors: [] as string[], fingerprints: [] as Record<string, unknown>[] };
  private readonly perf = perfCurrentSession();
  private taskSequence = 0;
  private taskIdentity(sourcePath: string, kind: string, lod?: DeviceLod, priority?: number): PerfTaskIdentity {
    return {taskId: `${this.perf.id}:dev-${kind}:${++this.taskSequence}`, domain: 'dev', kind, sourcePath,
      generation: this.session.generation, lod, priority, cacheSource: 'unknown'};
  }
  private released = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cameraTimer: ReturnType<typeof setTimeout> | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private commits: Array<{ priority: number; root?: string; run: () => void; reject: (e: Error) => void }> = [];
  private cameraMovingUntil = 0;
  private cameraSchedule = () => {
    this.diagnostics.currentViewReady = false;
    this.diagnostics.currentViewSettled = false;
    this.cameraMovingUntil = performance.now() + 200;
    if (this.cameraTimer) clearTimeout(this.cameraTimer);
    this.cameraTimer = setTimeout(() => { this.cameraTimer = null; this.update(); }, 200);
  };
  private requestReady(): void {
    if (this.statusTimer || !this.current()) return;
    this.statusTimer = setTimeout(() => { this.statusTimer = null; this.ready(); }, 100);
  }
  private submit(priority: number, run: () => void, root?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const commit = { priority, root, run: () => { try { run(); resolve(); } catch (e) { reject(e); } }, reject };
      const position = this.commits.findIndex(row => row.priority > priority);
      if (position < 0) this.commits.push(commit); else this.commits.splice(position, 0, commit);
      this.drainCommits();
    });
  }
  private drainCommits(): void {
    if (this.commitTimer || !this.current()) return;
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      const started = performance.now();

      while (this.commits.length && this.current()) {
        if (performance.now() < this.cameraMovingUntil && this.commits[0].priority > 0) break;
        this.commits.shift()!.run();
        if (performance.now() - started >= 4) break;
      }
      if (this.commits.length) this.drainCommits();
    }, 16);
  }
  private wanted = new Set<string>();
  private displayedPins = new Map<string, number>();
  private pinKeys = new RevisionSet<string>();
  private selected = '';
  /** Explicit L2 requests owned by the active selection. */
  private fineRequested = new Set<string>();
  private memoryPressure: MemoryPressure = 'unknown';
  private jsMemoryPressure: MemoryPressure = 'unknown';
  private externalMemoryPressure: MemoryPressure = 'unknown';
  private readonly pauseEvent = () => this.setBackgroundPaused(!this.diagnostics.backgroundPaused);
  private onlySelected = false;
  private pending = new Map<string, Promise<TemplateRow | null>>();
  private nullResults = new Map<string, 'empty' | 'unsupported'>();
  private priorities = new Map<string, number>();
  private templateSlots = 0;
  private inputBudget = new ByteWorkBudget(128 * 1024 * 1024);
  private cacheReader:DevTemplateCacheReader<CachedTemplate>;
  /** Admitted writes own at most one maximum asset plus metadata (129 MiB).
   * Waiting template buffers retain their input lease until writer admission. */
  private writeBudget = new ByteWorkBudget(129 * 1024 * 1024);
  private writeWaitingBytes = 0;
  private writeSlots = 0;
  private writeWaiters: Array<{resolve: () => void; reject: (error: Error) => void}> = [];
  private pendingWrites = new Map<string, Promise<void>>();
  private writeAdmissions = new Map<string, Promise<void>>();
  private placementUsers = new Map<string, number>();
  private templateWaiters = new Map<string, { queuedAt: number; resolve: (release: () => void) => void; reject: (error: Error) => void }>();
  private templateQueue = new WorkQueue<{ queuedAt: number; resolve: (release: () => void) => void; reject: (error: Error) => void }>();
  private rows = new Map<string, Occurrence>();
  /** Readiness is maintained on row state transitions rather than scanning the
   * full occurrence map on every status refresh.  A bounded opt-in audit can
   * still recompute the counters to catch future transition omissions. */
  private readonly readinessRows = new Map<string, ReadinessContribution>();
  private readonly readinessCounters = emptyReadinessCounters();
  private readinessRowsSource: Map<string, Occurrence> = this.rows;
  private readinessAuditCount = 0;
  private sourceFailures = new Map<string, InvalidDevGeometryError>();
  private catalogHints = new Map<string, Promise<DevArtifactRead<DevSourceBounds>>>();
  private templates = new ByteLru<TemplateRow>(128 * 1024 * 1024, row => { row.template.dispose(); if (!this.released) this.diagnostics.templateEvictions++; });
  private worker!: DevGeometryPreprocessor;
  private sourceFiles?: Map<string, File>;
  private recoveryMisses = new Set<string>();
  private sourceRecoveryAttempted = false;
  private anchor: THREE.Matrix4 | null = null;
  startup: Promise<void> = Promise.resolve();
  private sourceIdentity: string;
  private catalogDone: Promise<void> = Promise.resolve();
  private finishCatalog!: () => void;
  private anchorDone: Promise<void>;
  private finishAnchor!: () => void;
  constructor(private state: AppState, private ctx: ViewerContext, private session: ProjectLoadSession, private status: (text: string, detail?: string) => void) {
    this.sourceIdentity = session.sourceSha256 ?? '';
    this.cacheReader=new DevTemplateCacheReader(this.inputBudget,session);
    this.catalogDone = new Promise(resolve => { this.finishCatalog = resolve; });
    this.anchorDone = new Promise(resolve => { this.finishAnchor = resolve; });
    window.addEventListener('gim-toggle-background-detail', this.pauseEvent);
  }
  private current = () => !this.released && this.state.isCurrentSession(this.session);
  private updateReadiness(row: Occurrence): void {
    const key = row.entry.rootOccurrence ?? row.entry.instanceKey;
    const previous = this.readinessRows.get(key);
    if (previous) addReadinessContribution(this.readinessCounters, previous, -1);
    else this.readinessCounters.total++;
    const next = contributionForRow(row, (dev, lod) => this.key(dev, lod));
    addReadinessContribution(this.readinessCounters, next, 1);
    this.readinessRows.set(key, next);
  }
  private removeReadiness(rootOccurrence: string): void {
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
   * tests intentionally mutate private rows to model late results).
   */
  private syncReadinessCounters(): void {
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
  private readinessRowsMatch(): boolean {
    // Do not scan the full catalog here. The source-map identity catches
    // wholesale replacement by a diagnostic/test consumer; normal production
    // mutations are accounted for by updateReadiness on each transition.
    return this.readinessRowsSource === this.rows
      && this.readinessRows.size === this.rows.size
      && this.readinessCounters.total === this.rows.size;
  }
  private auditReadinessCounters(): void {
    if (!readinessAuditEnabled()) return;
    this.readinessAuditCount++;
    if (this.readinessAuditCount % 20 !== 0) return;
    const expected = this.recomputeReadinessForAudit();
    if (this.readinessCountersMatch(expected)) return;
    this.diagnostics.errors.push(`readiness counter mismatch: incremental=${JSON.stringify(this.readinessCounters)} full=${JSON.stringify(expected)}`);
    if (this.diagnostics.errors.length > 32) this.diagnostics.errors.shift();
  }
  /** Apply the strongest available browser/process-tree pressure signal. */
  private applyMemoryPressure(): void {
    this.memoryPressure = maxMemoryPressure(this.jsMemoryPressure, this.externalMemoryPressure);
    this.diagnostics.memoryPressure = this.memoryPressure;
    this.diagnostics.externalMemoryPressure = this.externalMemoryPressure;
    this.diagnostics.autoLodSuppressed = this.memoryPressure === 'high' || this.memoryPressure === 'critical';
    this.worker?.setMemoryPressure?.(this.memoryPressure);
    if (this.memoryPressure === 'high' || this.memoryPressure === 'critical') {
      const budget = this.templates.budget;
      if (this.memoryPressure === 'critical') this.templates.budget = 0;
      this.templates.trim(this.pinned());
      this.templates.budget = budget;
      this.diagnostics.memoryTrimCount++;
    }
    this.requestReady();
  }
  /**
   * Feed the native process-tree sample back into the browser scheduler.
   * `unknown` deliberately removes only the external signal; a still-known
   * JS heap pressure remains in force.  The native value is advisory because
   * WebView2/GPU allocations are not fully visible to this runtime.
   */
  setExternalMemoryPressure(pressure: MemoryPressure): void {
    if (this.released) return;
    const changed = this.externalMemoryPressure !== pressure;
    this.externalMemoryPressure = pressure;
    this.applyMemoryPressure();
    if (changed) this.schedule();
  }
  /** Browser-visible heap pressure is a feedback signal, never a claim about
   * the full Tauri process tree or GPU residency. */
  private refreshMemoryPressure(): void {
    const memory = (typeof performance !== 'undefined'
      ? (performance as Performance & { memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number } }).memory
      : undefined);
    const used = Number(memory?.usedJSHeapSize), limit = Number(memory?.jsHeapSizeLimit);
    if (!(used > 0) || !(limit > 0)) {
      this.jsMemoryPressure = 'unknown';
      this.diagnostics.jsHeapUsedBytes = null;
      this.diagnostics.jsHeapLimitBytes = null;
      this.applyMemoryPressure();
      return;
    }
    const ratio = used / limit;
    this.jsMemoryPressure = ratio >= 0.9 ? 'critical' : ratio >= 0.8 ? 'high' : 'normal';
    this.diagnostics.jsHeapUsedBytes = used;
    this.diagnostics.jsHeapLimitBytes = limit;
    this.applyMemoryPressure();
  }
  private key(dev: string, lod: DeviceLod) { return `${DEV_GEOMETRY_VERSION}|${this.sourceIdentity}|${dev.toLowerCase()}|lod${lod}`; }
  private catalogKey(dev: string) { return `${DEV_SPATIAL_CATALOG_VERSION}|${DEV_GEOMETRY_VERSION}|${this.sourceIdentity}|${dev.toLowerCase()}`; }
  /** A catalog read started before the directory loop reaches this DEV also
   * short-circuits already-queued LOD0 work for a validated empty source. */
  private catalogHint(dev: string): Promise<DevArtifactRead<DevSourceBounds>> {
    const existing = this.catalogHints.get(dev);
    if (existing) return existing;
    const pending = readDevArtifactResult<DevSourceBounds>('catalog', this.catalogKey(dev), this.session);
    this.catalogHints.set(dev, pending);
    return pending;
  }
  private markEmptyDev(dev: string): void {
    for (const row of this.rows.values()) {
      if (row.entry.devPath.toLowerCase() !== dev.toLowerCase()) continue;
      row.entry.templateStatus = 'empty'; row.desired = 0;
      this.wanted.delete(this.key(dev, 0));
      this.wanted.delete(this.key(dev, 1));
      this.wanted.delete(this.key(dev, 2));
      this.updateReadiness(row);
    }
    this.worker?.cancelQueued(this.wanted);
  }
  private recordCacheDecision(devPath: string, lod: DeviceLod, status: CacheDecision['status'], reason?: string): void {
    this.diagnostics.cacheDecisions.push({ key: this.key(devPath, lod), devPath, lod, status, ...(reason ? { reason } : {}) });
    if (this.diagnostics.cacheDecisions.length > 1024) this.diagnostics.cacheDecisions.shift();
  }
  private async withWriteSlot<T>(work: () => Promise<T>): Promise<T> {
    while (this.writeSlots >= 4) {
      if (!this.current()) throw new DOMException('DEV cache write cancelled', 'AbortError');
      await new Promise<void>((resolve, reject) => this.writeWaiters.push({resolve, reject}));
    }
    if (!this.current()) throw new DOMException('DEV cache write cancelled', 'AbortError');
    this.writeSlots++;
    try { return await work(); }
    finally { this.writeSlots--; this.writeWaiters.shift()?.resolve(); }
  }
  private updateWriteDiagnostics(): void {
    Object.assign(this.diagnostics, {cacheWriteReservedBytes: this.writeBudget.bytes, cacheWritePeakBytes: this.writeBudget.peakBytes,
      cacheWriteWaitingBytes: this.writeWaitingBytes, cacheWritePendingCount: this.pendingWrites.size,
      cacheWritesSettled: this.pendingWrites.size === 0,
      cacheWritesReady: this.pendingWrites.size === 0 && this.diagnostics.artifactWriteFailures === 0 && this.diagnostics.cacheWriteCancelled === 0});
  }
  /** Persist a derived artifact without blocking geometry availability.
   * Source SHA, project identity and atomic native replacement still apply. */
  private persistArtifact(store: 'templates' | 'catalog', key: string, value: unknown, lod?: DeviceLod, devPath?: string,
    trace?: PerfTaskIdentity, inputHandoff?: () => void): Promise<void> {
    let releasedInput = false;
    const releaseInput = (): void => { if (!releasedInput) { releasedInput = true; inputHandoff?.(); } };
    if (!this.current() || !this.session.sourceSha256) { releaseInput(); return Promise.resolve(); }
    const queueKey = `${store}:${key}`;
    if (this.pendingWrites.has(queueKey)) { releaseInput(); return this.writeAdmissions.get(queueKey) ?? Promise.resolve(); }
    const identity = trace ?? this.taskIdentity(devPath ?? key, `${store}-write`, lod);
    const queuedAt = performance.now();
    let prepared: ReturnType<typeof prepareDevArtifact>;
    try { prepared = prepareDevArtifact(key, value); }
    catch (error) {
      perfRecordTaskPhase(identity, 'cachePrepare', performance.now() - queuedAt, this.perf, 'failed');
      releaseInput(); this.diagnostics.artifactWriteFailures++;
      this.diagnostics.errors.push(`缓存准备失败 ${store}:${key}: ${String(error)}`);
      if (this.diagnostics.errors.length > 32) this.diagnostics.errors.shift();
      this.updateWriteDiagnostics(); return Promise.resolve();
    }
    perfRecordTaskPhase(identity, 'cachePrepare', performance.now() - queuedAt, this.perf, 'completed', prepared.retainedBytes);
    this.writeWaitingBytes += prepared.retainedBytes;
    const admission = this.writeBudget.acquire(prepared.retainedBytes).finally(() => {
      this.writeWaitingBytes -= prepared.retainedBytes; releaseInput(); this.updateWriteDiagnostics();
    });
    const admitted = admission.then(() => undefined, () => undefined);
    let enteredWrite = false;
    const task = admission.then(async releaseWrite => { try { await this.withWriteSlot(async () => {
      if (!this.current()) return;
      enteredWrite = true;
      perfRecordTaskPhase(identity, 'cacheWriteQueue', performance.now() - queuedAt, this.perf);
      this.diagnostics.artifactWriteAttempts++;
      const writeAt = performance.now();
      let detail: Awaited<ReturnType<typeof writeDevArtifactDetailed>>;
      try { detail = await writeDevArtifactDetailed(store, key, value, this.session, prepared); }
      catch (error) { perfRecordTaskPhase(identity, 'cacheWrite', performance.now() - writeAt, this.perf, 'failed'); throw error; }
      perfRecordTaskPhase(identity, 'cacheWrite', performance.now() - writeAt, this.perf, detail.ok ? 'completed' : 'failed');
      if (!detail.ok) {
        if (store === 'catalog') this.diagnostics.catalogWriteFailures++;
        else if (lod != null) {
          this.diagnostics.lodWriteFailed[lod]++;
          this.recordCacheDecision(devPath ?? '', lod, 'write-failed', detail.error);
        }
        this.diagnostics.artifactWriteFailures++;
        this.diagnostics.errors.push(`缓存写入失败 ${store}:${key}: ${detail.error ?? 'unknown'}`);
        if (this.diagnostics.errors.length > 32) this.diagnostics.errors.shift();
      } else if (store === 'templates' && lod != null) {
        this.diagnostics.lodPersisted[lod]++;
      }
    }); } finally { releaseWrite(); } }).catch((error) => {
      if (!enteredWrite) perfRecordTaskPhase(identity, 'cacheWriteQueue', performance.now() - queuedAt, this.perf,
        (error as Error)?.name === 'AbortError' ? 'cancelled' : 'failed');
      if ((error as Error)?.name === 'AbortError') { this.diagnostics.cacheWriteCancelled++; return; }
      this.diagnostics.artifactWriteFailures++;
      this.diagnostics.errors.push(`缓存写入异常 ${store}:${key}: ${String(error)}`);
      if (this.diagnostics.errors.length > 32) this.diagnostics.errors.shift();
    }).finally(() => {
      this.pendingWrites.delete(queueKey); this.writeAdmissions.delete(queueKey); this.updateWriteDiagnostics(); this.requestReady();
    });
    this.pendingWrites.set(queueKey, task);
    this.writeAdmissions.set(queueKey, admitted); this.updateWriteDiagnostics();
    return admitted;
  }
  /** Optional preparation must not strand startup on an unavailable reader. */
  private async preparationWait<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_resolve,reject) => {
        timer=setTimeout(() => reject(new DOMException('DEV source preparation timed out', 'TimeoutError')), Math.max(1,timeoutMs));
      })]);
    } finally {if(timer)clearTimeout(timer);}
  }
  /** Share a bounded immutable source workset without holding computation slots.
   * Unknown/oversized sources and failed reads retain their authorized lazy path. */
  private async preloadSources(files: Map<string, File>): Promise<Map<string, File>> {
    try { if (localStorage.getItem('gim-dev-preload') === '0') return files; } catch { /* storage unavailable */ }
    const projectId = this.session.projectId;
    const pressured = (): boolean => this.memoryPressure === 'high' || this.memoryPressure === 'critical';
    if (projectId == null || !this.current() || pressured()) return files;
    // 剩余 IFC 仍在后台加载时最多等 8 秒再预取，避免大批次 IPC 长时间挤占
    // 剩余 IFC 的读取/转换；超时后让预取与 IFC 并行，靠批次让出主线程。
    if (this.state.ifcBackgroundPending) {
      const started = performance.now();
      const deadline = started + 8000;
      while (this.state.ifcBackgroundPending && this.current() && !pressured() && performance.now() < deadline) {
        await Promise.race([
          this.state.waitForIfcBackgroundLoading(),
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
      }
      perfMark('DEV 几何源预取等待 IFC', { waitedMs: Math.round(performance.now() - started) },
        this.perf);
      if (!this.current() || pressured()) return files;
    }
    const MAX_FILE_BYTES = 8 * 1024 * 1024;
    const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
    const MAX_BATCH_BYTES = 4 * 1024 * 1024;
    const BATCH_FILES = 4096;
    const rank = (path: string): number => {
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
      return ext === 'dev' ? 0 : ext === 'phm' ? 1 : ext === 'stl' ? 2 : ext === 'gl' ? 3 : 4;
    };
    const candidates = [...files.keys()]
      .filter((path) => /\.(dev|phm|mod|stl|gl)$/i.test(path))
      .sort((a, b) => rank(a) - rank(b));
    if (candidates.length === 0) return files;
    const output = new Map(files);
    const deadline = performance.now()+10_000;
    let loaded = 0;
    let next = 0, admitted = 0;
    while (next < candidates.length && admitted < MAX_TOTAL_BYTES) {
      if (!this.current() || pressured() || performance.now() >= deadline) break;
      const chunk: string[] = [];
      let batchBytes = 0;
      while (next < candidates.length && chunk.length < BATCH_FILES) {
        const path = candidates[next], size = files.get(path)!.size;
        if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_BYTES || admitted + size > MAX_TOTAL_BYTES) { next++; continue; }
        if (chunk.length && batchBytes + size > MAX_BATCH_BYTES) break;
        next++; admitted += size; batchBytes += size; chunk.push(path);
      }
      if (!chunk.length) continue;
      let result: Map<string, Uint8Array | null> | null = null;
      try {
        result = await this.preparationWait(batchReadCachedFiles(projectId, chunk), deadline-performance.now());
      } catch (error) {
        perfMark('DEV source preparation fallback', {phase:'source-batch',reason:String(error)}, this.perf);
        if ((error as Error)?.name === 'TimeoutError') break;
        result = null;
      }
      if (!this.current() || pressured()) break;
      if (!result) continue;
      for (const path of chunk) {
        const bytes = result.get(path);
        if (!bytes || bytes.byteLength === 0 || bytes.byteLength > files.get(path)!.size) continue;
        loaded += bytes.byteLength;
        if (loaded > MAX_TOTAL_BYTES) break;
        output.set(path, new File([bytes as Uint8Array<ArrayBuffer>], path.split('/').pop() || path));
      }
    }
    perfMark('DEV source workset ready', { entries: [...output].filter(([path, file]) => file !== files.get(path)).length, bytes: loaded, admittedBytes: admitted }, this.perf);
    return output;
  }

  private async prepareSources(files: Map<string, File>, catalogReads: DevArtifactRead<DevSourceBounds>[] = []): Promise<Map<string, File>> {
    // Reuse the normal catalog batch. Healthy warm startup issues no extra probe.
    const derivedMissing = catalogReads.length > 0 && catalogReads.every(read => read.status === 'miss');
    return this.state.currentFiles != null || derivedMissing ? this.preloadSources(files) : files;
  }

  private recoverMissingSources(key: string, lod: DeviceLod): void {
    if (lod !== 0 || this.sourceRecoveryAttempted || !this.sourceFiles || !this.current()) return;
    if (this.recoveryMisses.size < 32) this.recoveryMisses.add(key);
    if (this.recoveryMisses.size < Math.min(32, this.diagnostics.uniqueDevSources) || this.worker.diagnostics.rpcReads < 32) return;
    this.sourceRecoveryAttempted = true;
    // Sparse warm misses do not justify reading a large station. Only upgrade
    // an entire, small, known-size source workset after real RPC work is seen.
    const files = this.sourceFiles;
    let bytes = 0;
    for (const file of files.values()) {
      if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 8*1024*1024) return;
      bytes += file.size;
      if (bytes > 32*1024*1024) return;
    }
    void this.preloadSources(files).then(prepared => {
      if (!this.current()) return;
      this.worker.installSources(prepared);
      perfMark('DEV partial-cache source upgrade', {misses:this.recoveryMisses.size, indexedBytes:bytes}, this.perf);
    }).catch(error => { if (this.current()) console.warn('[DEV source upgrade]', error); });
  }

  async start(): Promise<void> {
    ensureGeometryLayers(this.state, (this.ctx.world.scene as any).three);
    if (!this.sourceIdentity && this.state.currentFiles) {
      // Without a verified source SHA, templates are session-local and persistence is disabled.
      this.sourceIdentity = `session:${this.session.generation}`;
    }
    let files = this.state.currentFiles;
    if (!files) {
      files = new Map();
      for (const path of this.state.substationEntryPaths) if (/\.(dev|phm|mod|stl|gl)$/i.test(path)) {
        const projectId = this.session.projectId;
        files.set(path, { name: path.split('/').pop()!, size: this.state.substationEntrySizes.get(path) ?? 0,
          arrayBuffer: async () => {
            if (projectId == null || !this.current()) throw Error('Device source unavailable');
            const bytes = await readCachedEntry(projectId, path);
            return new Uint8Array(bytes).buffer;
          } } as File);
      }
    }
    // Healthy warm catalogs do not preload sources. Missing derived catalogs
    // use the same bounded immutable File workset as freshly extracted sources.
    const seeds = collectCbmDeviceInstances(this.state.currentCbmTree);
    const preparingSources = this.state.currentFiles ? this.prepareSources(files) : null;
    this.sourceFiles = files;
    // Preparation is optional and overlaps worker initialization/base work.
    // Suppress a second recovery while this bounded preparation is in flight.
    this.sourceRecoveryAttempted = true;
    this.worker = createDevGeometryPreprocessor(
      this.state,
      this.session,
      files,
    );
    this.worker.setMemoryPressure?.(this.memoryPressure);
    this.diagnostics.workerCount = this.worker.workerCount;
    this.worker.onActivity = () => this.requestReady();
    (this.ctx.world.camera as any).controls?.addEventListener('update', this.cameraSchedule);
    const byDev = new Map<string, typeof seeds>();
    for (const seed of seeds) {
      const dev = normalize(seed.devPath), list = byDev.get(dev) ?? []; list.push(seed); byDev.set(dev, list);
      const row: Occurrence = { entry: { devPath: dev, sourceBounds: null, boundsQuality: 'unknown', primitiveCounts: {}, unsupportedTypes: [],
        instanceKey: `dev:${dev}#${seed.path}`, rootOccurrence: seed.path, placementMatrix: parseCbmTransformMatrix(seed.transformMatrix), templateStatus: 'unrequested' },
        inView: true, box: null, desired: 0, browseDesired: 0, displayed: 0 };
      this.rows.set(seed.path, row);
      this.updateReadiness(row);
    }
    this.diagnostics.occurrences = seeds.length;
    this.diagnostics.uniqueDevSources = byDev.size;
    this.notifyCoordinateAnchor(); this.update(); // Compilation can begin before any IFC is ready.
    if (preparingSources) {
      const prepared = await preparingSources;
      if (!this.current()) return;
      if (prepared !== files) this.worker.installSources(prepared);
    }
    this.sourceRecoveryAttempted = [...files.values()].every(file => file instanceof File);
    const catalogEntries = [...byDev];
    // Main transformers / GIS / arresters are the visual anchors of a station;
    // their catalog bounds must not be left behind hundreds of small rows.
    const importantDev = (instances: typeof seeds): number =>
      instances.some((seed) => /主变|变压器|HGIS|GIS|避雷器|出线|母线/.test(seed.name ?? '')) ? 0 : 1;
    catalogEntries.sort((a, b) =>
      importantDev(a[1]) - importantDev(b[1]) || b[1].length - a[1].length);
    const catalogWriteAdmissions = new Map<string, Promise<void>>();
    const resolveCatalog = async (dev: string): Promise<DevSourceBounds> => {
      const catalogRead = await this.catalogHint(dev);
      if (!this.current()) throw new DOMException('DEV directory left the current view', 'AbortError');
      let bounds = catalogRead.status === 'hit' ? catalogRead.value ?? null : null;
      const validBounds = bounds && bounds.devPath === dev && ['conservative', 'unknown', 'empty'].includes(bounds.boundsQuality)
        && (!bounds.sourceBounds || bounds.sourceBounds.length === 6 && bounds.sourceBounds.every(Number.isFinite)
          && bounds.sourceBounds.slice(0, 3).every((v, i) => v <= bounds!.sourceBounds![i + 3]));
      if (validBounds) {
        this.diagnostics.catalogHits++;
        this.diagnostics.cacheHits++;
      } else {
        if (catalogRead.status === 'invalid') {
          this.diagnostics.cacheInvalidCount++;
          this.diagnostics.errors.push(`目录缓存无效 ${dev}: ${catalogRead.error ?? ''}`);
          await deleteDevArtifact('catalog', this.catalogKey(dev), this.session);
        } else if (catalogRead.status === 'read-error') {
          this.diagnostics.cacheReadErrorCount++;
          this.diagnostics.errors.push(`目录缓存读取失败 ${dev}: ${catalogRead.error ?? ''}`);
        }
        if (this.diagnostics.errors.length > 32) this.diagnostics.errors.shift();
        try {bounds = await this.worker.bounds(dev);}
        catch(error){
          if(!this.current()) throw new DOMException('DEV directory left the current view', 'AbortError');
          bounds={devPath:dev,sourceBounds:null,boundsQuality:'unknown',primitiveCounts:{},unsupportedTypes:[],diagnostic:String(error)};
          this.diagnostics.errors.push(`目录 ${dev}: ${String(error)}`);if(this.diagnostics.errors.length>32)this.diagnostics.errors.shift();
        }
        if (!this.current()) throw new DOMException('DEV directory left the current view', 'AbortError');
        if (bounds && !bounds.diagnostic && this.session.sourceSha256) {
          catalogWriteAdmissions.set(dev, this.persistArtifact('catalog', this.catalogKey(dev), bounds, undefined, dev));
        }
      }
      return bounds ?? {devPath:dev,sourceBounds:null,boundsQuality:'unknown',primitiveCounts:{},unsupportedTypes:[],diagnostic:'missing-catalog-bounds'};
    };
    const applyCatalog = (dev: string, instances: typeof seeds, bounds: DevSourceBounds): void => {
      this.diagnostics.absoluteConeCount += bounds.absoluteConeCount ?? 0;
      const emptySource = !bounds.diagnostic && bounds.boundsQuality === 'empty';
      for (const seed of instances) {
        const matrix = parseCbmTransformMatrix(seed.transformMatrix);
        const entry: DevSpatialOccurrence = { ...bounds, instanceKey: `dev:${dev}#${seed.path}`, rootOccurrence: seed.path,
          placementMatrix: matrix, templateStatus: 'unrequested' };
        const box = bounds.sourceBounds ? boxTuple(bounds.sourceBounds).applyMatrix4(
          (this.anchor?.clone() ?? new THREE.Matrix4()).multiply(createLegacyEquivalentPlacementMatrix(matrix))) : null;
        const row = this.rows.get(seed.path)!;
        row.entry = { ...entry, templateStatus: emptySource ? 'empty' : row.entry.templateStatus }; row.box = box;
        this.viewIndex.set(seed.path, box);
        this.updateReadiness(row);
        if (emptySource) this.diagnostics.emptyOccurrences++;
        if (bounds.boundsQuality === 'unknown') {
          this.diagnostics.unknownBounds++; this.state.deviceUnknownBounds.add(seed.path);
        }
      }
      if (emptySource) {
        this.wanted.delete(this.key(dev, 0));
        this.worker?.cancelQueued(this.wanted);
      }
      this.diagnostics.directoryCompleted += instances.length;
      this.requestReady();
      if (instances.some(seed => seed.path === this.selected)) void this.select(this.selected).catch(error => console.warn('[DEV selected]', error));
    };
    const CATALOG_CONCURRENCY = Math.max(32, this.worker.workerCount * 8);
    // Warm start: one bounded native batch per 64 DEV instead of one IPC per
    // DEV. This removes the 285-round-trip catalog startup from the critical
    // path; cold start benefits from the same batched lookup (misses cheap).
    try {
      for (let start = 0; start < catalogEntries.length; start += 64) {
        if (!this.current()) return;
        const devs = catalogEntries.slice(start, start + 64).map(([dev]) => dev).filter(dev => !this.catalogHints.has(dev));
        if (!devs.length) continue;
        const reads = await readDevArtifactBatch<DevSourceBounds>('catalog', devs.map(dev => this.catalogKey(dev)), this.session, 4 * 1024 * 1024);
        if (!(reads instanceof Map)) throw new Error('catalog prefetch returned no map');
        if (start === 0 && !this.state.currentFiles && devs.every(dev => reads.get(this.catalogKey(dev))?.status === 'miss')) {
          this.sourceRecoveryAttempted = true;
          // Optional preparation overlaps remaining catalog reads and workers;
          // failed or late source reads never gate directory consumption.
          void this.prepareSources(files, devs.map(dev => reads.get(this.catalogKey(dev))!)).then(prepared => {
            if (this.current()) this.worker.installSources(prepared);
          }).catch(error => { if (this.current()) console.warn('[DEV source preparation]', error); });
        }
        devs.forEach(dev => {
          const key = this.catalogKey(dev);
          const read = reads.get(key);
          // Reuse terminal statuses too: resolveCatalog retains normal invalid
          // handling without issuing a second read for every confirmed miss.
          if (read && read.status !== 'deferred') this.catalogHints.set(dev, Promise.resolve(read));
        });
      }
    } catch (error) {
      // A failed prefetch falls back to per-DEV reads in resolveCatalog.
      console.warn('[DEV catalog prefetch]', error);
    }
    // Stream catalog bounds: a single slow DEV must not block the next batch.
    // This was the substation02 1395/3326 stall: Promise.all(batch of 8) waited
    // for one pathological bounds task while the other workers had no new rows.
    let nextCatalog = 0;
    const consumeCatalog = async (): Promise<void> => {
      while (this.current()) {
        const index = nextCatalog++;
        if (index >= catalogEntries.length) return;
        const [dev, instances] = catalogEntries[index];
        const bounds = await resolveCatalog(dev);
        if (!this.current()) return;
        applyCatalog(dev, instances, bounds);
        this.schedule();
        // Rows are available before backpressure. A fixed number of catalog
        // producers retain their small metadata until writer admission.
        await catalogWriteAdmissions.get(dev); catalogWriteAdmissions.delete(dev);
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(CATALOG_CONCURRENCY, catalogEntries.length) },
      () => consumeCatalog(),
    ));
    if (!this.current()) return;
    this.diagnostics.catalogReady = true; this.finishCatalog();
    const { refreshDeviceBoundsMarkers } = await import('../ui/deviceBoundsMarker.js');
    if (!this.current()) return;
    refreshDeviceBoundsMarkers(this.state);
    perfMark('DEV directory ready', { ...this.diagnostics, fingerprints: undefined }, this.perf);
    this.update();
  }
  belongsTo(session: ProjectLoadSession): boolean {
    return this.current() && this.session.generation === session.generation && this.session.sourceSha256 === session.sourceSha256 && this.session.projectId === session.projectId;
  }
  notifyCoordinateAnchor(): void {
    if (!this.current()) return;
    const matrix = this.state.projectSourceToViewerMatrix;
    if (!matrix || this.anchor?.equals(matrix)) return;
    this.anchor = matrix.clone(); this.diagnostics.anchorReady = true;
    this.finishAnchor();
    for (const row of this.rows.values()) {
      const placement = matrix.clone().multiply(createLegacyEquivalentPlacementMatrix(row.entry.placementMatrix));
      row.box = row.entry.sourceBounds ? boxTuple(row.entry.sourceBounds).applyMatrix4(placement) : null;
      this.viewIndex.set(row.entry.rootOccurrence, row.box);
      if (row.group) { row.group.matrix.copy(placement); row.group.updateMatrixWorld(true); }
    }
    this.instances?.sync();
    this.schedule();
  }
  private pinned(): Set<string> { return this.pinKeys; }
  private demoteFine(rootOccurrence: string): void {
    const row = this.rows.get(rootOccurrence);
    if (!row || row.desired !== 2) return;
    row.desired = row.browseDesired ?? Math.min(1, row.displayed) as DeviceLod;
    this.updateReadiness(row);
    const key = this.key(row.entry.devPath, 2);
    const shared = [...this.rows.values()].some(other => other !== row
      && other.desired === 2 && this.key(other.entry.devPath, 2) === key);
    if (!shared) { this.wanted.delete(key); this.worker?.cancelTask(key); }
  }
  private applyOnlySelected(): void {
    for (const [key, row] of this.rows) {
      if (row.group) row.group.visible = !this.onlySelected || (row.entry.rootOccurrence ?? key) === this.selected;
    }
    this.instances?.sync();
  }
  private acquireTemplateSlot(key: string): Promise<() => void> {
    return new Promise((resolve, reject) => { const waiter={queuedAt:performance.now(),resolve,reject}; this.templateWaiters.set(key,waiter); this.templateQueue.set(key,waiter,this.priorities.get(key) ?? 4,waiter.queuedAt); this.drainTemplates(); });
  }
  private drainTemplates(): void {
    while (this.current() && this.templateSlots < (this.worker.cacheConcurrency ?? Math.max(8, this.worker.workerCount * 8)) && this.templateWaiters.size) {
      const [key,waiter]=this.templateQueue.take()!;
      this.templateWaiters.delete(key); this.templateSlots++;
      let released = false;
      waiter.resolve(() => { if (released) return; released = true; this.templateSlots--; this.drainTemplates(); });
    }
  }
  private async template(dev: string, lod: DeviceLod, priority: number): Promise<TemplateRow | null> {
    if (this.sourceFailures.has(dev)) throw this.sourceFailures.get(dev)!;
    const key = this.key(dev, lod), cached = this.templates.get(key);
    if (cached) {
      const task = {...(cached.task ?? this.taskIdentity(dev, 'template', lod, priority)), cacheSource: 'memory' as const, priority};
      perfRecordTaskPhase(task, 'memoryTemplate', 0, this.perf);
      return {...cached, task};
    }
    if (this.nullResults.has(key)) return null;
    this.priorities.set(key, Math.min(this.priorities.get(key) ?? priority, priority));
    const waiter=this.templateWaiters.get(key); if (waiter) this.templateQueue.set(key,waiter,this.priorities.get(key)!,waiter.queuedAt);
    const old = this.pending.get(key); if (old) { this.worker.promote(key, priority); return old; }
    const identity = this.taskIdentity(dev, 'template', lod, priority), taskStarted = performance.now();
    const promise = (async () => {
      const releaseSlot = await perfMeasureTaskPhase(identity, 'templateQueue', () => this.acquireTemplateSlot(key), this.perf);
      let releaseInput: (()=>void) | undefined;
      try {
      // Concurrent requests share one bounded native batch reservation.
      const lease=await perfMeasureTaskPhase(identity, 'cacheRead', () => this.cacheReader.read(key), this.perf);releaseInput=lease.release;
      identity.priority = this.priorities.get(key) ?? priority;
      identity.cacheSource = lease.status === 'hit' ? 'disk' : 'compiled';
      if (!this.current()) return null;
      let artifact: CachedTemplate | undefined = lease.value;
      let parsed: Awaited<ReturnType<typeof parseDevGlbAsset>> = null;
      let generated = false;
      if (!this.current()) return null;
      const cacheStatus = lease.status;
      if (cacheStatus === 'read-error') {
        this.diagnostics.lodReadErrors[lod]++;
        this.diagnostics.cacheReadErrorCount++;
        this.recordCacheDecision(dev, lod, 'read-error', lease.error);
        this.diagnostics.errors.push(`模板读取失败 ${dev} LOD${lod}: ${lease.error ?? ''}`);
        if (this.diagnostics.errors.length > 32) this.diagnostics.errors.shift();
        artifact = undefined;
      } else if (cacheStatus === 'invalid') {
        this.diagnostics.lodInvalid[lod]++;
        this.diagnostics.cacheInvalidCount++;
        this.recordCacheDecision(dev, lod, 'invalid', lease.error);
        this.diagnostics.errors.push(`模板缓存无效 ${dev} LOD${lod}: ${lease.error ?? ''}`);
        if (this.diagnostics.errors.length > 32) this.diagnostics.errors.shift();
        artifact = undefined;
      } else if (cacheStatus === 'miss') {
        this.diagnostics.lodMisses[lod]++;
        this.diagnostics.cacheMisses++;
        this.recordCacheDecision(dev, lod, 'miss');
        this.recoverMissingSources(key, lod);
        artifact = undefined;
      } else artifact = lease.value;
      if (artifact?.sourceInvalid?.evidence) {
        const error = new InvalidDevGeometryError(dev, artifact.sourceInvalid.message, artifact.sourceInvalid.evidence, 'warm');
        this.sourceFailures.set(dev, error);
        this.diagnostics.lodHits[lod]++;
        this.diagnostics.templateHits++;
        this.diagnostics.cacheHits++;
        this.recordCacheDecision(dev, lod, 'hit', 'source-invalid');
        throw error;
      }
      if (artifact && (!artifact.result || !['complete', 'partial', 'empty', 'unsupported'].includes(artifact.result.status)
        || artifact.result.diagnostics?.status !== artifact.result.status)) {
        this.recordCacheDecision(dev, lod, 'invalid', 'artifact-shape');
        this.diagnostics.lodInvalid[lod]++;
        this.diagnostics.cacheInvalidCount++;
        await deleteDevArtifact('templates', key, this.session);
        artifact = undefined;
      }
      if (artifact?.result.bytes) {
        try {
          if (artifact.result.bytes.byteLength > this.inputBudget.limit) throw Error('DEV cached input exceeds quota');
          if (await perfMeasureTaskPhase(identity, 'cacheHash', () => hash(artifact!.result.bytes!), this.perf) !== artifact.sha) throw Error('DEV template SHA mismatch');
          parsed = await perfMeasureTaskPhase(identity, 'deserialize', () => parseDevGlbAsset(dev, artifact!.result.bytes!), this.perf);
          if (!parsed || !validateDevGlbTemplate(parsed).shareable || invalidGeometryExtent(parsed.scene)) throw Error('Invalid DEV cached template');
          this.diagnostics.lodHits[lod]++;
          this.diagnostics.templateHits++;
          this.diagnostics.cacheHits++;
          this.recordCacheDecision(dev, lod, 'hit');
        } catch (error) {
          if (parsed) new DevGlbTemplate(dev, parsed.scene, this.session).dispose();
          parsed = null;
          this.diagnostics.lodInvalid[lod]++;
          this.diagnostics.cacheInvalidCount++;
          this.recordCacheDecision(dev, lod, 'invalid', String(error));
          this.diagnostics.errors.push(`模板缓存校验失败 ${dev} LOD${lod}: ${String(error)}`);
          if (this.diagnostics.errors.length > 32) this.diagnostics.errors.shift();
          await deleteDevArtifact('templates', key, this.session);
          artifact = undefined;
        }
      } else if (artifact?.result.status === 'empty' || artifact?.result.status === 'unsupported') {
        this.diagnostics.lodHits[lod]++;
        this.diagnostics.templateHits++;
        this.diagnostics.cacheHits++;
        this.recordCacheDecision(dev, lod, 'hit', artifact.result.status);
        setGeometryDiagnostic(this.state, diagnosticFromSerialization(dev, artifact.result.diagnostics, 'warm'));
        this.nullResults.set(key, artifact.result.status);
        return null;
      } else if (artifact) artifact = undefined;
      if (!artifact) {
        const hint = await perfMeasureTaskPhase(identity, 'catalogCacheRead', () => this.catalogHint(dev), this.perf);
        if (hint.status === 'hit' && hint.value?.devPath === dev && hint.value.boundsQuality === 'empty' && !hint.value.diagnostic) {
          this.markEmptyDev(dev);
          this.diagnostics.emptyOccurrences++;
          this.nullResults.set(key, 'empty');
          this.recordCacheDecision(dev, lod, 'hit', 'catalog-empty');
          return null;
        }
        if (!this.wanted.has(key)) throw new DOMException('DEV request left the view', 'AbortError');
        generated = true;
        releaseInput(); releaseInput=undefined;
        identity.cacheSource = 'compiled';
        const result = await this.worker.compile(dev, lod, key, this.priorities.get(key) ?? priority, identity.taskId).catch(async error => {
          if (error instanceof InvalidDevGeometryError && error.sourceEvidence && this.current()) {
            this.sourceFailures.set(dev, error);
            if (this.session.sourceSha256) await this.persistArtifact('templates', key,
              { sourceInvalid: { message: error.reason, evidence: error.sourceEvidence } }, lod, dev, identity);
          }
          throw error;
        });
        if (!this.current()) return null;
        releaseInput = await perfMeasureTaskPhase(identity, 'inputBudgetQueue', () => this.inputBudget.acquire(result.bytes?.byteLength ?? 0), this.perf);
        if (!this.current()) return null;
        this.diagnostics.compiled[lod]++;
        this.diagnostics.lodCompiled[lod]++;
        this.recordCacheDecision(dev, lod, 'compiled', cacheStatus);
        artifact = { result, sha: result.bytes ? result.sha256 ?? await hash(result.bytes) : '' };
      }
      if (!this.current()) return null;
      setGeometryDiagnostic(this.state, diagnosticFromSerialization(dev, artifact.result.diagnostics, generated ? 'cold' : 'warm'));
      if (!artifact.result.bytes) {
        if (artifact.result.status === 'empty' || artifact.result.status === 'unsupported') {
          this.nullResults.set(key, artifact.result.status);
          if (this.session.sourceSha256) {
            const inputOwner = releaseInput; releaseInput = undefined;
            await this.persistArtifact('templates', key, artifact, lod, dev, identity, inputOwner);
          }
        }
        return null;
      }
      parsed ??= await perfMeasureTaskPhase(identity, 'deserialize', () => parseDevGlbAsset(dev, artifact!.result.bytes!), this.perf);
      if (!parsed || !validateDevGlbTemplate(parsed).shareable || invalidGeometryExtent(parsed.scene)) {
        if (parsed) new DevGlbTemplate(dev, parsed.scene, this.session).dispose();
        throw Error(`DEV GLB invalid: ${dev}`);
      }
      // Show geometry first; persistence is bounded and asynchronous. A failed
      // write is recorded by persistArtifact and never advertised as warm.
      if (generated && this.session.sourceSha256) {
        const inputOwner = releaseInput; releaseInput = undefined;
        void this.persistArtifact('templates', key, artifact, lod, dev, identity, inputOwner);
      }
      const templateStarted = performance.now();
      const row = { bounds: new THREE.Box3().setFromObject(parsed.scene), template: new DevGlbTemplate(dev, parsed.scene, this.session), sha: artifact.sha, status: artifact.result.status, diagnostics: artifact.result.diagnostics, task: identity };
      this.diagnostics.templateParses++;
      if (!this.current()) { row.template.dispose(); return null; }
      const pinned = this.pinned(); pinned.add(key); // caller commits or releases before next trim
      const buffers = new Set<ArrayBufferLike>();
      parsed.scene.traverse(object => {
        const geometry = (object as THREE.Mesh).geometry;
        if (!geometry) return;
        for (const attribute of [...Object.values(geometry.attributes), geometry.index].filter(Boolean)) {
          const data = attribute as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
          buffers.add(('data' in data ? data.data.array : data.array).buffer);
        }
      });
      const bytes = [...buffers].reduce((total, buffer) => total + buffer.byteLength, 0);
      this.templates.set(key, row, bytes, pinned); this.diagnostics.templateResidentBytes = this.templates.bytes;
      perfRecordTaskPhase(identity, 'templateBuild', performance.now() - templateStarted, this.perf, 'completed', bytes);
      return row;
      } finally { releaseInput?.(); releaseSlot(); }
    })();
    this.pending.set(key, promise); this.diagnostics.pending = this.pending.size;
    let outcome: 'completed' | 'failed' | 'cancelled' = 'completed';
    try { return await promise; }
    catch (error) { outcome = (error as Error)?.name === 'AbortError' ? 'cancelled' : 'failed'; throw error; }
    finally {
      perfRecordTaskPhase(identity, 'templateWall', performance.now() - taskStarted, this.perf, outcome);
      if (this.pending.get(key) === promise) { this.pending.delete(key); this.priorities.delete(key); } this.diagnostics.pending = this.pending.size; this.worker.acknowledge(key);
    }
  }
  private schedule = () => {
    if (!this.current()) return;
    this.diagnostics.currentViewReady = false;
    this.diagnostics.currentViewSettled = false;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.update(); }, 200);
  };
  private update(): void {
    if (!this.current()) { this.release(); return; }
    this.refreshMemoryPressure();
    this.notifyCoordinateAnchor();
    const camera = (this.ctx.world.camera as any).three as THREE.Camera;
    const canvas = (this.ctx.world.renderer as any)?.three?.domElement as HTMLCanvasElement | undefined;
    const rect = canvas?.getBoundingClientRect();
    const view = createDeviceViewContext(camera, rect?.width || 1000, rect?.height || 800);
    const candidates = this.viewIndex.query(view.frustum);
    this.diagnostics.viewIndex = {...this.viewIndex.diagnostics};
    const wanted = new Set<string>();
    this.wanted = wanted;
    for (const row of this.rows.values()) {
      const selected = row.entry.rootOccurrence === this.selected;
      const terminal = row.entry.templateStatus === 'empty' || row.entry.templateStatus === 'unsupported';
      const metrics = this.anchor && row.box && candidates.has(row.entry.rootOccurrence)
        ? deviceViewMetrics(row.box, camera, rect?.width || 1000, rect?.height || 800, view) : null;
      // Unknown bounds are not evidence of visibility. They still receive an
      // automatic LOD0 in the background; only catalogued boxes decide whether
      // the current view is blocked on this occurrence.
      row.inView = selected || (row.box && metrics ? metrics.visible : false);
      if (terminal) { row.desired = 0; this.updateReadiness(row); continue; }
      // Unknown ranges compile actual supported geometry automatically. No
      // invented box, false culling or tree-selection prerequisite is used.
      // Selection only raises scheduling priority.  L2 is an explicit user
      // action (refine()); camera proximity and an ordinary click must stay in
      // the inexpensive browser representation.  This is the key boundary
      // between browsing and the fine-model workflow.
      const browseLod: DeviceLod = !row.group ? 0 : this.diagnostics.autoLodSuppressed
        ? row.inView ? Math.min(1, row.displayed) as DeviceLod : 0
        : metrics ? chooseDeviceLod(row.displayed, metrics.visible, metrics.pixels) : 0;
      row.browseDesired = browseLod;
      const lod = this.fineRequested.has(row.entry.rootOccurrence) ? 2 : browseLod;
      row.desired = lod;
      this.updateReadiness(row);
      const key = this.key(row.entry.devPath, lod); wanted.add(key);
      // Visible L0 outranks offscreen L0; offscreen still remains wanted and
      // is reached later (aged priority prevents permanent starvation).
      const priority = selected ? 0 : lod === 0 ? (row.inView ? 1 : 3) : 2;
      if (row.key !== key && row.failedKey !== key) void this.render(row, lod, priority).catch(e => this.failed(row, e, key));
    }
    this.worker?.cancelQueued(wanted); this.templates.trim(this.pinned());
    for (const [key, waiter] of this.templateWaiters) if (!wanted.has(key)) {
      this.templateWaiters.delete(key); this.templateQueue.delete(key); waiter.reject(new DOMException('DEV request left the current view', 'AbortError'));
    }
    this.diagnostics.templateResidentBytes = this.templates.bytes;
    this.requestReady();
  }
  private rendering = new WeakMap<Occurrence, Map<string, Promise<void>>>();
  private render(row: Occurrence, lod: DeviceLod, priority: number): Promise<void> {
    let tasks = this.rendering.get(row);
    if (!tasks) { tasks = new Map(); this.rendering.set(row, tasks); }
    const key = this.key(row.entry.devPath, lod);
    const existing = tasks.get(key); if (existing) return existing;
    const task = this.renderOnce(row, lod, priority).finally(() => tasks!.delete(key));
    tasks.set(key, task); return task;
  }
  private async renderOnce(row: Occurrence, lod: DeviceLod, priority: number): Promise<void> {
    const key = this.key(row.entry.devPath, lod);
    this.placementUsers.set(key, (this.placementUsers.get(key) ?? 0) + 1);
    this.pinKeys.add(key);
    try {
    const template = await this.template(row.entry.devPath, lod, priority);
    if (!this.current() || row.desired !== lod || row.key === key) return;
    if (!template) {
      if (row.entry.templateStatus === 'empty') { this.nullResults.set(key, 'empty'); this.requestReady(); return; }
      row.entry.templateStatus = this.nullResults.get(key) ?? 'failed';
      this.updateReadiness(row);
      this.requestReady(); return;
    }
    if (!this.anchor) await perfMeasureTaskPhase(template.task ?? this.taskIdentity(row.entry.devPath, 'placement', lod, priority), 'anchorQueue', () => this.anchorDone, this.perf);
    if (!this.current() || row.desired !== lod || row.key === key) return;
    const trace = {...(template.task ?? this.taskIdentity(row.entry.devPath, 'placement', lod, priority)), priority, instanceKey: row.entry.instanceKey};
    const commitQueuedAt = performance.now();
    await perfMeasureTaskPhase(trace, 'sceneSubmitWall', () => this.submit(priority, () => {
    if (!this.current() || row.desired !== lod || row.key === key) return;
    const started = performance.now();
    perfRecordTaskPhase(trace, 'sceneCommitQueue', started - commitQueuedAt, this.perf);
    const group = template.template.createPlacement({ contract: 'source-template', rootOccurrence: row.entry.rootOccurrence,
      instanceKey: row.entry.instanceKey, placementMatrix: row.entry.placementMatrix, projectSourceToViewerMatrix: this.anchor });
    const worldBounds = template.bounds.clone().applyMatrix4(group.matrix);
    const invalidPlacement = ![...worldBounds.min.toArray(), ...worldBounds.max.toArray()].every(Number.isFinite) ? 'non-finite-placement' : Math.max(...worldBounds.getSize(new THREE.Vector3()).toArray()) > GEOMETRY_MAX_EXTENT_M ? 'oversized-placement' : null;
    if (invalidPlacement) { group.clear(); throw Error(`DEV placement rejected: ${row.entry.rootOccurrence}: ${invalidPlacement}`); }
    group.userData.deviceLod = lod;
    group.name = row.entry.instanceKey;
    const highlighted = this.state.highlightedModState?.groups.filter(object => belongsTo(object, row.group)) ?? [];
    const highlightScopes = highlighted.map(object => object === row.group ? null : { devPath: object.userData.devPath, assemblyPath: object.userData.assemblyPath, referencePath: object.userData.referencePath });
    if (highlighted.length) resetModHighlight(this.state);
    if (row.group) this.instances?.remove(row.group);
    this.state.modRootGroup!.add(group); row.group?.removeFromParent();
    if (row.key) { const count = (this.displayedPins.get(row.key) ?? 1) - 1; if (count) this.displayedPins.set(row.key, count); else { this.displayedPins.delete(row.key); if (!this.placementUsers.has(row.key)) this.pinKeys.delete(row.key); } }
    this.displayedPins.set(key, (this.displayedPins.get(key) ?? 0) + 1);
    row.group = group; row.key = key; row.displayed = lod; row.entry.templateStatus = 'ready';
    group.visible = !this.onlySelected || row.entry.rootOccurrence === this.selected;
    if (this.batchEnabled) {
      this.instances ??= new DevInstanceBatches(this.state.modRootGroup!);
      this.instances.add(group, lod < 2);
    }
    row.geometryStatus = template.status; row.failedKey = undefined;
    this.updateReadiness(row);
    this.state.loadedXmlModGroups.set(row.entry.instanceKey, group);
    if (highlighted.length) {
      const replacements: THREE.Object3D[] = [];
      group.traverse(object => {
        if (replacements.some(parent => belongsTo(object, parent))) return;
        if (highlightScopes.some(scope => scope ? Object.entries(scope).every(([field,value]) => object.userData[field] === value) : object === group)) replacements.push(object);
      });
      highlightModGroups(this.state, replacements);
    }
    if (this.diagnostics.fingerprints.length < 64 || row.entry.rootOccurrence === this.selected) {
      const local = template.bounds, world = worldBounds;
      const fingerprint = { sourceSha: this.session.sourceSha256, devPath: row.entry.devPath, instanceKey: row.entry.instanceKey, lod,
        templateSha: template.sha, localBounds: tupleBox(local), placementMatrix: row.entry.placementMatrix,
        firstIfc: this.state.currentIfcEntries[0]?.path, projectMatrix: this.state.projectSourceToViewerMatrix?.toArray(),
        worldBounds: tupleBox(world), center: world.getCenter(new THREE.Vector3()).toArray() };
      this.diagnostics.fingerprints.push(fingerprint);
      if (this.diagnostics.fingerprints.length > 128) this.diagnostics.fingerprints.shift();
      perfMark('DEV placement fingerprint', fingerprint, this.perf);
    }
    this.diagnostics.shown = this.state.loadedXmlModGroups.size;
    this.diagnostics.sceneCommitCount++;
    this.diagnostics.sceneCommitMaxMs = Math.max(this.diagnostics.sceneCommitMaxMs, performance.now() - started);
    perfRecordTaskPhase(trace, 'placementCommit', performance.now() - started, this.perf);
    this.requestReady();
    this.schedule(); // Reconsider detail only after a base representation exists.
    }, row.entry.rootOccurrence), this.perf);
    } finally {
      const users = (this.placementUsers.get(key) ?? 1) - 1;
      if (users) this.placementUsers.set(key, users); else this.placementUsers.delete(key);
      if (!this.placementUsers.has(key) && !this.displayedPins.has(key)) this.pinKeys.delete(key);
      this.templates.trim(this.pinned());
    }
  }
  private failed(row: Occurrence, error: unknown, requestKey: string): void {
    if (!this.current()) return;
    if (row.entry.templateStatus === 'empty') return;
    if (row.desired === null || this.key(row.entry.devPath, row.desired) !== requestKey) return;
    // A queued request may be cancelled while an earlier evaluation is still
    // unwinding. If the same key is wanted again, it needs another drive.
    if((error as Error)?.name==='AbortError'){this.schedule();return;}
    row.entry.templateStatus = 'failed';
    row.failedKey = requestKey;
    this.updateReadiness(row);
    this.diagnostics.errors.push(`${row.entry.devPath}: ${String(error)}`);
    if (this.diagnostics.errors.length > 32) this.diagnostics.errors.shift();
    setGeometryDiagnostic(this.state, diagnosticForFailure(row.entry.devPath,
      error instanceof InvalidDevGeometryError && error.sourceEvidence ? 'source-invalid' : 'parse-failed',
      error instanceof InvalidDevGeometryError ? error.source : 'cold', String(error)));
    this.requestReady();
  }
  private ready(): void {
    if (this.instances) this.diagnostics.instancing = {enabled: this.batchEnabled, ...this.instances.statistics};
    if (!this.current()) return;
    // The normal path is O(1): every row transition updates its contribution.
    // Vitest fixtures and diagnostic callers may replace/mutate the private
    // map directly; resync there so readiness remains a trustworthy contract.
    if (!this.readinessRowsMatch() || import.meta.env?.MODE === 'test') this.syncReadinessCounters();
    const counters = this.readinessCounters;
    const {
      total, visible, finished, shown, empty, unsupported, partial, failed,
      viewPending,
    } = counters;
    const viewSettled = counters.viewSettled === total;
    const viewReady = counters.viewReady === total;
    const baseSettled = counters.baseSettled === total;
    const baseReady = counters.baseReady === total;
    const allReady = counters.allReady === total;
    const samples: string[] = [];
    if (viewPending > 0) {
      for (const row of this.rows.values()) {
        if (!row.inView) continue;
        const contribution = contributionForRow(row, (dev, lod) => this.key(dev, lod));
        if (!contribution.viewPending) continue;
        samples.push(`${row.entry.devPath}: LOD${row.displayed}→${row.desired}`);
        if (samples.length >= 8) break;
      }
    }
    this.auditReadinessCounters();
    const stable = !this.cameraTimer && !this.timer && this.diagnostics.anchorReady;
    const blockers=[!this.diagnostics.anchorReady?'等待坐标锚点':'',!this.diagnostics.catalogReady?'设备范围索引准备中':'',this.cameraTimer?'等待相机停稳':'',
      this.pending.size?`模板处理中 ${this.pending.size}`:'',this.templateWaiters.size?`模板排队 ${this.templateWaiters.size}`:'',this.commits.length?`场景待提交 ${this.commits.length}`:''].filter(Boolean);
    const ready = stable && viewReady && failed === 0 && (visible > 0 || this.diagnostics.catalogReady);
    if (ready && !this.diagnostics.currentViewReady) {
      perfMark('DEV current view ready', { shown, requested: visible, compiled: [...this.diagnostics.compiled], hits: [...this.diagnostics.lodHits], failed }, this.perf);
      perfMarkProductMoment('devCurrentViewReady', {
        path: 'device-lod', shown, requested: visible, compiled: [...this.diagnostics.compiled],
        lodHits: [...this.diagnostics.lodHits], failed, catalogReady: this.diagnostics.catalogReady,
      }, this.perf);
    }
    const nextViewSettled = stable && this.diagnostics.catalogReady && viewSettled;
    if (nextViewSettled && !this.diagnostics.currentViewSettled) {
      perfMarkProductMoment('devCurrentViewSettled', {
        path: 'device-lod', shown, requested: visible, failed, catalogReady: this.diagnostics.catalogReady,
      }, this.perf);
    }
    const nextBaseSettled = this.diagnostics.anchorReady && this.diagnostics.catalogReady && baseSettled;
    const nextAllReady = this.diagnostics.anchorReady && this.diagnostics.catalogReady && baseReady && allReady;
    if (nextBaseSettled && !this.diagnostics.baseRepresentationsSettled) {
      perfMarkProductMoment('devBaseRepresentationsSettled', {
        path: 'device-lod', occurrences: total, shown, empty, unsupported, failed,
        compiled: [...this.diagnostics.compiled], lodHits: [...this.diagnostics.lodHits],
        templateParses: this.diagnostics.templateParses,
      }, this.perf);
      if (failed === 0) perfMarkProductMoment('devGeometryReady', { path: 'device-lod', occurrences: total, shown, empty, unsupported, failed }, this.perf);
    }
    if (nextAllReady && !this.diagnostics.allStationReady) {
      perfMarkProductMoment('devAllStationReady', { path: 'device-lod', occurrences: total, shown, partial, failed }, this.perf);
      perfMark('DEV all station ready', { total, shown, partial, failed }, this.perf);
    }
    Object.assign(this.diagnostics, { currentViewSettled: nextViewSettled, currentViewReady: ready,
      baseRepresentationsSettled: nextBaseSettled,
      baseRepresentationsReady: this.diagnostics.anchorReady && this.diagnostics.catalogReady && baseReady,
      allStationReady: nextAllReady,
      readyOccurrences: shown, emptyOccurrences: empty, unsupportedOccurrences: unsupported, partialOccurrences: partial, failedOccurrences: failed,
      shown: this.state.loadedXmlModGroups.size, workerCount: this.worker?.workerCount ?? 0, activeDevices: this.worker?.activePaths ?? [],viewPendingOccurrences:viewPending,
      readinessBlockers:blockers,viewPendingSamples:samples,
      cacheReadBatches:this.cacheReader.diagnostics.batches,cacheReadEntries:this.cacheReader.diagnostics.entries,cacheReadDeferred:this.cacheReader.diagnostics.deferred });
    const browseState = !this.diagnostics.catalogReady || !this.diagnostics.currentViewSettled
      ? 'loading'
      : failed > 0 ? 'partial'
        : nextBaseSettled ? 'base-settled' : 'browseable';
    this.diagnostics.browseState = browseState;
    const active = this.diagnostics.activeDevices.join('、');
    this.diagnostics.inputBudgetBytes=this.inputBudget.bytes;this.diagnostics.inputBudgetPeakBytes=this.inputBudget.peakBytes;
    this.updateWriteDiagnostics();
    const ws=this.worker?.diagnostics;
    if (ws) {
      this.diagnostics.workerReads=ws.reads;this.diagnostics.workerRpcReads=ws.rpcReads;
      this.diagnostics.workerSourceHits=ws.sourceHits;this.diagnostics.workerDocumentHits=ws.documentHits;
      this.diagnostics.workerReadRpcMs=Math.round(ws.readRpcMs);this.diagnostics.workerParseMs=Math.round(ws.parseMs);
      this.diagnostics.workerQueueWaitMs=Math.round(ws.queueWaitMs);
      this.diagnostics.workerSourceAffinityHits=ws.sourceAffinityHits;
      this.diagnostics.workerSourceAffinityDeferrals=ws.sourceAffinityDeferrals;
      this.diagnostics.workerScheduling=this.worker.schedulingSnapshot();
      this.diagnostics.workerStages={...ws.stages};
      this.diagnostics.workerTimedOutTasks=ws.timedOutTasks;
      this.diagnostics.workerStallSnapshots=ws.stallSnapshots;
    }
    const pressure=this.worker?.resultPressure;
    this.diagnostics.resultQueuedBytes=pressure?.bytes ?? 0;this.diagnostics.resultPeakBytes=pressure?.peakBytes ?? 0;
    this.diagnostics.resultQueueCount=pressure?.count ?? 0;
    const phase = !this.diagnostics.catalogReady
      ? `设备范围索引准备中 ${this.diagnostics.directoryCompleted}/${total}`
      : this.diagnostics.currentViewSettled
        ? ready ? (nextBaseSettled ? '当前视图已完成 · 工程可浏览 · 基础表示已完成' : '当前视图已完成 · 工程可浏览') : '当前视图已完成，部分实例失败 · 工程可浏览'
        : `当前视图准备中${viewPending ? ` ${viewPending}` : ''}`;
    const background = this.diagnostics.currentViewSettled && !this.diagnostics.baseRepresentationsSettled ? ' · 后台补充基础表示' : '';
    const cold = this.diagnostics.compiled, warm = this.diagnostics.lodHits;
    const failedCount = this.diagnostics.failedOccurrences;
    const cacheProblems = this.diagnostics.lodReadErrors.reduce((a,b)=>a+b,0)
      + this.diagnostics.lodInvalid.reduce((a,b)=>a+b,0)
      + this.diagnostics.artifactWriteFailures;
    this.status(
      `几何实例已处理 ${finished}/${total} · 已显示 ${this.diagnostics.readyOccurrences} · 冷编译 L0 ${cold[0]}/L1 ${cold[1]}/L2 ${cold[2]} · 缓存命中 L0 ${warm[0]}/L1 ${warm[1]}/L2 ${warm[2]}${failedCount ? ` · 失败 ${failedCount}` : ''} · ${phase}${background}`,
      `LOD缓存 miss ${this.diagnostics.cacheMisses} · read-error ${this.diagnostics.cacheReadErrorCount} · invalid ${this.diagnostics.cacheInvalidCount} · 写入失败 ${this.diagnostics.artifactWriteFailures}`
        + ` · 目录 ${this.diagnostics.directoryCompleted}/${total}${this.diagnostics.catalogReady?'（就绪）':'（进行中）'}`
        + ` · 批读 ${this.diagnostics.cacheReadBatches} 批/${this.diagnostics.cacheReadEntries} 条（defer ${this.diagnostics.cacheReadDeferred}）`
        + ` · 淘汰 ${this.diagnostics.templateEvictions} · 部分表示 ${this.diagnostics.partialOccurrences}`
        + `${cacheProblems ? ` · 缓存问题 ${cacheProblems}` : ''}`
        + `${blockers.length?` · ${blockers.join(' · ')}`:''}${active ? ` · ${active}` : ''}`
        + `${this.diagnostics.memoryPressure !== 'unknown' ? ` · JS内存 ${this.diagnostics.memoryPressure}` : ''}`
        + `${this.diagnostics.backgroundPaused ? ' · 已暂停后台细化' : ''}`);
    this.diagnostics.cacheReadBatches=this.cacheReader.diagnostics.batches;
    this.diagnostics.cacheReadEntries=this.cacheReader.diagnostics.entries;
    this.diagnostics.cacheReadDeferred=this.cacheReader.diagnostics.deferred;
    // No work owns a still-wanted row: recover a cancelled scheduling turn.
    if(stable&&viewPending&&!this.pending.size&&!this.templateWaiters.size&&!this.commits.length)this.schedule();
  }
  clearSelection(): void {
    const previous = this.selected;
    this.selected = '';
    // Fine geometry is tied to the active selection.  Leaving the selection
    // releases its protection; the normal LOD scheduler may then replace it
    // with L0/L1 and the template cache can reclaim the fine representation.
    if (previous) { this.fineRequested.delete(previous); this.demoteFine(previous); }
    this.schedule();
  }
  /** Pause only automatic L1 refinement/prefetch. L0 and catalog/bounds work
   * remain eligible, and an explicit refine() request can still be promoted. */
  setBackgroundPaused(paused: boolean): void {
    this.diagnostics.backgroundPaused = paused;
    this.worker?.setPaused(paused);
    this.requestReady();
  }
  setOnlySelected(only: boolean): void {
    this.onlySelected = only;
    this.applyOnlySelected();
  }
  resourceCounts() {
    const geometry = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
    for (const row of this.templates.values()) {
      for (const value of row.template.geometryRefs) geometry.add(value);
      for (const value of row.template.materialRefs) materials.add(value);
      for (const value of row.template.textureRefs) textures.add(value);
    }
    return { templateCount: this.templates.size, templateParseCount: this.diagnostics.templateParses,
      sharedGeometryCount: geometry.size, sharedMaterialCount: materials.size, sharedTextureCount: textures.size };
  }
  pick(ray: THREE.Raycaster): ReturnType<DevInstanceBatches['pick']> {
    return this.instances?.pick(ray) ?? null;
  }
  /** Read the current placement directly; never retain a second root index. */
  getLoadedRoot(rootOccurrence: string): THREE.Group | undefined {
    return this.current() ? this.rows.get(rootOccurrence)?.group : undefined;
  }
  /** Ensure an occurrence has a browser representation.  This method is used
   * by ordinary tree/search/selection flows and deliberately never requests
   * L2.  Keep the historical select name as a compatibility alias below. */
  async ensureBase(rootOccurrence: string): Promise<THREE.Group[]> {
    if (!this.current()) return [];
    const previous = this.selected;
    if (previous && previous !== rootOccurrence) {
      this.fineRequested.delete(previous);
      this.demoteFine(previous);
    }
    this.selected = rootOccurrence;
    this.fineRequested.delete(rootOccurrence);
    this.applyOnlySelected();
    for (const commit of this.commits) if (commit.root === rootOccurrence) commit.priority = 0;
    this.commits.sort((a,b) => a.priority-b.priority);
    if (!this.rows.has(rootOccurrence)) await this.catalogDone;
    const row = this.rows.get(rootOccurrence);
    if (!row || !this.current() || this.selected !== rootOccurrence) return [];
    const target: DeviceLod = row.group ? Math.min(1, row.displayed) as DeviceLod : 0;
    row.desired = target;
    this.updateReadiness(row);
    this.wanted.add(this.key(row.entry.devPath, target));
    row.failedKey = undefined; // Explicit selection retries transient failures; source-invalid stays isolated.
    this.updateReadiness(row);
    try { await this.render(row, target, 0); }
    catch (error) { this.failed(row, error, this.key(row.entry.devPath, target)); throw error; }
    if (!this.anchor) {
      await this.anchorDone;
      if (!this.current() || this.selected !== rootOccurrence) return [];
      await this.render(row, target, 0);
    }
    return this.current() && row.group ? [row.group] : [];
  }
  /** Retry only the selected DEV's failed browser task.  Source-invalid and
   * deterministic empty/unsupported results remain isolated; they require a
   * source correction rather than an automatic retry loop. */
  async retry(rootOccurrence: string): Promise<THREE.Group[]> {
    if (!this.current()) return [];
    const row = this.rows.get(rootOccurrence);
    if (!row) return [];
    if (this.sourceFailures.has(row.entry.devPath)) throw this.sourceFailures.get(row.entry.devPath)!;
    if (row.entry.templateStatus === 'empty' || row.entry.templateStatus === 'unsupported') {
      throw new Error('该设备没有可重试的浏览几何来源');
    }
    this.selected = rootOccurrence;
    row.entry.templateStatus = 'unrequested';
    row.failedKey = undefined;
    row.geometryStatus = undefined;
    this.updateReadiness(row);
    for (const lod of [0, 1, 2] as const) this.nullResults.delete(this.key(row.entry.devPath, lod));
    this.applyOnlySelected();
    if (!row.group) await this.ensureBase(rootOccurrence);
    if (!this.current() || this.selected !== rootOccurrence) return [];
    const target = row.browseDesired ?? (row.group ? Math.min(1, row.displayed) : 0) as DeviceLod;
    row.desired = target;
    this.updateReadiness(row);
    this.wanted.add(this.key(row.entry.devPath, target));
    await this.render(row, target, 0);
    this.schedule();
    return this.current() && row.group ? [row.group] : [];
  }
  /** Explicit user request for precise DEV geometry. */
  async refine(rootOccurrence: string): Promise<THREE.Group[]> {
    if (!this.current()) return [];
    this.refreshMemoryPressure();
    if (this.memoryPressure === 'critical') throw new Error('当前内存压力过高，暂不能加载精细模型');
    const previous = this.selected;
    if (previous && previous !== rootOccurrence) {
      this.fineRequested.delete(previous);
      this.demoteFine(previous);
    }
    this.selected = rootOccurrence;
    this.applyOnlySelected();
    for (const commit of this.commits) if (commit.root === rootOccurrence) commit.priority = 0;
    this.commits.sort((a,b) => a.priority-b.priority);
    if (!this.rows.has(rootOccurrence)) await this.catalogDone;
    const row = this.rows.get(rootOccurrence);
    if (!row || !this.current() || this.selected !== rootOccurrence) return [];
    // A direct inspector request can arrive before the automatic browser
    // representation has committed.  Admit L0 first so an exact request
    // never makes the current view blank while it waits for L2.
    if (!row.group && row.entry.templateStatus !== 'empty' && row.entry.templateStatus !== 'unsupported') {
      await this.ensureBase(rootOccurrence);
      if (!this.current() || this.selected !== rootOccurrence) return [];
    }
    this.fineRequested.add(rootOccurrence);
    row.desired = 2;
    this.wanted.add(this.key(row.entry.devPath, 2));
    row.failedKey = undefined;
    this.updateReadiness(row);
    try { await this.render(row, 2, 0); }
    catch (error) {
      // A precise request is an optional browser action.  Preserve a usable
      // L0/L1 group and its successful diagnostic when L2 fails; otherwise a
      // failed refinement would incorrectly turn an already browseable station
      // into a base-view failure.
      const hadBase = !!row.group && row.displayed <= 1;
      if (hadBase) {
        this.diagnostics.fineFailures.push(`${row.entry.devPath}: ${String(error)}`);
        if (this.diagnostics.fineFailures.length > 32) this.diagnostics.fineFailures.shift();
        row.failedKey = undefined;
        row.entry.templateStatus = 'ready';
        this.updateReadiness(row);
        this.requestReady();
      } else {
        this.failed(row, error, this.key(row.entry.devPath, 2));
      }
      this.fineRequested.delete(rootOccurrence);
      this.demoteFine(rootOccurrence);
      throw error;
    }
    if (!this.current() || this.selected !== rootOccurrence) return [];
    if (!this.anchor) {
      await this.anchorDone;
      if (!this.current() || this.selected !== rootOccurrence) return [];
      await this.render(row, 2, 0);
    }
    if (!this.current() || this.selected !== rootOccurrence || !row.group
      || row.key !== this.key(row.entry.devPath, 2)) return [];
    perfMarkProductMoment('selectedFineReady', {
      kind: 'dev', rootOccurrence, devPath: row.entry.devPath, lod: 2,
    }, this.perf);
    return this.current() && row.group ? [row.group] : [];
  }
  /** Release an explicitly refined occurrence back to normal browsing LOD. */
  releaseFine(rootOccurrence: string): void {
    this.fineRequested.delete(rootOccurrence);
    if (this.selected === rootOccurrence) {
      this.demoteFine(rootOccurrence);
    }
    this.schedule();
  }
  /** Backward-compatible name.  Ordinary selection is base-only now. */
  async select(rootOccurrence: string): Promise<THREE.Group[]> { return this.ensureBase(rootOccurrence); }
  release(): void {
    this.sourceFiles = undefined; this.recoveryMisses.clear();
    if (this.released) return; this.released = true; this.inputBudget.close();this.writeBudget.close();this.cacheReader.close(); this.finishCatalog(); this.finishAnchor();
    for (const waiter of this.writeWaiters) waiter.reject(new DOMException('DEV cache write cancelled', 'AbortError'));
    this.writeWaiters = [];
    for (const waiter of this.templateWaiters.values()) waiter.reject(new DOMException('DEV session expired', 'AbortError'));
    this.templateWaiters.clear(); this.templateQueue.clear();
    if (this.timer) clearTimeout(this.timer);
    if (this.cameraTimer) clearTimeout(this.cameraTimer);
    if (this.statusTimer) clearTimeout(this.statusTimer);
    if (this.commitTimer) clearTimeout(this.commitTimer);
    for (const commit of this.commits) commit.reject(new DOMException('DEV session expired', 'AbortError'));
    this.commits = [];
    (this.ctx.world.camera as any).controls?.removeEventListener('update', this.cameraSchedule);
    window.removeEventListener('gim-toggle-background-detail', this.pauseEvent);
    this.worker?.cancel();
    for (const row of this.rows.values()) { if (row.group && this.state.highlightedModState?.groups.some(object => belongsTo(object, row.group))) resetModHighlight(this.state); row.group?.removeFromParent(); this.state.loadedXmlModGroups.delete(row.entry.instanceKey); }
    this.instances?.release(); this.instances = undefined;
    this.fineRequested.clear(); this.templates.clear();
    for (const rootOccurrence of this.readinessRows.keys()) this.removeReadiness(rootOccurrence);
    this.rows.clear(); this.readinessRows.clear();
    this.viewIndex.clear();
    Object.assign(this.readinessCounters, emptyReadinessCounters());
    this.catalogHints.clear(); this.state.deviceUnknownBounds.clear();
  }
}
export async function startDeviceLod(state: AppState, ctx: ViewerContext, session: ProjectLoadSession, status: (text: string, detail?: string) => void): Promise<DevLodRuntime> {
  if (!state.substationResourceMonitor) startSubstationResourceMonitor(state, ctx);
  if (state.deviceLodRuntime instanceof DevLodRuntime && state.deviceLodRuntime.belongsTo(session)) {
    state.deviceLodRuntime.setOnlySelected(state.onlySelected);
    state.deviceLodRuntime.notifyCoordinateAnchor(); await state.deviceLodRuntime.startup; return state.deviceLodRuntime;
  }
  state.deviceLodRuntime?.release();
  const runtime = new DevLodRuntime(state, ctx, session, status); state.deviceLodRuntime = runtime;
  runtime.setExternalMemoryPressure(state.substationMemoryPressure);
  runtime.setOnlySelected(state.onlySelected);
  try { runtime.startup = runtime.start(); await runtime.startup; return runtime; }
  catch (error) { runtime.release(); if (state.deviceLodRuntime === runtime) state.deviceLodRuntime = null; throw error; }
}
