import type { FamSourceProperty } from './famParser.js';
import type { CbmNode } from './types.js';
export type BusinessCategory = 'device' | 'component' | 'conductor' | 'grounding' | 'structure' | 'appliance' | 'placeholder' | 'other';
export interface BusinessClassification { category: BusinessCategory; evidence: string[]; rule: string; conflict: boolean; famEvidence: readonly FamSourceProperty[] }
/** Classification is a projection of source labels; it never filters physical geometry. */
const rules: [BusinessCategory, string, RegExp][] = [
    ['placeholder','source-placeholder', /(?:^|\s)(?:22\?|NAIZHANG)(?:$|\s)|^\s*null\d*\s*$/i],
    ['component','explicit-component', /操动机构|操作机构|端子板|土建接口|支柱绝缘子|金具|套管|电缆终端|母线筒|网栏|网门|主变本体|变压器本体|分接开关|散热器|气体继电器|储油柜|油枕/],
    ['grounding','grounding-lightning', /避雷带|接地网|接地极|接地线|避雷针|接地母线/],
    ['device','independent-electrical-unit', /断路器|隔离开关|接地开关|电流互感器|电压互感器|组合互感器|避雷器|主变|变压器|接地变|消弧线圈|电容器|电抗器|真空开关|开关柜|屏柜|汇控柜|保护柜|测控柜|通信柜|控制柜|端子箱/],
    ['conductor','linear-conductor', /导线|电缆|母线/],
    ['structure','structural-frame', /构架|钢架|支架/],
    ['appliance','building-appliance', /灯具|照明灯|投光灯/],
  ];
function match(text: string): {category:BusinessCategory;rule:string} {
  for (const [category,rule,pattern] of rules) if (pattern.test(text)) return {category,rule};
  return {category:'other',rule:'insufficient-evidence'};
}
export function classifySubstationNode(node: CbmNode, fam: readonly FamSourceProperty[] = []): BusinessClassification {
  const evidence = [node.name,node.devSymbolName,node.classifyName].filter(Boolean);
  // Only explicit name/type properties inform classification; ratings and component lists do not.
  const famEvidence = fam.filter(row => /^(?:设备名称|设备类型|构件名称|对象名称|名称|类型|SYMBOLNAME|DEVICETYPE|NAME|TYPE)$/i.test(row.label || row.rawKey));
  const primary = match(evidence.join(' '));
  const corroboration = famEvidence.map(row=>match(row.rawValue)).filter(row=>row.category!=='other');
  const candidates = new Set(corroboration.map(row=>row.category));
  const conflict = candidates.size>1 || primary.category!=='other' && corroboration.some(row=>row.category!==primary.category);
  const result = primary.category==='other' && candidates.size===1 ? corroboration[0] : primary;
  return {...result,evidence,conflict,famEvidence};
}
