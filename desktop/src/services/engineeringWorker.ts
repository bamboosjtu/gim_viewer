import { extractEngineeringSourceGraph, type EngineeringSourceGraph } from '../gim/engineering/sourceGraph.js';
import { buildEngineeringSources, normalizeEngineeringSources } from '../gim/engineering/buildSources.js';
import { decodeEngineeringEntities, decodeEngineeringSources, encodeEngineeringEntities, encodeEngineeringSources } from './engineeringCacheCodec.js';
import type { EngineeringBuildResult, EngineeringWorkerCommand, EngineeringWorkerReply, EngineeringWorkerRequest, EngineeringWorkerResponse } from './engineeringWorkerProtocol.js';
import { projectEngineeringNavigation } from '../gim/engineering/navigation.js';
import { decodeEngineeringNavigation, encodeEngineeringNavigation } from './engineeringNavigationCache.js';
import { collectSourceGeometryOccurrences } from '../gim/engineering/geometryOccurrences.js';
import { encodeEngineeringWorkerResult, engineeringWorkerResultTransfers } from './engineeringWorkerTransport.js';

/** Distinguish a bounded cache rejection from a broken snapshot. The model is
 * still complete and usable; only persistence is explicitly disabled. */
export function markCacheFailure(result: EngineeringBuildResult, error: unknown): void {
  const text = String(error);
  result.cacheError = text;
  if (/plain size|expanded length/i.test(text)) result.cacheDisabled = '工程实体缓存超过 384 MiB，已禁用大站实体缓存';
}

/** Also used without a Worker in pure integration tests. No database or Viewer. */
export function createEngineeringWorkerHandler() {
  let scope = '';
  let paths: string[] = [];
  let graph: EngineeringSourceGraph | null = null;
  const files = new Map<string, Blob | Uint8Array>();
  return async (request: EngineeringWorkerCommand): Promise<EngineeringWorkerReply> => {
    if (request.type === 'init') {
      scope = request.scope; paths = request.paths; files.clear(); graph = null;
      return { type: 'ready' };
    }
    if (request.type === 'files') {
      for (const source of request.files) {
        if (!source.blob && !source.bytes) throw Error(`Engineering source bytes missing: ${source.path}`);
        files.set(source.path, source.blob ?? source.bytes!);
      }
      return { type: 'ready' };
    }
    if (request.type === 'extract') {
      graph = await extractEngineeringSourceGraph({ paths, readText: async path => {
        const source = files.get(path);
        if (!source) throw Error(`Engineering source unavailable: ${path}`);
        const bytes = source instanceof Uint8Array ? source : await source.arrayBuffer();
        try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { return new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
      } });
      files.clear();
      return { type: 'graph', summary: { ifcPaths: graph.ifcPaths, sourceRecords: graph.records.length }, geometryOccurrences: collectSourceGeometryOccurrences(graph) };
    }
    if (request.type === 'restore') {
      const artifact = await decodeEngineeringSources(request.sourceBytes, request.identity);
      graph = artifact.sources.graph; scope = request.identity.sourceSha256;
      let snapshot;
      let entityCacheHit = false;
      try {
        if (!request.entityBytes) throw Error('entity-cache-missing');
        snapshot = await decodeEngineeringEntities(request.entityBytes, artifact, request.identity);
        entityCacheHit = true;
      } catch { snapshot = normalizeEngineeringSources(scope, artifact.sources); }
      let navigation, navigationCacheHit = false;
      try {
        if (!request.navigationBytes) throw Error('navigation-cache-missing');
        navigation = await decodeEngineeringNavigation(request.navigationBytes, artifact.sources, snapshot, artifact.digest, request.identity);
        navigationCacheHit = true;
      } catch { navigation = projectEngineeringNavigation(artifact.sources, snapshot); }
      const result: EngineeringBuildResult = { sources: artifact.sources, snapshot, navigation, geometryOccurrences: collectSourceGeometryOccurrences(graph), entityCacheHit, navigationCacheHit };
      if (!entityCacheHit) {
        try { result.entityBytes = await encodeEngineeringEntities(snapshot, artifact, request.identity); }
        catch (error) { markCacheFailure(result, error); }
      }
      if (!navigationCacheHit) {
        try { result.navigationBytes = await encodeEngineeringNavigation(navigation, artifact.sources, snapshot, artifact.digest, request.identity); }
        catch (error) { markCacheFailure(result, error); }
      }
      return { type: 'model', result: encodeEngineeringWorkerResult(result) };
    }
    if (!graph || !scope) throw Error('Engineering source graph is not ready');
    const built = buildEngineeringSources(scope, graph, request.objects, request.models, request.nodes);
    const result: EngineeringBuildResult = { ...built, navigation: projectEngineeringNavigation(built.sources, built.snapshot), geometryOccurrences: collectSourceGeometryOccurrences(graph) };
    if (request.identity && result.sources.complete) {
      try {
        const encoded = await encodeEngineeringSources(result.sources, request.identity);
        result.sourceBytes = encoded.bytes;
        result.entityBytes = await encodeEngineeringEntities(result.snapshot, { sources: result.sources, digest: encoded.digest }, request.identity);
        result.navigationBytes = await encodeEngineeringNavigation(result.navigation, result.sources, result.snapshot, encoded.digest, request.identity);
      } catch (error) { markCacheFailure(result, error); }
    }
    return { type: 'model', result: encodeEngineeringWorkerResult(result) };
  };
}

// Importing the pure handler in tests must not register a Window message hook.
if (typeof document === 'undefined' && typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  const handle = createEngineeringWorkerHandler();
  const send = self.postMessage.bind(self) as (response: EngineeringWorkerResponse, transfer?: Transferable[]) => void;
  let chain = Promise.resolve();
  self.onmessage = (event: MessageEvent<EngineeringWorkerRequest>) => {
    chain = chain.then(async () => {
      const request = event.data;
      try {
        const result = await handle(request);
        const response = { ...result, requestId: request.requestId } as EngineeringWorkerResponse;
        const transfer: Transferable[] = [];
        if (response.type === 'model') {
          transfer.push(...engineeringWorkerResultTransfers(response.result));
        }
        send(response, transfer);
      } catch (error) { send({ type: 'error', requestId: request.requestId, message: String(error) }); }
    });
  };
}

