/**
 * 线路工程 FAM/DEV 属性恢复服务（v5）。
 *
 * 从 SQLite 读取的 LineAttributeResult 恢复 FAM/DEV 属性到 AppState，
 * 二次打开线路 GIM（缓存命中）时调用。首次导入后也可用 payload 构造同样的
 * 数据结构写入 state（LineFamPropertyPayload 与 LineFamPropertyRecord 字段一致）。
 *
 * 写入 AppState：
 * - cachedLineFamProperties: Map<normalizedPath, Map<propKey, LineFamPropertyRecord[]>>
 * - cachedLineFamDisplayKeys: Map<normalizedPath, Map<propKey, displayKey>>
 * - cachedLineDevProperties: Map<normalizedPath, Map<propKey, LineDevPropertyRecord[]>>
 *
 *
 * 设计参考 gimIndexRestoreService.ts（变电工程索引恢复）。
 */

import type { ProjectPropertyCache } from '../../../services/project/projectPropertyCache.js';
import type {
  LineAttributeResult,
  LineFamPropertyRecord,
  LineDevPropertyRecord,
} from '@desktop/database.js';
import { DEBUG_GIM_CACHE } from '../../../config/debug.js';
import { debugLog } from '../../../utils/logger.js';
interface LinePropertyState {
  properties: Pick<
    ProjectPropertyCache,
    'cachedLineFamProperties' | 'cachedLineFamDisplayKeys' | 'cachedLineDevProperties'
  >;
}

/**
 * 将 FAM/DEV 属性恢复到 AppState。
 *
 * @param result get_line_attributes 返回结果（或首次导入时由 payload 构造的同构对象）
 * @param state 应用全局状态
 * @returns 恢复的属性数量统计 { famCount, devCount, famSources, devSources }
 */
export function restoreLineAttributesToState(
  result: LineAttributeResult,
  state: LinePropertyState,
): { famCount: number; devCount: number; famSources: number; devSources: number } {
  // 1. 清空旧缓存（防御性，resetGimState 已清，这里确保干净）
  state.properties.cachedLineFamProperties.clear();
  state.properties.cachedLineFamDisplayKeys.clear();
  state.properties.cachedLineDevProperties.clear();

  // 2. 写入 FAM 属性：按 normalized_path 分组 → propKey → records[]
  let famCount = 0;
  for (const rec of result.fam_properties) {
    let byProp = state.properties.cachedLineFamProperties.get(rec.normalized_path);
    if (!byProp) {
      byProp = new Map<string, LineFamPropertyRecord[]>();
      state.properties.cachedLineFamProperties.set(rec.normalized_path, byProp);
    }
    let list = byProp.get(rec.prop_key);
    if (!list) {
      list = [];
      byProp.set(rec.prop_key, list);
    }
    list.push(rec);
    famCount++;

    // display_key 索引：取该 propKey 下第一个非 null 的 display_key
    let displayByProp = state.properties.cachedLineFamDisplayKeys.get(rec.normalized_path);
    if (!displayByProp) {
      displayByProp = new Map<string, string | null>();
      state.properties.cachedLineFamDisplayKeys.set(rec.normalized_path, displayByProp);
    }
    if (!displayByProp.has(rec.prop_key)) {
      displayByProp.set(rec.prop_key, rec.display_key);
    }
  }

  // 3. 写入 DEV 属性
  let devCount = 0;
  for (const rec of result.dev_properties) {
    let byProp = state.properties.cachedLineDevProperties.get(rec.normalized_path);
    if (!byProp) {
      byProp = new Map<string, LineDevPropertyRecord[]>();
      state.properties.cachedLineDevProperties.set(rec.normalized_path, byProp);
    }
    let list = byProp.get(rec.prop_key);
    if (!list) {
      list = [];
      byProp.set(rec.prop_key, list);
    }
    list.push(rec);
    devCount++;
  }

  debugLog(DEBUG_GIM_CACHE, '[Restore] 线路工程 FAM/DEV 属性已恢复:', {
    famCount,
    devCount,
    famSources: state.properties.cachedLineFamProperties.size,
    devSources: state.properties.cachedLineDevProperties.size,
  });

  return {
    famCount,
    devCount,
    famSources: state.properties.cachedLineFamProperties.size,
    devSources: state.properties.cachedLineDevProperties.size,
  };
}
