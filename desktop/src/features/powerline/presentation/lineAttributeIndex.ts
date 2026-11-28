import type { ProjectPropertyCache } from '../../../services/project/projectPropertyCache.js';
import type { LineFamPropertyRecord, LineDevPropertyRecord } from '@gim/contracts-native';
import type { LineAttributeIndex } from '@gim/powerline-core/lineAttributeTypes.js';

interface LinePropertyState {
  properties: Pick<
    ProjectPropertyCache,
    'cachedLineFamProperties' | 'cachedLineFamDisplayKeys' | 'cachedLineDevProperties'
  >;
}

/**
 * 从 AppState.cachedLine* 构建按 source_path / file_name_lower 的查找索引。
 *
 * cachedLineFamProperties 按 normalized_path 索引，M3-4 地图数据提取时
 * 需要按 source_path 或 file_name_lower 查找，因此提供此转换函数。
 *
 * @param state 已恢复线路属性的应用状态
 */
export function buildLineAttributeIndex(state: LinePropertyState): LineAttributeIndex {
  const famBySourcePath = new Map<string, Map<string, LineFamPropertyRecord[]>>();
  const famByFileNameLower = new Map<string, Map<string, LineFamPropertyRecord[]>>();
  const devBySourcePath = new Map<string, Map<string, LineDevPropertyRecord[]>>();
  const devByFileNameLower = new Map<string, Map<string, LineDevPropertyRecord[]>>();

  // FAM：遍历 normalized_path 索引，重新按 source_path / file_name_lower 分组
  for (const [, byProp] of state.properties.cachedLineFamProperties) {
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
  for (const [, byProp] of state.properties.cachedLineDevProperties) {
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

/** Only use spacing evidence belonging to this node's referenced FAM. A bare duplicate is ambiguous. */
export function lineBundleSpacing(
  index: LineAttributeIndex,
  refs: readonly string[],
  ownerPath: string,
) {
  const found = new Map<string, { mm: number; path: string }>();
  for (const ref of refs) {
    const path = ref.replace(/\\/g, '/').toLowerCase(),
      dir = ownerPath.replace(/\\/g, '/').toLowerCase().split('/').slice(0, -1).join('/');
    const exact = index.famBySourcePath.get(path) ?? index.famBySourcePath.get(dir + '/' + path);
    const bucket = exact ?? (!path.includes('/') ? index.famByFileNameLower.get(path) : undefined);
    if (!bucket) continue;
    const records = [...bucket.values()].flat();
    if (!exact && new Set(records.map((r) => r.normalized_path)).size !== 1) continue;
    for (const r of records)
      if (r.prop_key.toUpperCase() === 'BUNDLESPACING' && Number(r.prop_value) > 0)
        found.set(r.normalized_path + '|' + r.prop_value, {
          mm: Number(r.prop_value),
          path: r.source_path,
        });
  }
  return found.size === 1 ? [...found.values()][0] : undefined;
}
