/**
 * 线路 MOD 运行时服务。
 *
 * lineModParser 只负责把四类文本格式解析为 Geometry IR；本服务负责把
 * CBM → DEV → PHM → MOD 引用链解析到可读的 MOD 来源，并在当前工程会话内
 * 缓存结果。UI 只消费 LineModRuntimeEntry，不直接读取文件或数据库。
 */

import type { AppState } from '../app/state.js';
import type { GimGraphNode } from '../gim/gimGraphTypes.js';
import type { LineTextModGeometrySource } from '../gim/geometry/ir.js';
import { parseLineMod } from '../gim/geometry/lineModParser.js';
import { parseDev } from '../gim/geometry/devParser.js';
import { parsePhm } from '../gim/geometry/phmParser.js';
import { getFileByPath } from '../gim/fileLookup.js';
import { normalizeGimPath } from '../gim/linePathNormalize.js';

export interface LineModRuntimeEntry {
  /** 归一化后的 MOD 路径；完整路径只用于 data 属性/事件，不作为正文显示。 */
  path: string;
  source: LineTextModGeometrySource | null;
  error?: string;
}

const IDENTITY_SOURCE = 'memory';
const sourceCache = new WeakMap<AppState, Map<string, LineModRuntimeEntry>>();

function cacheFor(state: AppState): Map<string, LineModRuntimeEntry> {
  let cache = sourceCache.get(state);
  if (!cache) {
    cache = new Map<string, LineModRuntimeEntry>();
    sourceCache.set(state, cache);
  }
  return cache;
}

function sourceKey(state: AppState, path: string): string {
  return `${state.currentSourceSha256 || (state.currentProjectId != null ? `project:${state.currentProjectId}` : IDENTITY_SOURCE)}:${path.toLowerCase()}`;
}

function withPrefix(path: string, prefix: 'Dev' | 'Phm' | 'Mod'): string {
  const normalized = normalizeGimPath(path);
  if (!normalized) return `${prefix}/`;
  const lower = normalized.toLowerCase();
  if (lower.startsWith(`${prefix.toLowerCase()}/`)) return normalized;
  // 引用值通常是 GUID.ext 裸名；目录大小写由实际文件查找工具兜底。
  return `${prefix}/${normalized}`;
}

function fileName(path: string): string {
  const normalized = normalizeGimPath(path);
  return normalized.split('/').pop() || normalized;
}

async function readText(state: AppState, path: string): Promise<string | null> {
  if (state.currentFiles) {
    const file = getFileByPath(state.currentFiles, path);
    if (!file) return null;
    return new TextDecoder().decode(await file.arrayBuffer());
  }
  if (state.currentProjectId == null) return null;
  try {
    const { readCachedIfc } = await import('@desktop/database.js');
    const bytes = await readCachedIfc(state.currentProjectId, path);
    return bytes.byteLength > 0 ? new TextDecoder().decode(bytes) : null;
  } catch {
    return null;
  }
}

async function loadSource(state: AppState, path: string): Promise<LineModRuntimeEntry> {
  const normalized = withPrefix(path, 'Mod');
  const key = sourceKey(state, normalized);
  const cache = cacheFor(state);
  const cached = cache.get(key);
  if (cached) return cached;

  const text = await readText(state, normalized);
  if (text == null) {
    const result: LineModRuntimeEntry = { path: normalized, source: null, error: '源 MOD 文件不在当前工程缓存中' };
    cache.set(key, result);
    return result;
  }
  try {
    const source = parseLineMod(text, normalized);
    const result: LineModRuntimeEntry = { path: normalized, source };
    cache.set(key, result);
    return result;
  } catch (error) {
    const result: LineModRuntimeEntry = {
      path: normalized,
      source: null,
      error: error instanceof Error ? error.message : String(error),
    };
    cache.set(key, result);
    return result;
  }
}

