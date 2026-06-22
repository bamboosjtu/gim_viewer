/**
 * 解析器统一资源上限。
 *
 * GIM 的 NUM 字段来自外部归档，不能直接作为循环边界；引用图也可能
 * 含有环或极深嵌套。上限足以覆盖现有样本，同时保证恶意/损坏文件不会
 * 让 UI 线程陷入无界循环或递归。
 */
export const PARSER_LIMITS = Object.freeze({
  maxArrayItems: 100_000,
  maxCbmNodes: 200_000,
  maxLineNodes: 200_000,
  maxRecursionDepth: 512,
  maxGeometryInstances: 500_000,
  maxGeometryQueue: 500_000,
});

export function parseBoundedCount(raw: string | undefined, field: string, max = PARSER_LIMITS.maxArrayItems): number {
  if (raw == null || raw.trim() === '') return 0;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value > max) {
    throw new Error(`${field} 超过安全上限 ${max}`);
  }
  return value;
}
