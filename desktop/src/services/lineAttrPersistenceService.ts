/**
 * 线路工程属性 payload 的大小估算。
 *
 * FAM/DEV 属性的实际解析由 powerline-core 的 `lineAttrParserCore` 在
 * Worker 内完成；这里只保留持久化前的有界大小估算。
 */
import type {
  LineFamPropertyPayload,
  LineDevPropertyPayload,
} from '@desktop/database.js';

/** 估算 payload 序列化后的 JSON 大小（MB），用于性能日志和风险控制 */
export function estimatePayloadSizeMB(
  graphPayloadJson: string,
  famPayloads: LineFamPropertyPayload[],
  devPayloads: LineDevPropertyPayload[],
): number {
  // graph payload 已序列化为 JSON 字符串，直接取长度
  const graphBytes = graphPayloadJson.length;
  // FAM/DEV payload 未序列化，估算（每个字段平均长度 × 数量）
  let attrBytes = 0;
  for (const p of famPayloads) {
    attrBytes += (p.source_path.length + p.normalized_path.length + p.file_name_lower.length
      + (p.display_key?.length ?? 0) + p.prop_key.length + (p.prop_value?.length ?? 0)
      + (p.raw_line?.length ?? 0) + 64);
  }
  for (const p of devPayloads) {
    attrBytes += (p.source_path.length + p.normalized_path.length + p.file_name_lower.length
      + p.prop_key.length + (p.prop_value?.length ?? 0) + (p.raw_line?.length ?? 0) + 48);
  }
  return (graphBytes + attrBytes) / (1024 * 1024);
}
