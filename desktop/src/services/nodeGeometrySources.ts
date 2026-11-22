import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { CbmNode } from '../gim/types.js';
import { buildSubstationAliasIndex } from '../gim/substationEvidence.js';
import { hasFileByPath } from '../gim/fileLookup.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog, logger } from '../utils/logger.js';
import type { DiscoveredGeometries } from './modGeometryDiscovery.js';

/**
 * 为节点点击选择可用于发现几何的 CBM 节点。
 *
 * PARTINDEX 只描述父设备的一个组成部件，并不保存其 DEV SUBDEVICE
 * transform。选择最近的带 DEV 的祖先可复用完整 DEV 递归链，避免生成
 * 缺失局部矩阵的重复实例。
 */
export function resolveGeometryLoadNode(root: CbmNode | null, node: CbmNode): CbmNode {
  if (node.entityName.toUpperCase() === 'DEV_SUBDEVICE' && root) {
    const rootPath = node.path.split('#dev:')[0];
    const find = (n: CbmNode): CbmNode | undefined => {
      if (n.path === rootPath) return n;
      for (const child of n.children) {
        const found = find(child);
        if (found) return found;
      }
    };
    return find(root) ?? node;
  }
  if (node.entityName.toUpperCase() !== 'PARTINDEX' || !root) return node;
  return buildSubstationAliasIndex(root).partToRoot.get(node.path) ?? node;
}

/**
 * 缓存命中场景下，从磁盘读取 DEV/PHM/MOD 文件构建临时 Map<string, File>。
 *
 * 读取范围：
 * - DEV/{node.devPath}（必需）
 * - 递归 DEV / PHM 引用（批量读取，visited 与深度限制）
 * - 显式 MOD / GL / STL 叶子（缺失时仅隔离目标）
 *
 * 一次点击只读取该节点引用链需要的文件，避免一次性读取全部 DEV/PHM/MOD。
 *
 * @param projectId 数据库 gim_project.id
 * @param node CBM 节点（必须带 devPath）
 * @returns 包含可达引用源的 Map；找不到时返回空 Map
 */
async function buildGeometryFilesMapFromCache(
  projectId: number,
  node: CbmNode,
  state: AppState,
  session: ProjectLoadSession,
): Promise<Map<string, File>> {
  const { batchReadCachedFiles } = await import('../infrastructure/native/projectFiles.js');
  const { hydrateSubstationGeometryGraph } =
    await import('../gim/geometry/substationSourceGraph.js');
  const current = () => state.isCurrentSession(session);
  if (!node.devPath || !current()) return new Map();
  return hydrateSubstationGeometryGraph(
    [node.devPath],
    async (paths) => {
      if (!current()) return new Map();
      const bytes = await batchReadCachedFiles(projectId, paths, current, { borrowPayload: true });
      if (!current()) return new Map();
      return new Map(
        [...bytes]
          .filter(([, value]) => value && value.byteLength > 0)
          .map(([path, value]) => [path, bytesToFile(value!, path)]),
      );
    },
    state.substationEntryPaths,
  );
}

async function hydrateGeometryLeaves(
  projectId: number,
  paths: readonly string[],
  files: Map<string, File>,
  current: () => boolean,
): Promise<void> {
  const { readCachedIfc } = await import('../infrastructure/native/projectFiles.js');
  for (const path of paths) {
    if (!current()) return;
    if (hasFileByPath(files, path)) continue;
    try {
      const bytes = await readCachedIfc(projectId, path, current);
      if (!current()) return;
      files.set(path, bytesToFile(bytes, path));
      debugLog(DEBUG_IFC_LOAD, '[xml-mod] 从磁盘读取几何:', path, `(${bytes.byteLength} bytes)`);
    } catch (error) {
      if (current()) logger.warn(`[xml-mod] 几何文件读取失败: ${path}`, error);
    }
  }
}

export async function readRawNodeGeometry(
  node: CbmNode,
  state: AppState,
  session: ProjectLoadSession,
): Promise<(DiscoveredGeometries & { files: Map<string, File> }) | undefined> {
  const current = () => state.isCurrentSession(session);
  const memoryFiles = state.currentFiles;
  const projectId = session.projectId;
  const files =
    memoryFiles ??
    (projectId == null
      ? undefined
      : await buildGeometryFilesMapFromCache(projectId, node, state, session));
  if (!current() || !files?.size) return;
  const { discoverGeometriesFromNode, computeCbmParentTransform } =
    await import('./modGeometryDiscovery.js');
  if (!current()) return;
  const parentTransform =
    node.entityName === 'DEV_SUBDEVICE'
      ? computeCbmParentTransform(state.currentCbmTree, node.path)
      : undefined;
  const discovered = await discoverGeometriesFromNode(node, files, parentTransform);
  if (!current()) return;
  if (!memoryFiles && projectId != null) {
    await hydrateGeometryLeaves(
      projectId,
      [...discovered.mods.map((geo) => geo.modPath), ...discovered.stls.map((geo) => geo.stlPath)],
      files,
      current,
    );
  }
  if (current()) return { files, ...discovered };
}

export async function readNodeDevGlb(
  node: CbmNode,
  state: AppState,
  session: ProjectLoadSession,
): Promise<{ path: string; bytes: Uint8Array } | undefined> {
  const current = () => state.isCurrentSession(session);
  const projectId = session.projectId;
  if (projectId == null || !current()) return;
  const { createEntryResolver, getFileEntryResolver } = await import('../gim/entryResolver.js');
  if (!current()) return;
  const path = (
    state.currentFiles
      ? getFileEntryResolver(state.currentFiles)
      : createEntryResolver(state.substationEntryPaths)
  )(node.devPath, node.path);
  if (!path) return;
  try {
    const { readGlbFile } = await import('../infrastructure/native/projectFiles.js');
    if (!current()) return;
    const bytes = await readGlbFile(projectId, path, current);
    if (current() && bytes?.byteLength) return { path, bytes };
  } catch {
    // The raw geometry path remains available after a cache read failure.
  }
}

/** Native responses are ArrayBuffer-backed. File copies only the entry view. */
function bytesToFile(bytes: Uint8Array, path: string): File {
  return new File([bytes as Uint8Array<ArrayBuffer>], path, { type: 'application/octet-stream' });
}
