import { normalizeGimPath } from '@gim/powerline-core/linePathNormalize.js';
import type { LineNavigationIndex, LineNavigationNode } from './lineNavigationProjection.js';

/** 把搜索/地图传入的业务键或来源 path 解析到渲染行键。 */
export function resolveLineNavigationTarget(
  index: LineNavigationIndex,
  key: string,
): LineNavigationNode | null {
  const row = index.nodesByKey.get(key);
  if (row) return row;
  const normalized = normalizeGimPath(key);
  const sourcePath = normalized.includes('/')
    ? normalized
    : index.sourcePathByBasename.get(normalized.toLowerCase());
  const rowKey = sourcePath && findExactSourceTargetKey(index.targetBySourcePath, sourcePath);
  return rowKey ? (index.nodesByKey.get(rowKey) ?? null) : null;
}

export function findExactSourceTargetKey(
  targetBySourcePath: Map<string, string>,
  sourcePath: string,
): string | undefined {
  const direct = targetBySourcePath.get(sourcePath);
  if (direct) return direct;
  const normalized = normalizeGimPath(sourcePath).replace(/^\.\//, '');
  return targetBySourcePath.get(normalized) ?? targetBySourcePath.get(normalized.toLowerCase());
}

/** 在所有投影行完成后补齐父链，覆盖懒加载明细（塔位、档距、导线、跨越物）。 */
