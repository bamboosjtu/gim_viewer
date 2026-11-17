/**
 * GIM 只读展示选择器入口，供 UI 使用。
 *
 * 只暴露路径查找和字段显示所需的纯选择器，
 * 不通过 shared/ 绕过 parser 边界。
 */

export { getFileByPath } from '../gim/fileLookup.js';
export { getFirstNonEmptyKv, isGimEmptyValue } from '../gim/gimValueSemantics.js';
