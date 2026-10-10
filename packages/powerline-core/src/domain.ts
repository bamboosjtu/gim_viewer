import { buildLineGimGraphFromTexts } from './lineCbmParserCore.js';
import { LineParserTextCache, type LineParserTextFile } from './lineParserCache.js';
import { parseLineFam } from './lineFamParser.js';
import { parseKeyValue } from './kvParser.js';
import { parsePointLine, classifyLineMod } from './geometry/lineModParser.js';
import type { GimGraphNode } from './gimGraphTypes.js';

export const MOBILE_PARSER_VERSION = 'mobile-powerline-v2';
export const PREVIEW_VERSION = 'hnum-xz-v2';
export type Coordinate = [number, number, number?]; // longitude, latitude, elevation
export type ObjectKind = 'project' | 'line' | 'strain' | 'tower' | 'span' | 'cross';
export interface Finding { severity: 'INFO' | 'WARNING' | 'ERROR'; code: string; message: string; objectId?: string; source?: string }
export interface Attribute { label: string; key: string; value: string; source: string; raw?: string }
export interface BusinessObject {
  id: string; kind: ObjectKind; name: string; type?: string; sourcePath?: string;
  coordinate?: Coordinate; geometry?: Coordinate[]; sourceRefs: string[]; attributes: Attribute[];
  lineIds: string[]; strainIds: string[]; relatedIds: string[]; height?: string; azimuth?: number;
  startTowerId?: string; endTowerId?: string; horizontalMeters?: number; spatialMeters?: number;
  rawWireIds?: string[]; wireCounts?: Record<string, number>; previewRef?: string;
}
export interface RawWire { id: string; sourcePath: string; start?: Coordinate; end?: Coordinate; startTowerId?: string; endTowerId?: string; type: string; jumper: boolean; sourceRefs: string[]; attributes: Attribute[] }
export interface TreeNode { id: string; objectId: string; label: string; children: TreeNode[] }
export interface PowerlineProject {
  id: string; name: string; sourceSha256: string; sourceSize: number; parserVersion: string;
  objects: BusinessObject[]; rawWires: RawWire[]; tree: TreeNode; findings: Finding[];
  bounds?: [number, number, number, number]; geometryLengthMeters: number; counts: Record<ObjectKind, number>;
}
export interface ProjectIdentity { id: string; name: string; sha256: string; size: number }
const pathKey = (s: string) => s.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
const entity = (n: GimGraphNode) => n.entityName.toUpperCase();
const unique = <T>(values: T[]) => [...new Set(values)];
export function coordinateFromBlha(value?: string): Coordinate | undefined {
  if (!value) return;
  const tokens = value.split(',');
  if (tokens.length < 2 || !tokens[0].trim() || !tokens[1].trim()) return;
  const [lat, lon] = tokens.map(Number), elev = tokens[2]?.trim() ? Number(tokens[2]) : undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
  return Number.isFinite(elev) ? [lon, lat, elev] : [lon, lat];
}
export function horizontalDistance(a: Coordinate, b: Coordinate): number {
  const rad = Math.PI / 180;
  const v = Math.sin((b[1] - a[1]) * rad / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin((b[0] - a[0]) * rad / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, v)));
}

