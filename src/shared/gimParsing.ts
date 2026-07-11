/**
 * GIM 解析函数的门面（facade），供 ui 层调用。
 *
 * ui 层不直接导入 gim/ 解析器，统一通过 shared/ 层访问，
 * 避免 ui → gim 的直接依赖。
 */

export { parseFamSections } from '../gim/famParser.js';
export { parseKeyValue } from '../gim/cbmParser.js';
