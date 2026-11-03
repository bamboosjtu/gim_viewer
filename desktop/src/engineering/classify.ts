import rules from './catalogRules.json';
import type { ObjectEvidence, ObjectInterpretation, SourceComponentRole } from './types.js';

export const ENGINEERING_RULES_VERSION = rules.version;
const nameRules = rules.nameRules.map(([category, pattern]) => ({ category, regex: new RegExp(pattern, 'i') }));
const part = new RegExp(rules.part);
const independent = new RegExp(rules.independent);
const group = new RegExp(rules.group, 'i');
const sourceOnly = new RegExp(rules.sourceOnly);
const c1Roles = (rules.c1Roles ?? []).map(([role, pattern]) => ({ role: role as SourceComponentRole, regex: new RegExp(pattern) }));

export function categoryFromName(name: string): string {
  const compact = name.replace(/\s+/g, '');
  return nameRules.find(rule => rule.regex.test(compact))?.category ?? 'U-OBJECT';
}

export function mainNumber(value: string): string {
  const match = value.match(/(?:#\s*(\d+)\s*(?:备用|预留)?主变)|(?:(\d+)\s*(?:号|#)\s*(?:备用|预留)?主变)|(?:主变(?:系统)?\s*(\d+))/);
  return match ? String(Number(match.slice(1).find(Boolean))) : '';
}

export function explicitMain(object: ObjectEvidence): string {
  const tokens = new Set(object.designations.map(p => mainNumber(p.value)).filter(Boolean));
  return tokens.size === 1 ? [...tokens][0] : '';
}

export function isNumberedDesignation(value: string): boolean {
  const text = value.replace(/(?:AC|DC)?\d+(?:\.\d+)?\s*(?:kV|千伏)|模型\d+|\d+(?:[x×*]\d+)+/gi, '');
  // Unicode-aware boundary: JS \b differs from Python after Chinese characters.
  return /#\s*\d+|\d+\s*(?:号|#)|(?:主变|组合电器|避雷器|互感器|电抗器组|电容器组|开关柜|屏柜|设备|装置|支架|基础)\s*\d+(?![\p{L}\p{N}_])|[ⅠⅡⅢⅣⅤ]/u.test(text);
}

/** Object role precedes local property names that may describe the upper assembly. */
export function interpretObject(object: ObjectEvidence, hasChildren = false): ObjectInterpretation {
  const name = object.name.trim();
  const prefix = name.match(/^(.+?模型\d+)[_－](.+)$/);
  const assemblyCategory = prefix ? categoryFromName(prefix[1]) : '';
  const fragment = !!prefix && assemblyCategory.startsWith('E');
  const ownName = fragment ? prefix![2] : name;
  const isIndependent = independent.test(ownName);
  const result = (meaning: ObjectInterpretation['meaning'], basis: string, category = ''): ObjectInterpretation => ({
    category, meaning, basis, conflict: '', independent: false, assemblyCategory: '', assemblySignature: '',
  });
  const fragmentResult = (basis: string): ObjectInterpretation => ({
    ...result('fragment', basis), assemblyCategory, assemblySignature: prefix![1],
  });
  if (object.traits.nonphysical || sourceOnly.test(name)) return result('source_only', 'nonphysical_or_interface');
  if (object.traits.fastener) return result('detail', 'internal_fastener');
  if (group.test(name) && hasChildren && object.traits.assemblyContainer) return result('container', 'source_container');
  if (part.test(ownName) && !isIndependent) {
    return fragment ? fragmentResult('declared_design_fragment') : result('part', 'component_head');
  }
  if (/中性点(?:成套(?:设备|装置)?|装置|设备)/.test(name) || object.typeCategory === 'neutral_set') {
    return result('neutral_set', 'neutral_set_identity', 'E01');
  }
  const named = categoryFromName(isIndependent ? ownName : name);
  const typed = object.typeCategory === 'E01' ? 'E-T' : object.typeCategory;
  const propertyCategory = object.identityNames.map(p=>categoryFromName(p.value)).find(category=>category!=='U-OBJECT');
  let category = typed ?? propertyCategory ?? named;
  let basis = typed ? 'type' : propertyCategory ? 'family_identity' : named !== 'U-OBJECT' ? 'object_name' : 'unknown';
  // A generic secondary type can be refined to its cabinet role, but a name
  // containing 主变 must never turn a SecondaryCabinet into a transformer.
  if (typed === 'E16' && (propertyCategory?.startsWith('E16.') || named.startsWith('E16.'))) { category=propertyCategory?.startsWith('E16.')?propertyCategory:named;basis='secondary_type+identity'; }
  if (typed === 'E-T' && ['E01','E03'].includes(propertyCategory??named)) { category=propertyCategory??named;basis='transformer_type+purpose'; }
  if(typed?.startsWith('C') && (propertyCategory?.startsWith('C') || named.startsWith('C'))) {category=propertyCategory?.startsWith('C')?propertyCategory:named;basis='component_type+purpose';}
  if (object.traits.materialType && typed?.startsWith('M') && !isIndependent) {
    category = typed; basis = 'material_type';
  }
  if (isIndependent && (!typed||typed==='E09'&&named.startsWith('E16.'))) { category = propertyCategory ?? named; basis = propertyCategory?'family_identity':'independent_function_head'; }
  if ((category === 'E-T' || category === 'E01') && explicitMain(object)) category = 'E01';
  if (category === 'E-T' && name.includes('主变')) category = 'E01';
  if (category === 'U-OBJECT') {
    for (const property of object.identityNames) {
      const alternative = categoryFromName(property.value);
      if (alternative !== 'U-OBJECT' && !part.test(name)) { category = alternative; basis = 'family_identity_candidate'; break; }
    }
  }
  // A source that carries a material trait but no specific material noun is
  // still a material whole, not an unknown object; M07 is the documented
  // "other material" bucket. Without that trait U-OBJECT remains correct.
  if (category === 'U-OBJECT' && object.traits.materialType) { category = 'M07'; basis = 'material_type_fallback'; }
  const role = category === 'C-C1' ? c1Roles.find(item => item.regex.test(ownName))?.role : undefined;
  return {
    category,
    meaning: fragment && !isIndependent && !['C-B1', 'C-B2'].includes(category) ? 'fragment' : 'object',
    basis,
    conflict: typed && category !== 'U-OBJECT' && category !== typed && !(typed === 'E-T' && ['E01', 'E03'].includes(category)) && !(typed==='E16'&&category.startsWith('E16.')) && !(typed.startsWith('C')&&category.startsWith('C')) ? `${typed}!=${category}` : '',
    independent: isIndependent || !!typed?.startsWith('E16'),
    ...(role ? { role } : {}),
    assemblyCategory: fragment ? assemblyCategory : '',
    assemblySignature: fragment ? prefix![1] : '',
  };
}
