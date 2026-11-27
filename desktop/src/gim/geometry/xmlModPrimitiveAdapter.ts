/** Non-standard provider spellings and the document's Boolean composition nodes. */
import { parseXmlModEntityId } from '@gim/gim-sdk/parser';
import type { XmlModPrimitive } from './ir.js';

export function mapXmlModPrimitive(
  tagName: string,
  attrs: Record<string, string>,
): XmlModPrimitive {
  const unsupported = { type: 'Unsupported' as const, sourceType: tagName, raw: attrs };
  switch (tagName.trim().toLowerCase()) {
    case 'boolean': {
      const op = (attrs.Type ?? attrs.TYPE ?? '').trim().toLowerCase();
      const entity1 = parseXmlModEntityId(attrs.Entity1 ?? attrs.ENTITY1),
        entity2 = parseXmlModEntityId(attrs.Entity2 ?? attrs.ENTITY2);
      if (
        entity1 === undefined ||
        entity2 === undefined ||
        !['union', 'intersection', 'difference'].includes(op)
      )
        return unsupported;
      return {
        type: 'Boolean',
        entity1,
        entity2,
        op: op === 'union' ? 'Union' : op === 'intersection' ? 'Intersection' : 'Difference',
      };
    }
    case 'cable': {
      const points = [
        ...parsePoint(attrs.StartCoord ?? ''),
        ...parsePointArray(attrs.InflectionCoordArray ?? ''),
        ...parsePoint(attrs.EndCoord ?? ''),
      ];
      return { type: 'Cable', d: Number.parseFloat(attrs.D), inflectionPoints: points };
    }
    case 'doublechannelsteel':
      return {
        type: 'ChannelSteel',
        l: Number.parseFloat(attrs.L),
        model: attrs.Model ?? '',
        b: optNum(attrs, 'B'),
        h: optNum(attrs, 'H'),
        d: optNum(attrs, 'D'),
        t: optNum(attrs, 'T'),
      };
    case 'h-beam':
    case 'h':
    case 'lightbeamchannel':
    case 'beamchannel': {
      const name = tagName.toLowerCase();
      return {
        type: 'BeamChannelLike',
        family:
          name === 'beamchannel'
            ? 'BeamChannel'
            : name === 'lightbeamchannel'
              ? 'LightBeamChannel'
              : 'H',
        model: attrs.Model ?? '',
        length: Number.parseFloat(attrs.Length),
      };
    }
    default:
      return unsupported;
  }
}
/** 解析 "x,y,z;x,y,z;..." 分号分隔点序列为展平数组 [x,y,z,...]，非法 token 跳过 */
function parsePointArray(raw: string): number[] {
  const out: number[] = [];
  for (const token of raw.split(';')) {
    const tk = token.trim();
    if (!tk) continue;
    const parts = tk.split(',').map((s) => parseFloat(s));
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
      out.push(parts[0], parts[1], parts[2]);
    }
  }
  return out;
}

/** 解析单个 "x,y,z" 点为展平数组，格式异常返回空 */
function parsePoint(raw: string): number[] {
  const parts = raw.split(',').map((s) => parseFloat(s.trim()));
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) return parts;
  return [];
}
/** 解析可选数值字段（缺失返回 undefined） */
function optNum(attrs: Record<string, string>, key: string): number | undefined {
  if (!(key in attrs) || attrs[key] === '') return undefined;
  const v = parseFloat(attrs[key]);
  return Number.isNaN(v) ? undefined : v;
}
