/** Line Parser Worker v1 客户端与同步兼容回退。 */

import type { ProjectLoadSession } from '../app/state.js';
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

interface PendingRequest {
  sessionKey: string;
  resolve: (result: LineParserWorkerResult) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;
let requestSequence = 0;
const pending = new Map<number, PendingRequest>();
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
    const instance = new Worker(new URL('./lineParserWorker.ts', import.meta.url), { type: 'module' });
    instance.onmessage = (event: MessageEvent<LineParserWorkerResponse>) => {
      const response = event.data;
      const request = pending.get(response.requestId);
      if (!request) return;
      pending.delete(response.requestId);
      if (request.sessionKey !== activeSessionKey || request.sessionKey !== sessionKey(response.session)) {
        request.reject(new Error('线路解析 Worker 结果已过期'));
        return;
      }
      if (response.type === 'error') {
        request.reject(deserializeError(response.message, response.stack));
        return;
      }
      request.resolve({
        graph: response.graph,
        attributes: response.attributes,
        timings: { ...response.timings, worker: true },
      });
    };
    instance.onerror = (event) => {
      const error = new Error(event.message || '线路解析 Worker 发生错误');
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      instance.terminate();
      worker = null;
    };
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
  const decoder = new TextDecoder();
  const textFiles = files.map((file) => ({ path: file.path, text: decoder.decode(new Uint8Array(file.bytes)) }));
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
  return new Promise<LineParserWorkerResult>((resolve, reject) => {
    pending.set(requestId, { sessionKey: key, resolve, reject });
    try {
      // 每个输入 ArrayBuffer 只转移一次，避免 structured clone 复制大文本。
      workerInstance.postMessage(request, files.map((file) => file.bytes));
    } catch (error) {
      pending.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** 工程清理时可主动停止 Worker，避免窗口关闭后保留后台线程。 */
export function terminateLineParserWorker(): void {
  activeSessionKey = null;
  for (const request of pending.values()) request.reject(new Error('线路解析 Worker 已终止'));
  pending.clear();
  worker?.terminate();
  worker = null;
}