/** Shared projection: source records, unique business objects and occurrence tree are separate. */
export function buildPowerlineProject(files: LineParserTextFile[], identity: ProjectIdentity, progress?: (stage: string, done: number, total: number) => void): PowerlineProject {
  const cache = new LineParserTextCache(files);
  progress?.('解析工程结构', 0, files.length);
  const graph = buildLineGimGraphFromTexts(files, cache);
  if (!graph.root) throw new Error('工程没有可达的 project.cbm 入口');
  const nodes = [...graph.nodesByPath.values()];
  const nodeMap = new Map(nodes.map(n => [pathKey(n.path), n]));
  const byName = new Map<string, GimGraphNode[]>();
  for (const n of nodes) { const k = pathKey(n.path).split('/').pop()!; byName.set(k, [...(byName.get(k) ?? []), n]); }
  const resolveNode = (ref: string) => nodeMap.get(pathKey(ref)) ?? (byName.get(pathKey(ref).split('/').pop()!)?.length === 1 ? byName.get(pathKey(ref).split('/').pop()!)![0] : undefined);
  const findings: Finding[] = [];
  const missing = new Set<string>();
  const resolveFile = (ref: string): string | undefined => {
    const path = cache.resolveOriginalPath(ref);
    if (!path && !missing.has(ref)) { missing.add(ref); findings.push({ severity: 'WARNING', code: 'missing-reference', message: '引用文件缺失或存在歧义', source: ref }); }
    return path ?? undefined;
  };
  for (const node of nodes) for (const ref of node.refs.cbmFiles) if (!resolveNode(ref)) findings.push({ severity: 'WARNING', code: 'missing-cbm-reference', message: '结构引用目标缺失或存在歧义', source: node.path });
  // Reconstruct explicit containment, including a tower referenced by multiple strain sections.
  const children = (n: GimGraphNode): GimGraphNode[] => {
    const refs = Object.entries(n.rawProps).filter(([k, v]) => /^(SUBSYSTEM|SECTION\d+|STRAINSECTION\d+|GROUP\d+|TOWER\d+|BASE\d+|SUBDEVICE\d+|STRING\d+\.STRING)$/.test(k) && /\.cbm$/i.test(v)).map(([, v]) => resolveNode(v)).filter((v): v is GimGraphNode => !!v);
    return unique([...n.children, ...refs]);
  };
  const attrMemo = new Map<string, { attrs: Attribute[]; refs: string[]; mods: string[] }>();
  function evidence(n: GimGraphNode) {
    const old = attrMemo.get(n.path); if (old) return old;
    const refs = new Set<string>([n.path]);
    const mods: string[] = [];
    const attrs: Attribute[] = Object.entries(n.rawProps).map(([key, value]) => ({ label: key, key, value, source: n.path }));
    const visited = new Map<string, boolean>();
    const follow = (ref: string, depth = 0, ownAttributes = true) => {
      if (depth > 32) return;
      const actual = resolveFile(ref); if (!actual) return;
      const seen = visited.get(pathKey(actual)); if (seen === true || (seen === false && !ownAttributes)) return;
      visited.set(pathKey(actual), ownAttributes); refs.add(actual);
      if (/\.mod$/i.test(actual)) { mods.push(actual); return; }
      const text = cache.getText(actual); if (text == null) return;
      if (/\.fam$/i.test(actual)) {
        if (ownAttributes) for (const a of parseLineFam(text)) attrs.push({ label: a.display_key || a.prop_key, key: a.prop_key, value: a.prop_value ?? '', raw: a.raw_line ?? '', source: actual });
        return;
      }
      if (!/\.(dev|phm)$/i.test(actual)) return;
      const props = parseKeyValue(text);
      for (const [key, value] of Object.entries(props)) {
        // A bolt/insulator inside an assembly supplies source evidence, not tower properties.
        // Keep every referenced file, but project attributes only from the object's own DEV/FAM.
        if (ownAttributes && /\.dev$/i.test(actual)) attrs.push({ label: key, key, value, source: actual });
        if (/^(BASEFAMILY|SOLIDMODEL\d+|SUBDEVICE\d+)$/.test(key) && /\.(fam|dev|phm|mod)$/i.test(value)) follow(value, depth + 1, ownAttributes && /\.dev$/i.test(actual) && key === 'BASEFAMILY');
      }
    };
    for (const ref of [...n.refs.famFiles, ...n.refs.devFiles, ...n.refs.phmFiles, ...n.refs.modFiles]) follow(ref);
    const result = { attrs, refs: [...refs], mods: unique(mods) }; attrMemo.set(n.path, result); return result;
  }
  const pick = (attrs: Attribute[], keys: string[]) => {
    for (const key of keys) { const a = attrs.find(v => (v.key.toUpperCase() === key.toUpperCase() || v.label === key) && v.value.trim()); if (a) return a.value; }
    return undefined;
  };
  const objects: BusinessObject[] = [];
  const objectById = new Map<string, BusinessObject>();
  const nodeObjects = new Map<string, string>();
  const make = (n: GimGraphNode, kind: ObjectKind): BusinessObject => {
    const ev = evidence(n);
    const obj: BusinessObject = { id: `${kind}:${pathKey(n.path)}`, kind, name: pick(ev.attrs, ['NAME', '名称']) ?? n.name, sourcePath: n.path, sourceRefs: ev.refs, attributes: ev.attrs, lineIds: [], strainIds: [], relatedIds: [] };
    objects.push(obj); objectById.set(obj.id, obj); nodeObjects.set(pathKey(n.path), obj.id); return obj;
  };
  const projectObj = make(graph.root, 'project'); projectObj.name = pick(projectObj.attributes, ['PROJECTNAME', 'NAME']) ?? identity.name;
  for (const n of nodes) {
    if (entity(n) === 'F2SYSTEM') make(n, 'line');
    else if (entity(n) === 'F3SYSTEM') make(n, 'strain');
  }
  progress?.('建立杆塔索引', 0, nodes.length);
  const towerNodes = nodes.filter(n => entity(n) === 'F4SYSTEM' && n.rawProps.GROUPTYPE?.toUpperCase() === 'TOWER');
  const stringTowers = new Map<string, Set<string>>();
  for (const n of towerNodes) {
    const obj = make(n, 'tower');
    const devices = children(n).filter(c => entity(c) === 'TOWER_DEVICE');
    const towerRefs = new Set(Object.entries(n.rawProps).filter(([key]) => /^TOWER\d+$/.test(key)).map(([,ref]) => resolveNode(ref)?.path).filter(Boolean));
    for (const c of devices) {
      const ev = evidence(c); obj.sourceRefs.push(...ev.refs);
      const isTower = towerRefs.size ? towerRefs.has(c.path) : ev.attrs.some(a => a.key === 'DEVICETYPE' && a.value.toUpperCase() === 'TOWER') || ev.mods.some(p => /^\uFEFF?\s*HNum\s*,/im.test(cache.getText(p) ?? ''));
      if (isTower) obj.attributes.push(...ev.attrs);
    }
    obj.sourceRefs = unique(obj.sourceRefs);
    obj.name = pick(obj.attributes, ['TOWERNUMBER', 'TOWERNO', '杆塔编号', '塔号', 'NAME']) ?? n.name;
    obj.type = pick(obj.attributes, ['TYPE', '杆塔型号', '塔型', 'TOWERTYPE']);
    obj.height = pick(obj.attributes, ['NOMINALHEIGHT', '呼称高', 'TOWERHEIGHT', '杆塔高度', 'HEIGHT']);
    obj.coordinate = coordinateFromBlha(n.rawProps.BLHA); const azimuth = Number(n.rawProps.BLHA?.split(',')[3]); if (Number.isFinite(azimuth)) obj.azimuth = azimuth;
    const mods = unique([evidence(n).mods, ...children(n).filter(c => entity(c) === 'TOWER_DEVICE').map(c => evidence(c).mods)].flat());
    obj.previewRef = mods.find(p => /^\uFEFF?\s*HNum\s*,/im.test(cache.getText(p) ?? ''));
    for (const [k, ref] of Object.entries(n.rawProps)) if (/^STRING\d+\.STRING$/.test(k)) {
      const key = pathKey(ref).split('/').pop()!; const owners = stringTowers.get(key) ?? new Set(); owners.add(obj.id); stringTowers.set(key, owners);
    }
    if (!obj.coordinate) findings.push({ severity: 'WARNING', code: 'tower-coordinate', message: '杆塔缺少有效 BLHA，仍可在对象列表查阅', objectId: obj.id });
  }
  // Membership follows occurrences, not a single parent pointer. Avoid exponential revisits.
  const membershipSeen = new Set<string>();
  function memberships(n: GimGraphNode, line?: string, strain?: string, trail = new Set<string>()) {
    if (trail.has(n.path)) return;
    const id = nodeObjects.get(pathKey(n.path)); const obj = id ? objectById.get(id) : undefined;
    if (obj?.kind === 'line') line = obj.id;
    if (obj?.kind === 'strain') strain = obj.id;
    const key = `${n.path}|${line ?? ''}|${strain ?? ''}`;
    if (membershipSeen.has(key)) return; membershipSeen.add(key);
    if (obj) { if (line) obj.lineIds = unique([...obj.lineIds, line]); if (strain) obj.strainIds = unique([...obj.strainIds, strain]); }
    nodeMembership.set(pathKey(n.path), { lines: unique([...(nodeMembership.get(pathKey(n.path))?.lines ?? []), ...(line ? [line] : [])]), strains: unique([...(nodeMembership.get(pathKey(n.path))?.strains ?? []), ...(strain ? [strain] : [])]) });
    const next = new Set(trail).add(n.path); for (const c of children(n)) memberships(c, line, strain, next);
  }
  const nodeMembership = new Map<string, { lines: string[]; strains: string[] }>();
  memberships(graph.root);
  const inherit = (obj: BusinessObject, n: GimGraphNode) => { const m = nodeMembership.get(pathKey(n.path)); obj.lineIds = m?.lines ?? []; obj.strainIds = m?.strains ?? []; };
  const rawWires: RawWire[] = [];
  const spanMap = new Map<string, BusinessObject>();
  const wireSpan = new Map<string, string>();
  const towerByCoordinate = new Map<string, string[]>();
  const coordKey = (c: Coordinate) => `${c[0].toFixed(7)},${c[1].toFixed(7)}`;
  for (const t of objects.filter(o => o.kind === 'tower' && o.coordinate)) { const k = coordKey(t.coordinate!); towerByCoordinate.set(k, [...(towerByCoordinate.get(k) ?? []), t.id]); }
  const owner = (ref?: string, coord?: Coordinate) => {
    const owners = ref ? stringTowers.get(pathKey(ref).split('/').pop()!) : undefined;
    if (owners?.size === 1) return [...owners][0];
    const candidates = coord ? towerByCoordinate.get(coordKey(coord)) : undefined;
    return candidates?.length === 1 ? candidates[0] : undefined;
  };
  // Explicit grouping parent lets a WIRE inherit BACKSTRING/FRONTSTRING and ISJUMPER.
  const wireParent = new Map<string, GimGraphNode>();
  for (const n of nodes.filter(n => n.rawProps.GROUPTYPE?.toUpperCase() === 'WIRE')) for (const c of children(n)) wireParent.set(pathKey(c.path), n);
  progress?.('合并物理档', 0, nodes.length);
  for (const n of nodes.filter(n => entity(n) === 'WIRE')) {
    const ev = evidence(n), parent = wireParent.get(pathKey(n.path));
    const props = { ...parent?.rawProps, ...n.rawProps };
    let start = coordinateFromBlha(props['POINT0.BLHA']), end = coordinateFromBlha(props['POINT1.BLHA']);
    const startId = owner(props.BACKSTRING ?? props['POINT0.STRING'], start), endId = owner(props.FRONTSTRING ?? props['POINT1.STRING'], end);
    start ??= startId ? objectById.get(startId)?.coordinate : undefined;
    end ??= endId ? objectById.get(endId)?.coordinate : undefined;
    const jumper = props.ISJUMPER === '1' || (!!startId && startId === endId) || (!!start && !!end && horizontalDistance(start, end) < 0.01);
    const type = pick(ev.attrs, ['DEVICETYPE', 'WIRETYPE'])?.toUpperCase() ?? 'UNKNOWN';
    const raw: RawWire = { id: `wire:${pathKey(n.path)}`, sourcePath: n.path, start, end, startTowerId: startId, endTowerId: endId, type, jumper, sourceRefs: ev.refs, attributes: ev.attrs }; rawWires.push(raw);
    if (jumper) { if (startId) objectById.get(startId)?.relatedIds.push(raw.id); continue; }
    const ends = [startId ?? (start ? coordKey(start) : `unknown:${n.path}:0`), endId ?? (end ? coordKey(end) : `unknown:${n.path}:1`)];
    const reverse = ends[0] > ends[1]; const key = [...ends].sort().join('|');
    let span = spanMap.get(key);
    if (!span) {
      const a = reverse ? end : start, b = reverse ? start : end;
      span = { id: `span:${key}`, kind: 'span', name: `${objectById.get(reverse ? endId! : startId!)?.name ?? '未关联塔位'} — ${objectById.get(reverse ? startId! : endId!)?.name ?? '未关联塔位'}`, sourcePath: n.path, sourceRefs: [], attributes: [], lineIds: [], strainIds: [], relatedIds: [], rawWireIds: [], wireCounts: {}, startTowerId: reverse ? endId : startId, endTowerId: reverse ? startId : endId };
      if (a && b) { span.geometry = [a, b]; span.coordinate = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; span.horizontalMeters = horizontalDistance(a, b); span.spatialMeters = a[2] != null && b[2] != null ? Math.hypot(span.horizontalMeters, a[2] - b[2]) : span.horizontalMeters; }
      spanMap.set(key, span); objects.push(span); objectById.set(span.id, span);
    }
    span.rawWireIds!.push(raw.id); span.wireCounts![type] = (span.wireCounts![type] ?? 0) + 1;
    wireSpan.set(pathKey(n.path), span.id);
    span.sourceRefs = unique([...span.sourceRefs, ...ev.refs]);
    if (!span.attributes.length) span.attributes = ev.attrs;
    const mem = nodeMembership.get(pathKey(n.path)); span.lineIds = unique([...span.lineIds, ...(mem?.lines ?? [])]); span.strainIds = unique([...span.strainIds, ...(mem?.strains ?? [])]);
    for (const tid of [startId, endId]) if (tid) { span.relatedIds = unique([...span.relatedIds, tid]); const t = objectById.get(tid); if (t) t.relatedIds = unique([...t.relatedIds, span.id]); }
    if (!start || !end) findings.push({ severity: 'WARNING', code: 'wire-endpoint', message: '导线端点缺少有效坐标', source: n.path, objectId: span.id });
    if (!startId || !endId) findings.push({ severity: 'INFO', code: 'span-topology', message: '档端点尚未通过引用关联到杆塔；保留原始挂点坐标', source: n.path, objectId: span.id });
  }
  for (const n of nodes.filter(n => entity(n) === 'CROSS')) {
    const obj = make(n, 'cross'); inherit(obj, n); const ev = evidence(n);
    obj.type = pick(ev.attrs, ['CROSSTYPE', 'CROSSINGTYPE', 'DEVICETYPE', 'TYPE', 'CODE']); obj.name = pick(ev.attrs, ['NAME', 'CROSSNAME', '名称']) ?? `跨越物 ${objects.filter(o => o.kind === 'cross').length}`;
    obj.coordinate = coordinateFromBlha(n.rawProps.BLHA);
    for (const mod of ev.mods) {
      const text = cache.getText(mod); if (!text || classifyLineMod(text) !== 'text-point-line') continue;
      try {
        const data = parsePointLine(text, mod); const pts = data.points.filter(p => Number.isFinite(p.lon) && Number.isFinite(p.lat) && Math.abs(p.lon) <= 180 && Math.abs(p.lat) <= 90);
        obj.geometry = pts.map(p => [p.lon, p.lat, p.alt]);
        if (pts.length) obj.coordinate ??= [pts.reduce((s, p) => s + p.lon, 0) / pts.length, pts.reduce((s, p) => s + p.lat, 0) / pts.length];
        obj.type ??= data.code;
      } catch { findings.push({ severity: 'WARNING', code: 'cross-mod', message: '跨越物点线 MOD 无法投影，原始文件可查阅', source: mod, objectId: obj.id }); }
    }
    if (!obj.coordinate) findings.push({ severity: 'WARNING', code: 'cross-coordinate', message: '跨越物无可用位置', objectId: obj.id });
  }
  for (const n of nodes.filter(n => n.rawProps.GROUPTYPE?.toUpperCase() === 'CROSS' && !children(n).length)) findings.push({ severity: 'INFO', code: 'empty-cross-group', message: '空跨越组保留为源结构，不生成跨越物', source: n.path });
  const tree: TreeNode = { id: 'root', objectId: projectObj.id, label: projectObj.name, children: [] };
  const lines = objects.filter(o => o.kind === 'line');
  lines.forEach((line, i) => { if (line.name.toUpperCase() === 'F2SYSTEM') line.name = `线路 ${i + 1}`; });
  objects.filter(o => o.kind === 'strain').forEach((strain, i) => { if (strain.name.toUpperCase() === 'F3SYSTEM') { const towers = objects.filter(o => o.kind === 'tower' && o.strainIds.includes(strain.id)); strain.name = `耐张段 ${i + 1}${towers.length ? ` · ${towers[0].name}—${towers[towers.length - 1].name}` : ''}`; } });
  const occurrenceOrder = (rootNode: GimGraphNode): Map<string, number> => {
    const order = new Map<string, number>(), seen = new Set<string>();
    const visit = (node: GimGraphNode) => { if (seen.has(node.path)) return; seen.add(node.path); const id = nodeObjects.get(pathKey(node.path)) ?? wireSpan.get(pathKey(node.path)); if (id && !order.has(id)) order.set(id, order.size); for (const child of children(node)) visit(child); }; visit(rootNode); return order;
  };
  for (const line of lines) {
    const ln: TreeNode = { id: line.id, objectId: line.id, label: line.name, children: [] }; tree.children.push(ln);
    for (const strain of objects.filter(o => o.kind === 'strain' && o.lineIds.includes(line.id))) {
      const sn: TreeNode = { id: `${line.id}/${strain.id}`, objectId: strain.id, label: strain.name, children: [] }; ln.children.push(sn);
      const strainNode = resolveNode(strain.sourcePath!); const order = strainNode ? occurrenceOrder(strainNode) : new Map<string, number>();
      for (const obj of objects.filter(o => ['tower', 'span', 'cross'].includes(o.kind) && o.strainIds.includes(strain.id)).sort((a,b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity))) sn.children.push({ id: `${sn.id}/${obj.id}`, objectId: obj.id, label: obj.name, children: [] });
    }
    for (const obj of objects.filter(o => ['tower', 'span', 'cross'].includes(o.kind) && o.lineIds.includes(line.id) && !o.strainIds.length)) ln.children.push({ id: `${line.id}/${obj.id}`, objectId: obj.id, label: obj.name, children: [] });
  }
  const inTree = new Set<string>(); const collect = (t: TreeNode) => { inTree.add(t.objectId); t.children.forEach(collect); }; collect(tree);
  for (const obj of objects.filter(o => o.kind !== 'project' && !inTree.has(o.id))) tree.children.push({ id: `unassigned/${obj.id}`, objectId: obj.id, label: obj.name, children: [] });
  const coordinates = objects.flatMap(o => o.geometry?.length ? o.geometry : o.coordinate ? [o.coordinate] : []);
  const bounds: PowerlineProject['bounds'] = coordinates.length ? [Math.min(...coordinates.map(c => c[0])), Math.min(...coordinates.map(c => c[1])), Math.max(...coordinates.map(c => c[0])), Math.max(...coordinates.map(c => c[1]))] : undefined;
  const counts = { project: 0, line: 0, strain: 0, tower: 0, span: 0, cross: 0 }; objects.forEach(o => counts[o.kind]++);
  const geometryLengthMeters = [...spanMap.values()].reduce((s, o) => s + (o.horizontalMeters ?? 0), 0);
  for (const line of lines) {
    const raw = pick(line.attributes, ['LINELENGTH', '线路长度']); const expected = raw ? Number(raw) * 1000 : NaN;
    const measured = objects.filter(o => o.kind === 'span' && o.lineIds.includes(line.id)).reduce((s, o) => s + (o.horizontalMeters ?? 0), 0);
    if (Number.isFinite(expected) && expected > 0 && Math.abs(expected - measured) / expected > 0.05) findings.push({ severity: 'WARNING', code: 'length-difference', message: `源线路长度 ${raw} km 与去重档水平长度 ${(measured / 1000).toFixed(3)} km 存在差异`, objectId: line.id });
  }
  progress?.('空间索引就绪', objects.length, objects.length);
  return { id: identity.id, name: projectObj.name, sourceSha256: identity.sha256, sourceSize: identity.size, parserVersion: MOBILE_PARSER_VERSION, objects, rawWires, tree, findings, bounds, geometryLengthMeters, counts };
}
