/** Resolve and load the line MOD sources of an inspector object. */
import type { AppState } from '../app/state.js';
import type { GimGraphNode } from '@gim/powerline-core/gimGraphTypes.js';
import { parseLineMod } from '@gim/powerline-core/geometry/lineModParser.js';
import {
  resolveLineReference,
  type LineEntryLookup,
} from '@gim/powerline-core/linePathNormalize.js';
import { createEntryIndex, getFileEntryIndex, type EntryIndex } from '../gim/entryResolver.js';
import { parseDev } from '../gim/geometry/devParser.js';
import { parsePhm } from '../gim/geometry/phmParser.js';
import type { LineTextModGeometrySource } from '../gim/geometry/ir.js';
import { StaleSessionError, type SessionScope } from '../shared/sessionScope.js';
import { logger } from '../utils/logger.js';

export interface LineModRuntimeEntry {
  /** Actual archive path for the source inspector. */
  path: string;
  source: LineTextModGeometrySource | null;
  error?: string;
  dependencyKind?: 'dev' | 'phm';
}

interface LineModTraversal {
  paths: string[];
  failures: LineModRuntimeEntry[];
}

interface LineModSession {
  scope: SessionScope;
  files: Map<string, File> | null;
  entryIndex?: Promise<EntryIndex>;
  paths: Map<string, Promise<LineModTraversal>>;
  sources: Map<string, Promise<LineModRuntimeEntry>>;
}

const MAX_SOURCES_PER_TYPE = 20_000;
const sessions = new WeakMap<AppState, LineModSession>();

function getSession(state: AppState): LineModSession {
  const scope = state.sessionScope(state.captureProjectSession());
  const files = state.currentFiles;
  const cached = sessions.get(state);
  if (cached?.scope === scope && cached.files === files) return cached;
  const runtime: LineModSession = { scope, files, paths: new Map(), sources: new Map() };
  sessions.set(state, runtime);
  scope.own(() => {
    if (sessions.get(state) === runtime) sessions.delete(state);
  });
  return runtime;
}

function getEntryIndex(runtime: LineModSession): Promise<EntryIndex> {
  if (runtime.entryIndex) return runtime.entryIndex;
  const { scope, files } = runtime;
  const index = scope
    .read(async () => {
      if (files) return getFileEntryIndex(files);
      const { projectId, sourceSha256 } = scope.session;
      if (projectId == null) return createEntryIndex([]);
      const { readExtractionManifest } = await import('../infrastructure/native/gimExtract.js');
      const manifest = await scope.read(() => readExtractionManifest(projectId, scope.isCurrent));
      if (!manifest || (sourceSha256 && manifest.source_sha256 !== sourceSha256)) {
        throw new Error('线路来源清单不可用，请重新打开工程');
      }
      return createEntryIndex(manifest.entries.map((entry) => entry.path));
    })
    .catch((error: unknown) => {
      runtime.entryIndex = undefined;
      throw error;
    });
  runtime.entryIndex = index;
  return index;
}

async function readText(runtime: LineModSession, path: string): Promise<string | null> {
  const { scope, files } = runtime;
  return scope.read(async () => {
    if (files) {
      const file = files.get(path);
      return file ? new TextDecoder().decode(await file.arrayBuffer()) : null;
    }
    const { projectId } = scope.session;
    if (projectId == null) return null;
    const { readCachedEntry } = await import('../infrastructure/native/projectFiles.js');
    const bytes = await scope.read(() => readCachedEntry(projectId, path, scope.isCurrent));
    return new TextDecoder().decode(bytes);
  });
}

function sourceReadFailure(
  runtime: LineModSession,
  path: string,
  error: unknown,
): LineModRuntimeEntry {
  if (error instanceof StaleSessionError) throw error;
  if (!runtime.scope.isCurrent()) throw new StaleSessionError();
  const message = error instanceof Error ? error.message : String(error);
  return { path, source: null, error: `读取线路来源 ${path} 失败：${message}` };
}

