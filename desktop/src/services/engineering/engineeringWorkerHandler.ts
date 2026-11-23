import {
  encodeWorkerBuildCache,
  readWorkerBuildCache,
  type EngineeringWorkerBuild,
  type EngineeringSourceCheckpoint,
} from './engineeringWorkerCache.js';
import { createEngineeringWorkerSources } from './engineeringWorkerSources.js';
import { NOOP_TASK, type WorkerTaskProbe } from '../../measurement/workerProbe.js';
import {
  extractEngineeringSourceGraph,
  materializeEngineeringFamilies,
  type EngineeringSourceGraph,
} from '../../gim/engineering/source.js';
import { ModelEvidenceProvider } from '../../gim/engineering/evidenceProvider.js';
import { assembleEngineeringView, assembleStoredEngineeringView } from './engineeringAssembly.js';
import type { EngineeringSources } from '../../gim/engineering/buildSources.js';
import {
  decodeEngineeringSources,
  type EngineeringCacheDomain,
  type EngineeringCacheIdentity,
} from '../../infrastructure/cache/engineeringCacheCodec.js';
import {
  type EngineeringBuildResult,
  type EngineeringSourceInput,
  type EngineeringWorkerCommand,
  type EngineeringWorkerReply,
} from '../../infrastructure/workers/engineeringWorkerProtocol.js';
import { extractPhysicalOccurrences } from '../../gim/engineering/geometry.js';
import {
  encodeEngineeringWorkerResultAsync,
  type TransportGraphCache,
} from '../../infrastructure/workers/engineeringWorkerTransport.js';
import type { EvidenceStatus, EvidenceInventory } from '../../engineering/evidence.js';
import type { SourceGeometryOccurrenceCatalog } from '../../gim/engineering/geometryOccurrences.js';
import { encodeSourceGeometryCache } from '../../infrastructure/cache/sourceGeometryCache.js';

/** Display and persistence have separate requests. Only the latest immutable
 * build is retained; one cache buffer is encoded and transferred at a time. */
