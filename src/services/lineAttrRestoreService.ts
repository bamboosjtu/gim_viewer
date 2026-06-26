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
 * 同时暴露 buildLineAttributeIndex(state)，构建按 source_path / file_name_lower
 * 的查找索引，供后续 M3-4 地图数据提取使用。
 *
 * 设计参考 gimIndexRestoreService.ts（变电工程索引恢复）。
 */

import type { AppState } from '../app/state.js';
import type {
  LineAttributeResult,
  LineFamPropertyRecord,
  LineDevPropertyRecord,
} from '../desktop/database.js';
// LineAttributeIndex 类型定义已移至 gim/ 层，消除 gim/lineMapData → services 的反向依赖
import type { LineAttributeIndex } from '../gim/lineAttributeTypes.js';
export type { LineAttributeIndex } from '../gim/lineAttributeTypes.js';

/**
 * 将 FAM/DEV 属性恢复到 AppState。
 *
 * @param result get_line_attributes 返回结果（或首次导入时由 payload 构造的同构对象）
 * @param state 应用全局状态
 * @returns 恢复的属性数量统计 { famCount, devCount, famSources, devSources }
 */
export function restoreLineAttributesToState(
  result: LineAttributeResult,
  state: AppState,
): { famCount: number; devCount: number; famSources: number; devSources: number } {
  // 1. 清空旧缓存（防御性，resetGimState 已清，这里确保干净）
  state.cachedLineFamProperties.clear();
  state.cachedLineFamDisplayKeys.clear();
  state.cachedLineDevProperties.clear();

  // 2. 写入 FAM 属性：按 normalized_path 分组 → propKey → records[]
  let famCount = 0;
  for (const rec of result.fam_properties) {
    let byProp = state.cachedLineFamProperties.get(rec.normalized_path);
    if (!byProp) {
      byProp = new Map<string, LineFamPropertyRecord[]>();
      state.cachedLineFamProperties.set(rec.normalized_path, byProp);
    }
    let list = byProp.get(rec.prop_key);
    if (!list) {
      list = [];
      byProp.set(rec.prop_key, list);
    }
    list.push(rec);
    famCount++;

    // display_key 索引：取该 propKey 下第一个非 null 的 display_key
    let displayByProp = state.cachedLineFamDisplayKeys.get(rec.normalized_path);
    if (!displayByProp) {
      displayByProp = new Map<string, string | null>();
      state.cachedLineFamDisplayKeys.set(rec.normalized_path, displayByProp);
    }
    if (!displayByProp.has(rec.prop_key)) {
      displayByProp.set(rec.prop_key, rec.display_key);
    }
  }

  // 3. 写入 DEV 属性
  let devCount = 0;
  for (const rec of result.dev_properties) {
    let byProp = state.cachedLineDevProperties.get(rec.normalized_path);
    if (!byProp) {
      byProp = new Map<string, LineDevPropertyRecord[]>();
      state.cachedLineDevProperties.set(rec.normalized_path, byProp);
    }
    let list = byProp.get(rec.prop_key);
    if (!list) {
      list = [];
      byProp.set(rec.prop_key, list);
    }
    list.push(rec);
    devCount++;
  }

  console.log('[Restore] 线路工程 FAM/DEV 属性已恢复:', {
    famCount,
    devCount,
    famSources: state.cachedLineFamProperties.size,
    devSources: state.cachedLineDevProperties.size,
  });

  return {
    famCount,
    devCount,
    famSources: state.cachedLineFamProperties.size,
    devSources: state.cachedLineDevProperties.size,
  };
}

/**
 * 从 AppState.cachedLine* 构建按 source_path / file_name_lower 的查找索引。
 *
 * cachedLineFamProperties 按 normalized_path 索引，M3-4 地图数据提取时
 * 需要按 source_path 或 file_name_lower 查找，因此提供此转换函数。
 *
 * @param state 已恢复线路属性的应用状态
 */
export function buildLineAttributeIndex(state: AppState): LineAttributeIndex {
  const famBySourcePath = new Map<string, Map<string, LineFamPropertyRecord[]>>();
  const famByFileNameLower = new Map<string, Map<string, LineFamPropertyRecord[]>>();
  const devBySourcePath = new Map<string, Map<string, LineDevPropertyRecord[]>>();
  const devByFileNameLower = new Map<string, Map<string, LineDevPropertyRecord[]>>();

  // FAM：遍历 normalized_path 索引，重新按 source_path / file_name_lower 分组
  for (const [, byProp] of state.cachedLineFamProperties) {
    for (const [, records] of byProp) {
      for (const rec of records) {
        // by source_path
        let spMap = famBySourcePath.get(rec.source_path);
        if (!spMap) {
          spMap = new Map<string, LineFamPropertyRecord[]>();
          famBySourcePath.set(rec.source_path, spMap);
        }
        let spList = spMap.get(rec.prop_key);
        if (!spList) {
          spList = [];
          spMap.set(rec.prop_key, spList);
        }
        spList.push(rec);

        // by file_name_lower
        let fnMap = famByFileNameLower.get(rec.file_name_lower);
        if (!fnMap) {
          fnMap = new Map<string, LineFamPropertyRecord[]>();
          famByFileNameLower.set(rec.file_name_lower, fnMap);
        }
        let fnList = fnMap.get(rec.prop_key);
        if (!fnList) {
          fnList = [];
          fnMap.set(rec.prop_key, fnList);
        }
        fnList.push(rec);
      }
    }
  }

  // DEV
  for (const [, byProp] of state.cachedLineDevProperties) {
    for (const [, records] of byProp) {
      for (const rec of records) {
        let spMap = devBySourcePath.get(rec.source_path);
        if (!spMap) {
          spMap = new Map<string, LineDevPropertyRecord[]>();
          devBySourcePath.set(rec.source_path, spMap);
        }
        let spList = spMap.get(rec.prop_key);
        if (!spList) {
          spList = [];
          spMap.set(rec.prop_key, spList);
        }
        spList.push(rec);

        let fnMap = devByFileNameLower.get(rec.file_name_lower);
        if (!fnMap) {
          fnMap = new Map<string, LineDevPropertyRecord[]>();
          devByFileNameLower.set(rec.file_name_lower, fnMap);
        }
        let fnList = fnMap.get(rec.prop_key);
        if (!fnList) {
          fnList = [];
          fnMap.set(rec.prop_key, fnList);
        }
        fnList.push(rec);
      }
    }
  }

  return { famBySourcePath, famByFileNameLower, devBySourcePath, devByFileNameLower };
}