function loadSource(runtime: LineModSession, path: string): Promise<LineModRuntimeEntry> {
  const cached = runtime.sources.get(path);
  if (cached) return cached;
  const entry = runtime.scope
    .read(async () => {
      const text = await readText(runtime, path);
      if (text == null) {
        return { path, source: null, error: '源 MOD 文件不在当前工程缓存中' };
      }
      try {
        return { path, source: parseLineMod(text, path) };
      } catch (error) {
        return {
          path,
          source: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })
    .catch((error: unknown) => {
      runtime.sources.delete(path);
      return sourceReadFailure(runtime, path, error);
    });
  runtime.sources.set(path, entry);
  return entry;
}

/** Collect the actual paths already resolved by the line graph builder. */
function collectLineGeometryRefs(node: GimGraphNode): string[] {
  const paths = new Set<string>();
  const visited = new Set<string>();
  const walk = (current: GimGraphNode): void => {
    if (visited.has(current.path)) return;
    visited.add(current.path);
    for (const path of current.refs.modFiles) paths.add(path);
    for (const path of current.refs.devFiles) paths.add(path);
    for (const path of current.refs.phmFiles) paths.add(path);
    for (const child of current.children) walk(child);
  };
  walk(node);
  return [...paths];
}

async function resolveLineModPaths(
  runtime: LineModSession,
  roots: readonly string[],
): Promise<LineModTraversal> {
  const index = await getEntryIndex(runtime);
  const lookup: LineEntryLookup = {
    exact: (path) => {
      const matches = index.exactCandidates(path);
      return matches.length > 1 ? null : matches[0];
    },
    uniqueBasename: (name) => {
      const matches = index.basenameCandidates(name);
      return matches.length === 1 ? matches[0] : null;
    },
  };
  const pending: string[] = [];
  const visited = new Set<string>();
  const mods: string[] = [];
  const failures: LineModRuntimeEntry[] = [];
  const counts = { DEV: 0, PHM: 0, MOD: 0 };

  const enqueue = (path: string | null): void => {
    if (!path || visited.has(path)) return;
    const type = path.slice(path.lastIndexOf('.') + 1).toUpperCase();
    if (type !== 'DEV' && type !== 'PHM' && type !== 'MOD') return;
    if (counts[type] >= MAX_SOURCES_PER_TYPE) {
      throw new RangeError(
        `线路 ${type} 来源超过遍历上限 ${MAX_SOURCES_PER_TYPE}，请选取更具体的对象查看`,
      );
    }
    counts[type]++;
    visited.add(path);
    if (type === 'MOD') mods.push(path);
    else pending.push(path);
  };
  for (const root of roots) {
    const matches = index.exactCandidates(root);
    if (matches.length === 1) enqueue(matches[0]);
  }

  for (let cursor = 0; cursor < pending.length; cursor++) {
    const path = pending[cursor];
    const dependencyKind = /\.dev$/i.test(path) ? 'dev' : 'phm';
    let text: string | null;
    try {
      text = await readText(runtime, path);
    } catch (error) {
      failures.push({ ...sourceReadFailure(runtime, path, error), dependencyKind });
      continue;
    }
    if (text == null) continue;
    let references: string[];
    try {
      if (dependencyKind === 'dev') {
        const doc = parseDev(text, path);
        references = [
          ...doc.solidModels.map((row) => row.solidModelPath),
          ...doc.subDevices.map((row) => row.devPath),
        ];
      } else {
        const doc = parsePhm(text, path);
        if (doc.sourceDiagnostics?.length) {
          logger.warn('[Line PHM] 来源字段或矩阵存在歧义:', doc.sourceDiagnostics);
        }
        references = doc.solidModels.map((row) => row.solidModelPath);
      }
    } catch {
      continue;
    }
    for (const reference of references) enqueue(resolveLineReference(reference, path, lookup));
  }
  return { paths: mods, failures };
}

/** Reuse a traversal for objects that reference the same set of sources. */
export async function loadLineModSourcesForNode(
  state: AppState,
  node: GimGraphNode,
): Promise<LineModRuntimeEntry[]> {
  const runtime = getSession(state);
  return runtime.scope.read(async () => {
    const roots = collectLineGeometryRefs(node);
    if (!roots.length) return [];
    const key = JSON.stringify(roots.slice().sort());
    let pending = runtime.paths.get(key);
    if (!pending) {
      pending = runtime.scope
        .read(() => resolveLineModPaths(runtime, roots))
        .then(
          (result) => {
            if (result.failures.length) runtime.paths.delete(key);
            return result;
          },
          (error: unknown) => {
            runtime.paths.delete(key);
            throw error;
          },
        );
      runtime.paths.set(key, pending);
    }
    const { paths, failures } = await pending;
    const entries = [...failures];
    for (const path of paths) {
      entries.push(await runtime.scope.read(() => loadSource(runtime, path)));
    }
    return entries;
  });
}
