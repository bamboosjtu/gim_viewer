/** CROSS classification uses its own FAM keys; values, DEV tags and MOD codes do not select a kind. */
export const CROSSING_LABELS = {
  powerline: '电力线', building: '房屋', tree: '树木', road: '公路', railway: '铁路',
  river: '河流', 'underground-communication-cable': '地下通信电缆', unknown: '未分类跨越物',
} as const;
export type CrossingKind = keyof typeof CROSSING_LABELS;
export interface CrossingFamAttribute { key: string; label?: string | null; value?: string | null; source?: string }
export interface CrossingDetail { label: string; key: string; value: string; source?: string }
export interface CrossingClassification {
  kind: CrossingKind; label: string; status: 'identified' | 'unknown' | 'conflict';
  matchedKinds: CrossingKind[]; evidence: CrossingFamAttribute[];
  name?: string; details: CrossingDetail[];
}
const normalize = (key: string) => key.trim().toUpperCase();
const aliases = (a: CrossingFamAttribute) => [normalize(a.key), normalize(a.label ?? '')];
const matches = (a: CrossingFamAttribute, keys: readonly string[]) => aliases(a).some(k => keys.includes(k));
const distinctiveKeys: Partial<Record<CrossingKind, readonly string[]>> = {
  powerline: ['电压等级', 'VOLTAGE', 'MAXTEMPERATUREKVALUE', 'MINTEMPERATUREKVALUE', 'AVERAGETEMPERATUREKVALUE', 'WINDKVALUE', '高温K值', '低温K值', '年平K值', '大风K值'],
  building: ['房屋高度', '屋顶类型', '房屋种类', '房屋面积', '附院面积', '附房面积', 'ROOFTYPE', 'HOUSETYPE', 'HOUSEAREA', 'ATTACHEDHOUSEAREA', 'ATTACHEDYARDAREA', 'FLOOR'],
  tree: ['树高', '树木种类', '密度', 'TREETYPE', 'DENSITY'],
  road: ['公路等级', '公路名称', '车道数', '路宽'],
  railway: ['铁路等级', '铁路名称', '接触网高', '路基宽'],
  river: ['水位高', '是否通航', '桅杆高', '100年洪水位', '5年洪水位', 'WATERLEVEL', 'BOART', 'CENTURYWATERLEVEL', '5YEARWATERLEVEL', '50YEARWATERLEVELBOART'],
};
const detailKeys: Partial<Record<CrossingKind, [string, string[]][]>> = {
  powerline: [['电压等级', ['电压等级', 'VOLTAGE']]],
  building: [['房屋高度', ['房屋高度', 'HIGH']], ['屋顶类型', ['屋顶类型', 'ROOFTYPE']], ['层数', ['层数', 'FLOOR']], ['房屋种类', ['房屋种类', 'HOUSETYPE']]],
  tree: [['树木种类', ['树木种类', 'TREETYPE']], ['树高', ['树高', 'HIGH']], ['密度', ['密度', 'DENSITY']]],
  road: [['公路等级', ['公路等级', 'GRADE']], ['车道数', ['车道数']], ['路宽', ['路宽', 'WIDE']]],
  railway: [['铁路等级', ['铁路等级']], ['接触网高', ['接触网高']], ['路基宽', ['路基宽', 'WIDE']]],
  river: [['是否通航', ['是否通航', 'BOART']], ['宽度', ['宽度', 'WIDE']], ['水位高', ['水位高', 'WATERLEVEL']]],
  'underground-communication-cable': [['等级', ['等级', 'GRADE']]],
};

export function classifyCrossing(attributes: readonly CrossingFamAttribute[]): CrossingClassification {
  // Do not combine two incomplete FAMs into a fabricated signature. Duplicate sources remain evidence.
  const groups = new Map<string, CrossingFamAttribute[]>();
  for (const a of attributes) { const bucket = groups.get(a.source ?? '') ?? []; bucket.push(a); groups.set(a.source ?? '', bucket); }
  const matched = new Map<CrossingKind, CrossingFamAttribute[]>();
  for (const rows of groups.values()) {
    for (const [kind, keys] of Object.entries(distinctiveKeys)) {
      let hits = rows.filter(a => matches(a, keys));
      // With no display labels, GRADE/NAME/WIDE together distinguish the registered road family.
      if (kind === 'road' && !hits.length && ['GRADE', 'NAME', 'WIDE'].every(key => rows.some(a => normalize(a.key) === key))) hits = rows.filter(a => ['GRADE', 'NAME', 'WIDE'].includes(normalize(a.key)));
      if (hits.length) matched.set(kind as CrossingKind, [...(matched.get(kind as CrossingKind) ?? []), ...hits]);
    }
    // GRADE alone also belongs to roads. Only the exact two-field family with the generic Chinese
    // "等级" label is evidence for the registered underground communication cable samples.
    const cable = rows.every(a => matches(a, ['等级', 'GRADE', '权属', 'OWNERSHIP']))
      && rows.some(a => normalize(a.label ?? a.key) === '等级')
      && rows.some(a => matches(a, ['权属', 'OWNERSHIP']));
    if (cable) matched.set('underground-communication-cable', [...(matched.get('underground-communication-cable') ?? []), ...rows]);
  }
  const matchedKinds = [...matched.keys()];
  const status = matchedKinds.length === 1 ? 'identified' : matchedKinds.length ? 'conflict' : 'unknown';
  const kind = status === 'identified' ? matchedKinds[0] : 'unknown';
  const result: CrossingClassification = { kind, label: status === 'conflict' ? '类型冲突' : CROSSING_LABELS[kind], status, matchedKinds, evidence: [...matched.values()].flat(), details: [] };
  if (status !== 'identified') return result;
  const sources = new Set(result.evidence.map(a => a.source ?? ''));
  const rows = attributes.filter(a => sources.has(a.source ?? ''));
  const names = [...new Set(rows.filter(a => matches(a, ['NAME', 'CROSSNAME', '名称', '公路名称', '铁路名称']))
    .map(a => a.value?.trim()).filter((v): v is string => !!v && !/^(?:-|\$|NULL\d*|其它|其他|&其他|无|未命名)$/i.test(v)))];
  if (names.length === 1) result.name = names[0];
  for (const [label, keys] of [...(detailKeys[kind] ?? []), ['权属', ['权属', 'OWNERSHIP']] as [string, string[]]]) {
    const fields = rows.filter(a => matches(a, keys));
    if (!fields.length) continue;
    const values = [...new Set(fields.map(a => a.value?.trim() ?? ''))];
    result.details.push({ label, key: fields[0].key, value: values.join(' / '), source: fields[0].source });
  }
  if (kind === 'powerline' && !result.details.some(a => a.label === '电压等级' && a.value) && result.name) {
    const voltage = result.name.match(/(?:^|[^\d.])(\d+(?:\.\d+)?\s*(?:kV|V))\b/i)?.[1];
    if (voltage) result.details.push({ label: '电压（名称）', key: 'NAME', value: voltage, source: rows.find(a => a.value?.trim() === result.name)?.source });
  }
  return result;
}
