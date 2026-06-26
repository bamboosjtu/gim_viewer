/**
 * 线路工程 FAM/DEV 属性查找索引类型（纯数据契约）。
 *
 * 分层说明：
 * - 此文件属于 gim/ 纯逻辑层，定义 M3-4 地图数据提取所需的属性查找索引结构。
 * - 从 desktop/database.ts 仅 type-only 导入 LineFamPropertyRecord / LineDevPropertyRecord
 *   这两个数据契约类型（它们镜像 Tauri 命令载荷，是该记录的权威定义）。
 * - services/lineAttrRestoreService.ts 负责构建该索引（buildLineAttributeIndex），
 *   gim/lineMapData.ts 仅消费它（extractLineMapData 入参）。
 *   将类型放在 gim 层可消除 gim/ → services/ 的反向依赖。
 */

import type {
  LineFamPropertyRecord,
  LineDevPropertyRecord,
} from '../desktop/database.js';

/** 线路属性查找索引（供 M3-4 地图数据提取使用） */
export interface LineAttributeIndex {
  /** FAM 按 source_path 索引 */
  famBySourcePath: Map<string, Map<string, LineFamPropertyRecord[]>>;
  /** FAM 按 file_name_lower 索引 */
  famByFileNameLower: Map<string, Map<string, LineFamPropertyRecord[]>>;
  /** DEV 按 source_path 索引 */
  devBySourcePath: Map<string, Map<string, LineDevPropertyRecord[]>>;
  /** DEV 按 file_name_lower 索引 */
  devByFileNameLower: Map<string, Map<string, LineDevPropertyRecord[]>>;
}
