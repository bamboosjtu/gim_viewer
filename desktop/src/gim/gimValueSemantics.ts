/**
 * GIM 文本字段的跨导出器值语义。
 *
 * GIM 的文本键名和空值写法没有完全统一。这个小模块只负责把“字段
 * 如何取值”从各个变电解析器中集中出来；它不是 parser framework，也
 * 不改变调用方保存的原始键名/路径。
 */

export type GimKv = Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>;

/** GIM 中表示“没有有效值”的约定 sentinel（比较前 trim 且不区分大小写）。 */
export const GIM_EMPTY_SENTINELS = Object.freeze(new Set(['', '/', '-', 'null']));

/**
 * 判断值是否为 GIM 空值。
 *
 * 注意 0、0.0 和 false 是有效业务值，不能按 JavaScript truthiness 过滤。
 */
export function isGimEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return GIM_EMPTY_SENTINELS.has(value.trim().toLowerCase());
  return false;
}

/** 按键名大小写不敏感读取 KV；返回原始值，不把 sentinel 转换掉。 */
export function getCaseInsensitiveKv(kv: GimKv, key: string): unknown {
  if (kv instanceof Map) {
    const exact = kv.get(key);
    if (exact !== undefined) return exact;
    const wanted = key.toLowerCase();
    for (const [candidate, value] of kv) {
      if (candidate.trim().toLowerCase() === wanted) return value;
    }
    return undefined;
  }

  const record = kv as Readonly<Record<string, unknown>>;
  if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  const wanted = key.toLowerCase();
  const candidate = Object.keys(record).find((name) => name.trim().toLowerCase() === wanted);
  return candidate === undefined ? undefined : record[candidate];
}

/** 返回 keys 中第一个非空有效字段，结果统一 trim；没有则返回空字符串。 */
export function getFirstNonEmptyKv(kv: GimKv, keys: readonly string[]): string {
  for (const key of keys) {
    const value = getCaseInsensitiveKv(kv, key);
    if (!isGimEmptyValue(value)) return String(value).trim();
  }
  return '';
}

/**
 * 统一解析变电 DEV/CBM 的 FAM 引用。
 *
 * 现有四样本分别使用 BASEFAMILY 或 BASEFAMILYPOINTER；当两个键同时
 * 存在时，空值不遮蔽另一个键的有效引用。
 */
export function resolveBaseFamilyReference(kv: GimKv): string {
  return getFirstNonEmptyKv(kv, ['BASEFAMILY', 'BASEFAMILYPOINTER']);
}
