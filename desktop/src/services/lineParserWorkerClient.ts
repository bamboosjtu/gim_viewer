import measuredWorkerAsset from './lineParserWorker.ts?worker&url';
import { createMeasuredWorker, measurementWorkerUrl } from '../measurement/hostWorker.js';
import { WorkerRequests } from './workerRequests.js';
import { decodeGimText } from '../shared/textDecode.js';
/** Line Parser Worker v1 客户端与同步兼容回退。 */

import type { ProjectLoadSession } from '../shared/projectSession.js';
import { createLineParserCache } from '../gim/lineAttrParserCore.js';
import { buildLineGimGraphFromTexts } from '../gim/lineCbmParserCore.js';
import { parseLineAttributesFromCache, type LineAttributePayloadsCore } from '../gim/lineAttrParserCore.js';
import type {
  LineParserWorkerFile,
  LineParserWorkerRequest,
  LineParserWorkerResponse,
  LineParserWorkerSession,
  LineParserWorkerSuccess,
} from './lineParserWorker.js';

export interface LineParserWorkerResult {
  graph: LineParserWorkerSuccess['graph'];
  attributes: LineAttributePayloadsCore;
  timings: LineParserWorkerSuccess['timings'] & { worker: boolean };
}

let worker: Worker | null = null;
let requestSequence = 0;
const requestSessions = new Map<number,string>();
const requests = new WorkerRequests<LineParserWorkerResult>(120_000, () => terminateLineParserWorker());
let activeSessionKey: string | null = null;

function toWorkerSession(session: ProjectLoadSession): LineParserWorkerSession {
  return {
    generation: session.generation,
    projectId: session.projectId,
    sourceSha256: session.sourceSha256,
  };
}

function sessionKey(session: LineParserWorkerSession): string {
  return `${session.generation}|${session.projectId ?? ''}|${session.sourceSha256 ?? ''}`;
}

function deserializeError(message: string, stack?: string): Error {
  const error = new Error(message);
  if (stack) error.stack = stack;
  return error;
}

function ensureWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    const instance = createMeasuredWorker('line', identity => new Worker(measurementWorkerUrl(measuredWorkerAsset,identity), {type:'module',...(identity?{name:identity}:{})}));
    instance.onmessage = (event: MessageEvent<LineParserWorkerResponse>) => {
      const response = event.data;
      const key = requestSessions.get(response.requestId);
      if (!key) return;
      requestSessions.delete(response.requestId);
      if (key !== activeSessionKey || key !== sessionKey(response.session)) {
        requests.settle(response.requestId, undefined, new Error('线路解析 Worker 结果已过期'));
        return;
      }
      if (response.type === 'error') {
        requests.settle(response.requestId, undefined, deserializeError(response.message, response.stack));
        return;
      }
      requests.settle(response.requestId, {
        graph: response.graph,
        attributes: response.attributes,
        timings: { ...response.timings, worker: true },
      });
    };
    const fail = (error:Error) => {
      requests.rejectAll(error); requestSessions.clear(); instance.terminate();
      if(worker===instance) worker=null;
    };
    instance.onerror = event => fail(new Error(event.message || '线路解析 Worker 发生错误'));
    instance.onmessageerror = () => fail(new Error('线路解析 Worker 返回无法读取的数据，请重试'));
    worker = instance;
    return instance;
  } catch (error) {
    console.warn('[LineParserWorker] Worker 创建失败，回退主线程:', error);
    return null;
  }
}

function parseOnMainThread(files: LineParserWorkerFile[]): LineParserWorkerResult {
  const totalStart = performance.now();
  const decodeStart = performance.now();
  const textFiles = files.map((file) => ({ path: file.path, text: decodeGimText(new Uint8Array(file.bytes)).text }));
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

/**
 * 在线程中解析线路图与 FAM/DEV 属性。调用方必须在 await 前后用
 * state.isCurrentSession(session) 校验；客户端也会拒绝当前 active session
 * 之外的迟到 Worker 结果。
 */
export function parseLineInWorker(
  files: LineParserWorkerFile[],
  session: ProjectLoadSession,
): Promise<LineParserWorkerResult> {
  const workerInstance = ensureWorker();
  if (!workerInstance) return Promise.resolve(parseOnMainThread(files));

  const serializableSession = toWorkerSession(session);
  const key = sessionKey(serializableSession);
  activeSessionKey = key;
  const requestId = ++requestSequence;
  const request: LineParserWorkerRequest = {
    type: 'parse',
    requestId,
    session: serializableSession,
    files,
  };
  requestSessions.set(requestId, key);
  return requests.request(requestId, () => workerInstance.postMessage(request, files.map(file => file.bytes)))
    .finally(() => { requestSessions.delete(requestId); });
}

/** 工程清理时可主动停止 Worker，避免窗口关闭后保留后台线程。 */
export function terminateLineParserWorker(): void {
  activeSessionKey = null;
  requests.rejectAll(new Error('线路解析 Worker 已终止'));
  requestSessions.clear();
  worker?.terminate();
  worker = null;
}