/** 从节点及其业务子树收集所有可达的 MOD/DEV/PHM 引用。 */
export function collectLineGeometryRefs(node: GimGraphNode): {
  modPaths: string[];
  devPaths: string[];
  phmPaths: string[];
} {
  const mods = new Set<string>();
  const devs = new Set<string>();
  const phms = new Set<string>();
  const walk = (current: GimGraphNode): void => {
    for (const path of current.refs.modFiles) mods.add(withPrefix(path, 'Mod'));
    for (const path of current.refs.devFiles) devs.add(withPrefix(path, 'Dev'));
    for (const path of current.refs.phmFiles) phms.add(withPrefix(path, 'Phm'));
    for (const child of current.children) walk(child);
  };
  walk(node);
  return { modPaths: Array.from(mods), devPaths: Array.from(devs), phmPaths: Array.from(phms) };
}

/**
 * 解析 DEV/PHM 引用，返回节点真正可达的 MOD 路径。
 *
 * 线路 DEV 中常见的是 DEV→DEV→PHM→MOD 多级链；采用有界 BFS 并去重，
 * 保留弱 schema 文件的可见性，不因单个坏引用阻断属性面板。
 */
export async function resolveLineModPaths(state: AppState, node: GimGraphNode): Promise<string[]> {
  const refs = collectLineGeometryRefs(node);
  const modPaths = new Set(refs.modPaths);
  const pendingDev = [...refs.devPaths];
  const pendingPhm = [...refs.phmPaths];
  const seenDev = new Set<string>();
  const seenPhm = new Set<string>();
  const budget = 20000;

  while ((pendingDev.length > 0 || pendingPhm.length > 0) && modPaths.size < budget) {
    while (pendingDev.length > 0 && seenDev.size < budget) {
      const devPath = pendingDev.shift()!;
      const devKey = devPath.toLowerCase();
      if (seenDev.has(devKey)) continue;
      seenDev.add(devKey);
      const text = await readText(state, devPath);
      if (text == null) continue;
      let doc;
      try {
        doc = parseDev(text, devPath);
      } catch {
        continue;
      }
      for (const solid of doc.solidModels) {
        const lower = fileName(solid.solidModelPath).toLowerCase();
        if (lower.endsWith('.mod')) modPaths.add(withPrefix(solid.solidModelPath, 'Mod'));
        else if (lower.endsWith('.phm')) pendingPhm.push(withPrefix(solid.solidModelPath, 'Phm'));
        else if (lower.endsWith('.dev')) pendingDev.push(withPrefix(solid.solidModelPath, 'Dev'));
      }
      for (const sub of doc.subDevices) pendingDev.push(withPrefix(sub.devPath, 'Dev'));
    }

    while (pendingPhm.length > 0 && seenPhm.size < budget) {
      const phmPath = pendingPhm.shift()!;
      const phmKey = phmPath.toLowerCase();
      if (seenPhm.has(phmKey)) continue;
      seenPhm.add(phmKey);
      const text = await readText(state, phmPath);
      if (text == null) continue;
      let doc;
      try {
        doc = parsePhm(text, phmPath);
      } catch {
        continue;
      }
      for (const solid of doc.solidModels) {
        const lower = fileName(solid.solidModelPath).toLowerCase();
        if (lower.endsWith('.mod')) modPaths.add(withPrefix(solid.solidModelPath, 'Mod'));
        else if (lower.endsWith('.phm')) pendingPhm.push(withPrefix(solid.solidModelPath, 'Phm'));
      }
    }
  }

  return Array.from(modPaths);
}

/** 加载并解析节点可达的所有线路 MOD，结果按引用顺序去重。 */
export async function loadLineModSourcesForNode(state: AppState, node: GimGraphNode): Promise<LineModRuntimeEntry[]> {
  const paths = await resolveLineModPaths(state, node);
  const entries: LineModRuntimeEntry[] = [];
  for (const path of paths) entries.push(await loadSource(state, path));
  return entries;
}

/** 单文件加载入口，供属性页签和测试使用。 */
export async function loadLineModSource(state: AppState, path: string): Promise<LineModRuntimeEntry> {
  return loadSource(state, path);
}

/** 工程切换时由 UI/清理流程调用；WeakMap 会自动释放 state，但显式清空便于测试。 */
export function clearLineModRuntimeCache(state: AppState): void {
  sourceCache.get(state)?.clear();
}

