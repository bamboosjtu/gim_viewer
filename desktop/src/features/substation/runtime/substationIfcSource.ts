import type { AppState, ProjectLoadSession } from '../../../app/state.js';
import type { IfcEntry } from '../../../gim/types.js';
import { findMapKeyByPath, getFileByPath } from '../../../gim/fileLookup.js';
import { isTauri } from '@desktop/runtime.js';
import { DEBUG_IFC_LOAD } from '../../../config/debug.js';
import { debugLog, logger } from '../../../utils/logger.js';

type IfcSourceState = Pick<
  AppState,
  'currentFiles' | 'properties' | 'captureProjectSession' | 'isCurrentSession'
>;

/**
 * 获取 IFC 文件内容。
 * 1. 优先从完整解压流程的 currentFiles 读取
 * 2. 缓存命中时从 cachedIfcPaths + readCachedIfc 读取
 * 3. 找不到返回 null（调用方跳过）
 */

export async function getIfcBufferForEntry(
  entry: IfcEntry,
  state: IfcSourceState,
  session: ProjectLoadSession = state.captureProjectSession(),
): Promise<Uint8Array | null> {
  if (!state.isCurrentSession(session)) return null;
  // 1. 完整解压流程
  if (state.currentFiles) {
    const file = getFileByPath(state.currentFiles, entry.path);
    if (file) {
      debugLog(DEBUG_IFC_LOAD, '[IFC Buffer] 使用 GIM 解压内存文件:', {
        name: entry.name,
        path: entry.path,
      });
      const bytes = new Uint8Array(await file.arrayBuffer());
      return state.isCurrentSession(session) ? bytes : null;
    }
  }

  // 2. Tauri 缓存命中
  const cachedEntryPath = findMapKeyByPath(state.properties.cachedIfcPaths, entry.path);
  if (isTauri() && cachedEntryPath) {
    const projectId = session.projectId;
    if (projectId != null) {
      const cachePath = state.properties.cachedIfcPaths.get(cachedEntryPath)!;
      debugLog(DEBUG_IFC_LOAD, '[IFC Buffer] 使用本地 IFC 缓存:', {
        name: entry.name,
        path: entry.path,
        cachePath,
      });
      const { readCachedIfc } = await import('@desktop/database.js');
      const bytes = await readCachedIfc(projectId, cachedEntryPath);
      if (!state.isCurrentSession(session)) return null;

      // 可疑缓存定位日志：MVP 阶段用于排查缓存 IFC 是否被截断/损坏
      // IFC 文件应以 "ISO-103021;;" 文本头开头（HEX: 49 53 4F 2D 31 30 33 32 31 3B）
      // byteLength === 0 或 head 不符 → 缓存损坏，返回 null 让上层回退/报错
      const byteLength = bytes?.byteLength ?? 0;
      const head = bytes
        ? Array.from(bytes.slice(0, 32))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ')
        : '';
      debugLog(DEBUG_IFC_LOAD, '[IFC Buffer] cached IFC bytes', {
        name: entry.name,
        path: entry.path,
        byteLength,
        head,
      });
      if (byteLength === 0) {
        // 缓存损坏：始终输出（非 debug），便于用户定位
        logger.warn(`[IFC Buffer] 缓存 IFC 字节为空，缓存损坏: ${entry.path}`);
        return null;
      }
      // IFC 文件头 ASCII "ISO-103021;;" 前 4 字节应为 49 53 4F 2D（"ISO-"）
      // 不强制校验（部分 IFC 可能含 BOM 或前导空白），仅 warn 提示可疑
      if (
        bytes.length >= 4 &&
        !(bytes[0] === 0x49 && bytes[1] === 0x53 && bytes[2] === 0x4f && bytes[3] === 0x2d)
      ) {
        logger.warn(`[IFC Buffer] 缓存 IFC 文件头非 'ISO-' 前缀，可能损坏: ${entry.path}`, {
          head,
        });
      }
      return bytes;
    }
  }

  // 3. 找不到：始终输出（非 debug），便于定位
  logger.warn('[IFC Buffer] 找不到 IFC 文件内容或缓存:', entry);
  return null;
}
