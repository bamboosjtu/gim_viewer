import { releaseOwnedBytes } from '../../shared/ownedBytes.js';
import { GimError } from '@gim/contracts-native/errors.js';
import type { EngineeringBuildResult } from './engineeringWorkerProtocol.js';
import {
  engineeringNavigationFromWire,
  engineeringNavigationToWire,
} from '../cache/engineeringNavigationCache.js';
import {
  streamEngineeringSource,
  unpackEngineeringSourcePages,
  type PackedEngineeringSource,
} from '../cache/engineeringSourceCodec.js';
import type { EngineeringSourceGraph } from '../../gim/engineering/sourceGraph.js';
import { yieldEngineeringCodec } from '../cache/engineeringTableJson.js';
export interface TransportGraphCache {
  scope?: string;
  revision?: number;
  graph?: EngineeringSourceGraph;
}

export interface EngineeringWorkerPayload {
  graphFrame?: { scope: string; revision: number; reference: boolean };
  encoding: 'engineering-worker-table-pages-v1';
  /** Header followed by independently decodable row pages. */
  body: Uint8Array[];
  metrics?: EngineeringBuildResult['metrics'];
}
const MAX_ENGINEERING_TRANSPORT_BYTES = 1024 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Runtime transport is independent from persisted cache versions. Repeated
 * immutable source facts and long identities occur once in the table. Only
 * owned byte buffers cross the Worker boundary; raw graph clones do not. */
export function encodeEngineeringWorkerResult(
  result: EngineeringBuildResult,
  cache?: TransportGraphCache,
): EngineeringWorkerPayload {
  const started = performance.now(),
    { navigation, ...data } = result;
  const graph = result.sources.graph,
    revision = graph.revision ?? 0,
    scope = result.snapshot.scope;
  const reference =
    !!cache && cache.scope === scope && cache.graph === graph && cache.revision === revision;
  const sources = reference ? { ...data.sources, graph: undefined } : data.sources;
  const body: Uint8Array[] = [];
  let transportBytes = 0;
  const encode = (json: string): Uint8Array => {
    const page = encoder.encode(json);
    transportBytes += page.byteLength;
    if (transportBytes > MAX_ENGINEERING_TRANSPORT_BYTES)
      throw new GimError('RESOURCE_LIMIT', '工程来源传输超过容量上限');
    return page;
  };
  const rows: PackedEngineeringSource['nodes'] = [];
  let estimatedPageBytes = 0;
  const flush = () => {
    if (!rows.length) return;
    body.push(encode(JSON.stringify(rows)));
    rows.length = 0;
    estimatedPageBytes = 0;
  };
  const header = streamEngineeringSource(
    { ...data, sources, navigation: engineeringNavigationToWire(navigation) },
    (row) => {
      // Estimate only to split pages. The total limit uses the emitted UTF-8
      // bytes; even a large individual text row retains its original content.
      const width = typeof row[1] === 'string' ? row[1].length * 6 + 8 : row.length * 12;
      if (rows.length >= 4096 || estimatedPageBytes + width > 1024 * 1024) flush();
      rows.push(row);
      estimatedPageBytes += width;
    },
  );
  flush();
  body.unshift(encode(JSON.stringify(header)));
  if (cache) {
    cache.scope = scope;
    cache.revision = revision;
    cache.graph = graph;
  }
  return {
    encoding: 'engineering-worker-table-pages-v1',
    body,
    ...(cache ? { graphFrame: { scope, revision, reference } } : {}),
    metrics: {
      buildMs: result.metrics?.buildMs ?? 0,
      transportEncodeMs: performance.now() - started,
      transportBytes,
    },
  };
}

export function engineeringWorkerResultTransfers(payload: EngineeringWorkerPayload): ArrayBuffer[] {
  return payload.body.map((page) => page.buffer as ArrayBuffer);
}

export async function decodeEngineeringWorkerResult(
  payload: EngineeringWorkerPayload,
  isCurrent: () => boolean,
  cache?: TransportGraphCache,
  consume = false,
): Promise<EngineeringBuildResult> {
  const started = performance.now();
  if (!isCurrent()) throw new DOMException('Engineering hydration cancelled', 'AbortError');
  if (
    payload.encoding !== 'engineering-worker-table-pages-v1' ||
    !Array.isArray(payload.body) ||
    payload.body.length < 2
  )
    throw Error('工程来源传输无效');
  let transportBytes = 0;
  const readPage = (page: Uint8Array): unknown => {
    if (!(page instanceof Uint8Array) || !page.byteLength) throw Error('工程来源传输无效');
    transportBytes += page.byteLength;
    if (transportBytes > MAX_ENGINEERING_TRANSPORT_BYTES)
      throw new GimError('RESOURCE_LIMIT', '工程来源传输超过容量上限');
    const json: unknown = JSON.parse(decoder.decode(page));
    if (consume) releaseOwnedBytes(page);
    return json;
  };
  function* pages() {
    for (let index = 1; index < payload.body.length; index++) yield readPage(payload.body[index]);
  }
  let decoded: unknown;
  try {
    const header = readPage(payload.body[0]) as { shapes?: unknown; root?: unknown } | null;
    decoded = await unpackEngineeringSourcePages(
      header?.shapes,
      header?.root,
      pages(),
      isCurrent,
      yieldEngineeringCodec,
      consume,
    );
  } finally {
    if (consume) {
      for (const page of payload.body) if (page instanceof Uint8Array) releaseOwnedBytes(page);
      payload.body.length = 0;
    }
  }
  const data = decoded as Omit<EngineeringBuildResult, 'navigation'> & { navigation: unknown };
  if (payload.graphFrame) {
    const frame = payload.graphFrame;
    if (
      !Number.isSafeInteger(frame.revision) ||
      frame.revision < 0 ||
      typeof frame.reference !== 'boolean' ||
      frame.scope !== data.snapshot.scope
    )
      throw Error('Engineering graph frame scope mismatch');
    if (frame.reference) {
      if (!cache?.graph || cache.scope !== frame.scope || cache.revision !== frame.revision)
        throw Error('Engineering graph reference unavailable');
      data.sources = { ...data.sources, graph: cache.graph };
    } else {
      if ((data.sources.graph?.revision ?? 0) !== frame.revision)
        throw Error('Engineering graph revision mismatch');
      if (cache) {
        cache.scope = frame.scope;
        cache.revision = frame.revision;
        cache.graph = data.sources.graph;
      }
    }
  }
  if (
    data.snapshot.evidenceBinding?.scope !== data.snapshot.scope ||
    data.snapshot.evidenceBinding.sourceRevision !== (data.sources.graph.revision ?? 0)
  )
    throw Error('Engineering evidence revision mismatch');
  const navigation = engineeringNavigationFromWire(
    data.navigation,
    data.sources,
    data.snapshot,
    true,
  );
  if (!isCurrent()) throw new DOMException('Engineering hydration cancelled', 'AbortError');
  return {
    ...data,
    navigation,
    metrics: payload.metrics
      ? { ...payload.metrics, hydrateMs: performance.now() - started }
      : undefined,
  };
}
