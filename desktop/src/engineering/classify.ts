import rules from './catalogRules.json';
import type { ObjectEvidence, ObjectInterpretation } from './types.js';

export const ENGINEERING_RULES_VERSION = rules.version;
const nameRules = rules.nameRules.map(([category, pattern]) => ({ category, regex: new RegExp(pattern, 'i') }));
const part = new RegExp(rules.part);
const independent = new RegExp(rules.independent);
const group = new RegExp(rules.group, 'i');
const sourceOnly = new RegExp(rules.sourceOnly);

export function categoryFromName(name: string): string {
  const compact = name.replace(/\s+/g, '');
  return nameRules.find(rule => rule.regex.test(compact))?.category ?? 'U-OBJECT';
}

export function mainNumber(value: string): string {
  const match = value.match(/(?:#\s*(\d+)\s*主变)|(?:(\d+)\s*(?:号|#)\s*主变)|(?:主变(?:系统)?\s*(\d+))/);
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
  let category = named === 'U-OBJECT' && typed ? typed : named;
  let basis = named === 'U-OBJECT' ? (typed ? 'type' : 'unknown') : 'object_name';
  if (object.traits.materialType && typed?.startsWith('M') && !isIndependent) {
    category = typed; basis = 'material_type';
  }
  if (isIndependent) { category = named; basis = 'independent_function_head'; }
  if ((category === 'E-T' || category === 'E01') && explicitMain(object)) category = 'E01';
  if (category === 'E-T' && name.includes('主变')) category = 'E01';
  if (category === 'U-OBJECT') {
    for (const property of object.identityNames) {
      const alternative = categoryFromName(property.value);
      if (alternative !== 'U-OBJECT' && !part.test(name)) { category = alternative; basis = 'family_identity_candidate'; break; }
    }
  }
  return {
    category,
    meaning: fragment && !isIndependent && !['C-B1', 'C-B2'].includes(category) ? 'fragment' : 'object',
    basis,
    conflict: typed && category !== 'U-OBJECT' && category !== typed && !(typed === 'E-T' && ['E01', 'E03'].includes(category)) ? `${typed}!=${category}` : '',
    independent: isIndependent,
    assemblyCategory: fragment ? assemblyCategory : '',
    assemblySignature: fragment ? prefix![1] : '',
  };
}