export function createEngineeringWorkerHandler(
  loadSources?: (paths: string[]) => Promise<EngineeringSourceInput>,
) {
  let scope = '',
    paths: string[] = [],
    graph: EngineeringSourceGraph | null = null,
    sequence = 0;
  let physicalCache: SourceGeometryOccurrenceCatalog | undefined;
  let latest: EngineeringWorkerBuild | undefined;
  const inputs = createEngineeringWorkerSources(loadSources);
  const { readFamily, readRaw } = inputs;
  let evidence: ModelEvidenceProvider | undefined;
  let lastSources: EngineeringSources | undefined;
  let graphReferences = false,
    wireGraph: TransportGraphCache = {};
  let parked: EngineeringSourceCheckpoint | undefined;
  let parkedCoverage: Array<{ path: string; status: EvidenceStatus }> = [];
  let parkedEntries = new Set<string>();
  let indexedGraph: EngineeringSourceGraph | undefined,
    indexedRevision = -1;
  let parkTimer: ReturnType<typeof setTimeout> | undefined,
    activeEvidence = 0;
  function provider(): ModelEvidenceProvider {
    if (!evidence) {
      evidence = new ModelEvidenceProvider(scope, paths, (path) => readFamily(path), readRaw);
      evidence.seedCoverage(parkedCoverage);
    }
    return evidence;
  }
  function sourceCoverage(
    source: EngineeringSourceGraph,
  ): Array<{ path: string; status: EvidenceStatus }> {
    return [
      ...source.documents.map((d) => ({
        path: d.path,
        status: d.attributeStatus ?? ('partial' as const),
      })),
      ...source.diagnostics
        .filter((d) => d.kind === 'read-failed')
        .map((d) => ({ path: d.source, status: 'failed' as const })),
    ];
  }
  function metadata(entryIds?: readonly string[]): EvidenceInventory {
    const p = provider();
    // Metadata needs coverage, not candidate-vector/occurrence indexes.
    if (lastSources) p.seedCoverage(sourceCoverage(lastSources.graph));
    else if (graph) p.seedCoverage(sourceCoverage(graph));
    const snapshot = p.getSnapshot(entryIds);
    return {
      ...snapshot,
      coverage: snapshot.coverage.map((row) => ({
        ...row,
        restorable: !!parked && parkedEntries.has(row.entryId),
      })),
    };
  }
  function compact(): void {
    if (
      !parked ||
      !lastSources ||
      latest ||
      activeEvidence ||
      parked.revision !== (lastSources.graph.revision ?? 0)
    )
      return;
    parkedCoverage = sourceCoverage(lastSources.graph);
    for (const model of lastSources.models)
      parkedCoverage.push({ path: model.path, status: 'partial' });
    parkedEntries = new Set(parkedCoverage.map((row) => row.path));
    evidence?.seedCoverage(parkedCoverage);
    evidence?.detachRaw();
    graph = null;
    lastSources = undefined;
    wireGraph = {};
    indexedGraph = undefined;
    indexedRevision = -1;
  }
  async function resume(): Promise<ModelEvidenceProvider> {
    if (!lastSources && parked) {
      const artifact = await decodeEngineeringSources(parked.bytes, parked.identity);
      lastSources = artifact.sources;
      graph = lastSources.graph;
    }
    const p = provider(),
      current = lastSources?.graph ?? graph;
    if (current && (indexedGraph !== current || indexedRevision !== (current.revision ?? 0))) {
      p.attachGraph(current, lastSources?.ifcRecords);
      indexedGraph = current;
      indexedRevision = current.revision ?? 0;
    }
    return p;
  }
  async function detail<T>(work: () => Promise<T> | T): Promise<T> {
    if (parkTimer) clearTimeout(parkTimer);
    activeEvidence++;
    try {
      return await work();
    } finally {
      activeEvidence--;
      if (parked && !latest && !activeEvidence) parkTimer = setTimeout(compact, 1500);
    }
  }
  async function publish(
    result: EngineeringBuildResult,
    started: number,
    identity?: EngineeringCacheIdentity,
    digest?: string,
    plan: EngineeringCacheDomain[] = [],
  ): Promise<EngineeringWorkerReply> {
    result.evidenceRevision = evidence?.getRevision();
    result.buildId = ++sequence;
    result.cachePlan = plan;
    result.metrics = {
      buildMs: performance.now() - started,
      transportEncodeMs: 0,
      transportBytes: 0,
    };
    latest = { result, identity, digest, plan: [...plan] };
    return {
      type: 'model',
      result: await encodeEngineeringWorkerResultAsync(
        result,
        graphReferences ? wireGraph : undefined,
      ),
    };
  }
  type SourceGraphProgress = (
    stage: 'source-index' | 'source-traverse' | 'source-sort',
    completed: number,
  ) => void;

  async function extractSourceGraph(
    trace: WorkerTaskProbe,
    reportProgress: SourceGraphProgress,
  ): Promise<EngineeringWorkerReply> {
    graph = null;
    latest = undefined;
    lastSources = undefined;
    evidence?.resetObservations();
    wireGraph = {};
    parked = undefined;
    parkedCoverage = [];
    parkedEntries.clear();
    indexedGraph = undefined;
    indexedRevision = -1;
    inputs.useTrace(trace);
    let lastProgress = 0,
      lastStage = '',
      completed = 0;
    const progress = (stage: 'source-index' | 'source-traverse' | 'source-sort') => {
      const now = performance.now();
      completed++;
      if (stage !== lastStage || now - lastProgress >= 1000) {
        lastProgress = now;
        lastStage = stage;
        reportProgress(stage, completed);
      }
    };
    try {
      graph = await trace.measure('engineering.extract', () => {
        const entryIndex = inputs.resolveIndex(paths);
        return extractEngineeringSourceGraph(
          {
            paths,
            entryIndex,
            readText: (path) => readFamily(path, trace),
            readDocument: async (path) => {
              const doc = await inputs.documents.read(path);
              progress('source-traverse');
              return doc;
            },
            prefetchDocuments: inputs.prefetchGraph,
          },
          { deferFamilies: true, onProgress: progress },
        );
      });
    } finally {
      inputs.retainFamilies(new Set(graph?.familyAssignments?.map((a) => a.path) ?? []));
    }
    return {
      type: 'graph',
      summary: {
        ifcPaths: graph.ifcPaths,
        sourceRecords: graph.records.length,
        familyPaths: [...new Set(graph.familyAssignments?.map((a) => a.path) ?? [])],
      },
    };
  }

  async function restoreCachedBuild(
    request: Extract<EngineeringWorkerCommand, { type: 'restore' }>,
    started: number,
  ): Promise<EngineeringWorkerReply> {
    latest = undefined;
    inputs.resetForCacheRestore();
    const { result, digest, plan } = await readWorkerBuildCache(request, (sources, checkpoint) => {
      graph = sources.graph;
      scope = request.identity.sourceSha256;
      lastSources = sources;
      parked = checkpoint;
    });
    return publish(result, started, request.identity, digest, plan);
  }

  async function assembleFromSources(
    request: Extract<EngineeringWorkerCommand, { type: 'assemble' }>,
    trace: WorkerTaskProbe,
    started: number,
  ): Promise<EngineeringWorkerReply> {
    if (!graph || !scope) throw Error('Engineering source graph is not ready');
    latest = undefined;
    await trace.measure('engineering.families', () =>
      materializeEngineeringFamilies(
        graph!,
        (path) => readFamily(path, trace),
        (path) => evidence?.familyDocument(path),
      ),
    );
    inputs.discardCarriers();
    const built = trace.sync('engineering.normalize', () =>
      assembleEngineeringView(scope, graph!, request.objects, request.models, request.nodes),
    );
    lastSources = built.sources;
    return publish(
      built,
      started,
      request.identity,
      undefined,
      request.identity && built.sources.complete
        ? built.stageErrors.recognition
          ? ['sources']
          : Object.keys(built.stageErrors).length
            ? ['sources', 'entities']
            : ['sources', 'entities', 'navigation']
        : [],
    );
  }

  return async (
    request: EngineeringWorkerCommand,
    trace: WorkerTaskProbe = NOOP_TASK,
    reportProgress: SourceGraphProgress = () => {},
  ): Promise<EngineeringWorkerReply> => {
    const started = performance.now();
    if (request.type === 'checkpoint-evidence') {
      if (
        !parked ||
        latest ||
        activeEvidence ||
        (lastSources && parked.revision !== (lastSources.graph.revision ?? 0))
      )
        return { type: 'evidence-checkpoint' };
      compact();
      const p = provider();
      p.detachRaw();
      return {
        type: 'evidence-checkpoint',
        checkpoint: {
          bytes: parked.bytes,
          identity: parked.identity,
          sourceRevision: parked.revision,
          buildSequence: sequence,
          snapshot: metadata(),
        },
      };
    }
    if (request.type === 'restore-evidence-checkpoint') {
      const checkpoint = request.checkpoint;
      if (
        checkpoint.identity.sourceSha256 !== scope ||
        checkpoint.snapshot.scope !== scope ||
        !Number.isSafeInteger(checkpoint.sourceRevision) ||
        checkpoint.sourceRevision < 0 ||
        !Number.isSafeInteger(checkpoint.buildSequence) ||
        checkpoint.buildSequence < 0 ||
        !checkpoint.bytes.byteLength
      )
        throw Error('Invalid evidence checkpoint identity');
      sequence = Math.max(sequence, checkpoint.buildSequence);
      parked = {
        bytes: checkpoint.bytes,
        identity: checkpoint.identity,
        revision: checkpoint.sourceRevision,
      };
      graph = null;
      lastSources = undefined;
      latest = undefined;
      wireGraph = {};
      indexedGraph = undefined;
      indexedRevision = -1;
      parkedCoverage = checkpoint.snapshot.entries.map((e) => ({ path: e.path, status: e.status }));
      parkedEntries = new Set(
        checkpoint.snapshot.coverage.filter((c) => c.restorable).map((c) => c.entryId),
      );
      provider().restoreMetadata(checkpoint.snapshot);
      return { type: 'ready' };
    }
    if (request.type === 'release-model') {
      if (request.buildId === undefined || latest?.result.buildId === request.buildId) {
        latest = undefined;
        compact();
      }
      return { type: 'ready' };
    }
    if (request.type === 'init') {
      scope = request.scope;
      paths = request.paths;
      physicalCache = undefined;
      inputs.resetForInit();
      graph = null;
      latest = undefined;
      lastSources = undefined;
      graphReferences = request.graphReferences === true;
      wireGraph = {};
      if (parkTimer) clearTimeout(parkTimer);
      parked = undefined;
      parkedCoverage = [];
      parkedEntries.clear();
      evidence = undefined;
      indexedGraph = undefined;
      indexedRevision = -1;
      return { type: 'ready' };
    }
    if (request.type === 'source-files') throw Error('Source replies must bypass the task queue');
    if (request.type === 'evidence-snapshot')
      return { type: 'evidence', snapshot: metadata(request.entryIds) };
    if (request.type === 'evidence-query')
      return detail(() => ({
        type: 'evidence' as const,
        page: provider().queryEvidence(request.query),
      }));
    if (request.type === 'evidence-ensure')
      return detail(async () => {
        const p = await resume();
        return { type: 'evidence' as const, snapshot: await p.ensureEvidence(request.range) };
      });
    if (request.type === 'evidence-read')
      return detail(async () => ({
        type: 'evidence' as const,
        bytes: await provider().readEntry(request.path),
      }));
    if (request.type === 'recognize-evidence')
      return detail(async () => {
        await resume();
        if (!lastSources || !evidence) throw Error('Engineering sources not ready');
        await materializeEngineeringFamilies(
          lastSources.graph,
          (path) => evidence!.readText(path),
          (path) => evidence!.familyDocument(path),
        );
        const reasons = lastSources.incompleteReasons.filter(
          (r) => r !== 'source-graph-incomplete',
        );
        if (lastSources.graph.diagnostics.length) reasons.push('source-graph-incomplete');
        lastSources = {
          ...lastSources,
          complete: reasons.length === 0,
          incompleteReasons: reasons,
        };
        const result = assembleStoredEngineeringView(scope, lastSources);
        evidence.attachGraph(lastSources.graph, lastSources.ifcRecords);
        indexedGraph = lastSources.graph;
        indexedRevision = indexedGraph.revision ?? 0;
        return publish(
          result,
          started,
          request.identity,
          undefined,
          request.identity && lastSources.complete
            ? result.stageErrors.recognition
              ? ['sources']
              : Object.keys(result.stageErrors).length
                ? ['sources', 'entities']
                : ['sources', 'entities', 'navigation']
            : [],
        );
      });
    if (request.type === 'packed-files') {
      inputs.addBatch(request.batch);
      return { type: 'ready' };
    }
    if (request.type === 'files') {
      inputs.addFiles(request);
      return { type: 'ready' };
    }
    if (request.type === 'extract-geometry') {
      inputs.useTrace(trace);
      const catalog = await trace.measure('engineering.physical-index', () => {
        const entryIndex = inputs.resolveIndex(paths);
        return extractPhysicalOccurrences(
          {
            entryIndex,
            readDocument: (path) => inputs.documents.read(path),
            prefetchDocuments: inputs.prefetchPhysical,
          },
          { onProgress: (count) => reportProgress('source-traverse', count) },
        );
      });
      physicalCache =
        request.retainForCache &&
        !catalog.diagnostics.some((d) => d.reason === 'source-read-failed')
          ? catalog
          : undefined;
      return { type: 'geometry', catalog };
    }
    if (request.type === 'encode-geometry-cache') {
      const catalog = physicalCache;
      physicalCache = undefined;
      return {
        type: 'geometry-cache',
        bytes: catalog
          ? await trace.measure('engineering.physical-cache-encode', () =>
              encodeSourceGeometryCache(scope, catalog),
            )
          : undefined,
      };
    }
    if (request.type === 'extract') return extractSourceGraph(trace, reportProgress);
    if (request.type === 'encode-cache')
      return encodeWorkerBuildCache(latest, request, trace, started, (checkpoint) => {
        parked = checkpoint;
      });
    if (request.type === 'restore') return restoreCachedBuild(request, started);
    return assembleFromSources(request, trace, started);
  };
}
