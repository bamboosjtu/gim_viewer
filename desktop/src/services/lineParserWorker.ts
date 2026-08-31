/**
 * Line Parser Worker v1。
 *
 * 只接收可序列化的文本文件字节和 ProjectLoadSession 快照，不接触 AppState、
 * DOM、ViewerContext。CBM/FAM/DEV 在同一份 LineParserTextCache 上解析，避免
 * 线路图构建与属性解析重复解码/解析。
 */

import type { GimGraph } from '../gim/gimGraphTypes.js';
import { createLineParserCache } from '../gim/lineAttrParserCore.js';
import { buildLineGimGraphFromTexts } from '../gim/lineCbmParserCore.js';
import { parseLineAttributesFromCache, type LineAttributePayloadsCore } from '../gim/lineAttrParserCore.js';

export interface LineParserWorkerSession {
  generation: number;
  projectId: number | null;
  sourceSha256: string | null;
}

export interface LineParserWorkerFile {
  path: string;
  /** 通过 transferable 传入，Worker 内只解码一次。 */
  bytes: ArrayBuffer;
}

export interface LineParserWorkerRequest {
  type: 'parse';
  requestId: number;
  session: LineParserWorkerSession;
  files: LineParserWorkerFile[];
}

export interface LineParserWorkerSuccess {
  type: 'result';
  requestId: number;
  session: LineParserWorkerSession;
  graph: GimGraph;
  attributes: LineAttributePayloadsCore;
  timings: {
    decodeMs: number;
    graphMs: number;
    attributesMs: number;
    totalMs: number;
    fileCount: number;
    bytes: number;
    cacheEntries: number;
  };
}

export interface LineParserWorkerFailure {
  type: 'error';
  requestId: number;
  session: LineParserWorkerSession;
  message: string;
  stack?: string;
}

export type LineParserWorkerResponse = LineParserWorkerSuccess | LineParserWorkerFailure;

interface WorkerScope {
  onmessage: ((event: MessageEvent<LineParserWorkerRequest>) => void) | null;
  postMessage(message: LineParserWorkerResponse): void;
}

const workerScope = self as unknown as WorkerScope;

workerScope.onmessage = (event) => {
  const request = event.data;
  if (!request || request.type !== 'parse') return;
  const totalStart = performance.now();
  try {
    const decodeStart = performance.now();
    const decoder = new TextDecoder();
    const textFiles = request.files.map((file) => ({
      path: file.path,
      text: decoder.decode(new Uint8Array(file.bytes)),
    }));
    const decodeMs = performance.now() - decodeStart;
    const cache = createLineParserCache(textFiles);

    const graphStart = performance.now();
    const graph = buildLineGimGraphFromTexts(textFiles, cache);
    const graphMs = performance.now() - graphStart;

    const attrStart = performance.now();
    const attributes = parseLineAttributesFromCache(graph, cache);
    const attributesMs = performance.now() - attrStart;
    const bytes = request.files.reduce((sum, file) => sum + file.bytes.byteLength, 0);

    workerScope.postMessage({
      type: 'result',
      requestId: request.requestId,
      session: request.session,
      graph,
      attributes,
      timings: {
        decodeMs,
        graphMs,
        attributesMs,
        totalMs: performance.now() - totalStart,
        fileCount: request.files.length,
        bytes,
        cacheEntries: cache.size,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    workerScope.postMessage({
      type: 'error',
      requestId: request.requestId,
      session: request.session,
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
};
