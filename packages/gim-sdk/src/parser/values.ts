/**
 * Value sentinels shared by GIM text parsers.
 *
 * GIM exporters disagree on how an empty field is spelled. This module only
 * classifies the raw spelling; it does not rewrite or normalize the value.
 */

export const GIM_EMPTY_SENTINELS = Object.freeze(
  new Set(["", "/", "-", "null"]),
);

/**
 * Whether a raw GIM value is an empty sentinel.
 *
 * Zero, `0.0` and `false` are valid business values and must not be removed by
 * JavaScript truthiness checks.
 */
export function isGimEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string")
    return GIM_EMPTY_SENTINELS.has(value.trim().toLowerCase());
  return false;
}
