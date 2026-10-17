import type { FamSourceProperty } from './famParser.js';
import type { CbmNode } from './types.js';
export type BusinessCategory = 'device' | 'component' | 'conductor' | 'grounding' | 'structure' | 'appliance' | 'placeholder' | 'other';
export interface BusinessClassification { category: BusinessCategory; evidence: string[]; rule: string; conflict: boolean; famEvidence: readonly FamSourceProperty[] }
/** Classification is a projection of source labels; it never filters physical geometry. */
const rules: [BusinessCategory, string, RegExp][] = [
    ['placeholder','source-placeholder', /(?:^|\s)(?:22\?|NAIZHANG)(?:$|\s)|^\s*null\d*\s*$/i],
    ['component','explicit-component', /操动机构|操作机构|机构箱|端子板|本体端子箱|避雷器计数器|土建接口|支柱绝缘子|金具|套管|电缆终端|母线筒|网栏|网门|主变本体|变压器本体|分接开关|散热器|气体继电器|储油柜|油枕/],
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

/** Business grouping consumes source semantics, independently of CBM depth.
 * Explicit secondary systems stay separate from primary voltage equipment. */
export function projectSubstationSystemNames(names: string[]): string[] {
  if (names.length < 2 || !/电气系统$/.test(names[0])) return names;
  const [domain, unit, ...bays] = names;
  if (/主变|变压器系统/.test(unit)) return [domain, '主变压器系统', ...bays];
  if (/接地|防雷/.test(unit) || bays.some(name => /^(?:防雷)?接地系统$/.test(name)))
    return [domain, '电缆及接地', ...bays];
  const secondary = /监控|保护|测控|测量|直流|表计|通信|远动|调度|录波|电源|辅控|报警|时钟|电能量采集/;
  if (secondary.test(unit)) return [domain, '控制及直流/二次系统', unit, ...bays];
  if (bays.some(name => secondary.test(name))) return [domain, '控制及直流/二次系统', ...bays];
  return names;
}

const naturalOrder = new Intl.Collator('zh-CN', {numeric:true,sensitivity:'base'});
export function compareSubstationNames(a: string, b: string): number {
  const unitRank = (name:string) => name === '主变压器系统' ? 0 : /kV系统$/i.test(name) ? 1
    : name === '控制及直流/二次系统' ? 2 : name === '电缆及接地' ? 3 : /跨电压等级/.test(name) ? 4 : 5;
  const rank = unitRank(a) - unitRank(b);
  if (rank) return rank;
  if (unitRank(a) === 1) return Number(b.match(/[\d.]+/)?.[0]) - Number(a.match(/[\d.]+/)?.[0]) || naturalOrder.compare(a,b);
  const transformer = (name:string) => name.match(/^[#＃]?(\d+)号(?:备用)?主变(?:压器)?(本体系统|中性点设备)$/);
  const ta=transformer(a),tb=transformer(b);
  if(ta&&tb)return Number(ta[1])-Number(tb[1]) || Number(ta[2]==='中性点设备')-Number(tb[2]==='中性点设备') || naturalOrder.compare(a,b);
  // Compare like bay families together, then their numeric identifiers.
  const familyRank = (name:string) => /PT|互感器/i.test(name) ? 0 : /出线/.test(name) ? 1 : /进线/.test(name) ? 2 : 3;
  const family = (name:string) => /PT|互感器/i.test(name) ? 'PT' : name.replace(/[#＃]?\d+(?:\.\d+)?/g,'#');
  return familyRank(a) - familyRank(b) || naturalOrder.compare(family(a),family(b)) || naturalOrder.compare(a,b);
}
