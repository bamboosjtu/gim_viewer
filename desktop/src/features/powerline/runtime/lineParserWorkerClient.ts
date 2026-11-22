import measuredWorkerAsset from './lineParserWorker.ts?worker&url';
import { createMeasuredWorker, measurementWorkerUrl } from '../../../measurement/hostWorker.js';
import { WorkerRequests } from '../../../infrastructure/workers/workerRequests.js';
import { decodeGimText } from '../../../shared/textDecode.js';
import { StaleSessionError, type SessionScope } from '../../../shared/sessionScope.js';
import { logger } from '../../../utils/logger.js';
import {
  createLineParserCache,
  parseLineAttributesFromCache,
  type LineAttributePayloadsCore,
} from '@gim/powerline-core/lineAttrParserCore.js';
import { buildLineGimGraphFromTexts } from '../../../gim/lineCbmParserCore.js';
import type {
  LineParserWorkerFile,
  LineParserWorkerRequest,
  LineParserWorkerResponse,
  LineParserWorkerSuccess,
} from './lineParserWorker.js';

export interface LineParserWorkerResult {
  graph: LineParserWorkerSuccess['graph'];
  attributes: LineAttributePayloadsCore;
  timings: LineParserWorkerSuccess['timings'] & { worker: boolean };
}

type Parse = (files: LineParserWorkerFile[]) => Promise<LineParserWorkerResult>;
const clients = new WeakMap<SessionScope, Parse>();

function createClient(scope: SessionScope): Parse | undefined {
  if (typeof Worker === 'undefined') return;
  let worker: Worker;
  try {
    worker = createMeasuredWorker(
      'line',
      (identity) =>
        new Worker(measurementWorkerUrl(measuredWorkerAsset, identity), {
          type: 'module',
          ...(identity ? { name: identity } : {}),
        }),
    );
  } catch (error) {
    logger.warn('[LineParserWorker] Worker 创建失败，回退主线程:', error);
    return;
  }
  const { generation, projectId, sourceSha256 } = scope.session;
  const session = { generation, projectId, sourceSha256 };
  let sequence = 0,
    active = true;
  const requests = new WorkerRequests<LineParserWorkerResult>(120_000, () => release());
  const parse: Parse = (files) => {
    if (!scope.isCurrent()) return Promise.reject(new StaleSessionError());
    const request: LineParserWorkerRequest = {
      type: 'parse',
      requestId: ++sequence,
      session,
      files,
    };
    return requests.request(request.requestId, () =>
      worker.postMessage(
        request,
        files.map((file) => file.bytes),
      ),
    );
  };
  const dispose = (error: Error) => {
    if (!active) return;
    active = false;
    clients.delete(scope);
    worker.onmessage = worker.onerror = worker.onmessageerror = null;
    requests.rejectAll(error);
    worker.terminate();
  };
  clients.set(scope, parse);
  const release = scope.own(() => dispose(new StaleSessionError()));
  if (!active) return parse;
  const fail = (error: Error) => {
    dispose(error);
    release();
  };
  worker.onmessage = ({ data }: MessageEvent<LineParserWorkerResponse>) => {
    if (!active || !scope.isCurrent()) return;
    const owner = data.session;
    if (
      owner.generation !== generation ||
      owner.projectId !== projectId ||
      owner.sourceSha256 !== sourceSha256
    ) {
      requests.settle(data.requestId, undefined, new StaleSessionError());
      return;
    }
    if (data.type === 'error') {
      const error = new Error(data.message);
      if (data.stack) error.stack = data.stack;
      requests.settle(data.requestId, undefined, error);
      return;
    }
    requests.settle(data.requestId, {
      graph: data.graph,
      attributes: data.attributes,
      timings: { ...data.timings, worker: true },
    });
  };
  worker.onerror = (event) => fail(new Error(event.message || '线路解析 Worker 发生错误'));
  worker.onmessageerror = () => fail(new Error('线路解析 Worker 返回无法读取的数据，请重试'));
  return parse;
}

function parseOnMainThread(files: LineParserWorkerFile[]): LineParserWorkerResult {
  const totalStart = performance.now();
  const decodeStart = performance.now();
  const textFiles = files.map((file) => ({
    path: file.path,
    text: decodeGimText(new Uint8Array(file.bytes)).text,
  }));
  const decodeMs = performance.now() - decodeStart;
  const cache = createLineParserCache(textFiles);
  const graphStart = performance.now();
  const graph = buildLineGimGraphFromTexts(textFiles, cache);
  const graphMs = performance.now() - graphStart;
  const attrStart = performance.now();
  const attributes = parseLineAttributesFromCache(graph, cache);
  const attributesMs = performance.now() - attrStart;
  return {
    graph,
    attributes,
    timings: {
      decodeMs,
      graphMs,
      attributesMs,
      totalMs: performance.now() - totalStart,
      fileCount: files.length,
      bytes: files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
      cacheEntries: cache.size,
      worker: false,
    },
  };
}

/** Each project scope owns its parser and rejects replies stamped with another source. */
export async function parseLineInWorker(
  files: LineParserWorkerFile[],
  scope: SessionScope,
): Promise<LineParserWorkerResult> {
  if (!scope.isCurrent()) throw new StaleSessionError();
  const parse = clients.get(scope) ?? createClient(scope);
  return parse ? parse(files) : parseOnMainThread(files);
}
