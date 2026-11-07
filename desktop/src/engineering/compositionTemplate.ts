import type { EngineeringEntity, EngineeringSnapshot, EvidenceValue } from './types.js';
import type { CompositionAssignment, CompositionGroup, CompositionDeclaration } from './composition.js';
import { mainNumber } from './classify.js';

/** Format-neutral declarations describe project context, never entity identity. */
export interface CompositionContextEvidence {
  entityId: string;
  declarations: Array<{ names: EvidenceValue[] }>;
  spaces: Array<{ building: EvidenceValue; storeys: Array<EvidenceValue & {elevationMetres?:number}> }>;
  /** Named delivery context, adapted before entering the domain projection. */
  deliveryBuildingNames?: EvidenceValue[];
  /** Project-level building names from IFC delivery; used only to place a
   * room/MEP file under an already named building, never to invent identity. */
  availableBuildings?: EvidenceValue[];
  deliveryAreaNames?: EvidenceValue[];
  deliveryStructureNames?: EvidenceValue[];
  hostEntityIds: string[];
  /** Source track only breaks out unclassified members; it never changes identity. */
  track?: 'dev' | 'ifc' | 'mixed';
}
type Purpose = 'main' | 'distribution' | 'reactive' | 'auxiliary' | 'secondary' | 'cables' | 'ground' | 'lighting' | 'hvac' | 'water' | 'fire';
interface DeclaredContext { purpose: Purpose; voltage?: number; unit?: string;  }
const levels = new Set([0.4, 6, 10, 20, 35, 66, 110, 220, 330, 500, 750, 1000]);
const normalize = (name: string) => name.normalize('NFKC').trim().replace(/\s+/g, ' ');
const keyOf = (name: string) => normalize(name).replace(/\s/g, '').toLowerCase();
const valid = (name: string) => !!normalize(name) && !/^(?:-|--|其他|其它|无|未命名|未定义|未指定|默认|NULL\d*|None|Undefined|IFC\w*|Default(?:[ _-]*(?:Building|Storey|Level|Project|Site))?|Building|Storey|Project|Site|建筑|站区)(?:\s*#?\s*\d*)?$/i.test(normalize(name)) && !name.startsWith('&');
const validBuilding = (name: string) => valid(name)
  && !/^(?:(?:Building|建筑)\s*s|新建(?:模(?:型)?|筑)\s*\d*|模型\s*\d*)$/i.test(normalize(name))
  && !/总平面|总轴网|平面图|立面图|剖面图/.test(name);
const civil: CompositionGroup = { key: 'civil', title: '建筑工程', kind: 'discipline', order: 0 };
const installation: CompositionGroup = { key: 'installation', title: '安装工程', kind: 'discipline', order: 1 };
const unclassified: CompositionGroup = { key: 'unclassified', title: '未分类', kind: 'discipline', order: 2 };
type SourceTrack = 'dev' | 'ifc' | 'mixed';
function trackGroup(track: SourceTrack): CompositionGroup {
  return { key: `track:${track}`, title: track === 'ifc' ? 'IFC 轨道' : track === 'dev' ? 'DEV 轨道' : 'DEV+IFC 轨道', kind: 'track', order: 0 };
}
function categoryBucket(category: string): string {
  if (category.startsWith('E')) return '设备';
  if (category.startsWith('M')) return '装置性材料';
  if (category.startsWith('C')) return '构件';
  return '其他';
}
function unclassifiedPath(track: SourceTrack, category: string): CompositionGroup[] {
  const bucket = categoryBucket(category);
  return [unclassified, trackGroup(track), { key: `unclassified:${bucket}`, title: bucket, kind: 'bucket', order: bucket === '设备' ? 10 : bucket === '装置性材料' ? 20 : bucket === '构件' ? 30 : 40 }];
}
const systems: Record<Exclude<Purpose, 'distribution'>, { title: string; order: number; civil?: boolean }> = {
  main: { title: '主变压器系统', order: 10 }, reactive: { title: '无功补偿系统', order: 30 },
  auxiliary: { title: '站用电系统', order: 40 }, secondary: { title: '二次及直流系统', order: 50 },
  cables: { title: '电缆', order: 60 }, ground: { title: '接地系统', order: 70 },
  lighting: { title: '照明', order: 50, civil: true }, hvac: { title: '采暖、通风、空调', order: 60, civil: true },
  water: { title: '给排水', order: 70, civil: true }, fire: { title: '消防', order: 80, civil: true },
};
function purpose(name: string): Purpose | null {
  const text = keyOf(name);
  if (/^(?:\d+(?:\.\d+)?(?:kv|千伏))?(?:主变(?:压器)?|变压器)(?:系统\d*|区域)$/.test(text)) return 'main';
  if (/无功补偿|无功系统|静止无功|并联电容器系统/.test(text)) return 'reactive';
  if (/二次系统|直流系统|直流电源|直流配电|蓄电池|充电柜|继电保护系统|通信系统|控制保护系统|监控系统|测控.*(?:柜|屏)|保护.*(?:柜|屏)|录波柜/.test(text)) return 'secondary';
  if (/站用(?:电|交流|变压器)系统|所用电系统/.test(text)) return 'auxiliary';
  if (/接地网|全站接地|防雷接地|^接地系统/.test(text)) return 'ground';
  if (/电缆系统|电缆工程/.test(text)) return 'cables';
  if (/消防|火灾报警|灭火/.test(text)) return 'fire';
  if (/采暖|暖通|通风|空调|风管/.test(text)) return 'hvac';
  if (/给排水|给水|排水|供水|雨水|污水|生活水/.test(text)) return 'water';
  if (/照明|路灯/.test(text)) return 'lighting';
  return null;
}
function voltage(name: string): number | undefined {
  // A range describes a class of systems, not one operating voltage.
  if (/[<>≤≥]/.test(normalize(name)) || /\d\s*(?:[-~～—]|至|到)\s*\d+(?:\.\d+)?\s*(?:kV|千伏)/i.test(name)) return undefined;
  const matches = [...name.matchAll(/(\d+(?:\.\d+)?)\s*(?:kV|千伏)/gi)].map(m => Number(m[1])).filter(n => levels.has(n));
  const unique = [...new Set(matches)]; return unique.length === 1 ? unique[0] : undefined;
}
function system(context: DeclaredContext): CompositionGroup {
  if (context.purpose === 'distribution') return { key: `distribution:${context.voltage}`, title: `${context.voltage}千伏配电装置`, kind: 'system', order: 20 - (context.voltage ?? 0) / 10000 };
  const definition = systems[context.purpose]; return { key: context.purpose, title: definition.title, kind: 'system', order: definition.order };
}
function areaTitle(group: CompositionGroup): string {
  return group.key === 'main' ? '主变区域' : `${group.title}区域`;
}
export function supportTitle(entity: EngineeringEntity, category: string): string {
  if (category === 'C-B1' || /支架/.test(entity.name)) return '支架';
  if (category === 'C-B7' || /构架|桁架/.test(entity.name)) return '构架';
  return '构架';
}
function declared(input: CompositionContextEvidence | undefined): DeclaredContext[] {
  const result: DeclaredContext[] = [];
  for (const declaration of input?.declarations ?? []) {
    const names = declaration.names.filter(n => valid(n.value));
    let latest: DeclaredContext | undefined;
    for (let i = 0; i < names.length; i++) {
      const item = names[i], own = purpose(item.value), kv = voltage(item.value);
      if (own) latest = { purpose: own };
      else if (kv !== undefined && /配电装置|系统|开关场|区域/.test(item.value)) latest = { purpose: 'distribution', voltage: kv };
      else if (kv !== undefined && /间隔|母线/.test(item.value) && (!latest || latest.purpose === 'distribution')) {
        // An explicitly named 110kV bay is sufficient project evidence even
        // when its preceding system label is only a voltage interval. This is
        // never evaluated against equipment names or rated-voltage fields.
        if (latest?.voltage !== undefined && latest.voltage !== kv) result.push(latest);
        latest = { purpose: 'distribution', voltage: kv, unit: normalize(item.value) };
      }
      else if (latest && !latest.unit && !/^(?:电气系统|交流电气系统|建筑系统|建筑物系统|建筑工程)$/.test(item.value)) {
        // A named unit follows its explicitly declared system in the same
        // semantic path. It need not contain the word 间隔 (e.g. 36S).
        latest.unit = normalize(item.value);
      }
    }
    if (latest) result.push(latest);
  }
  // Context declarations arrive from general to specific. Repeated inherited
  // copies of the same declaration do not create a second project unit.
  return result;
}
function installationPath(context: DeclaredContext): CompositionGroup[] {
  const path = [installation, system(context)];
  if (context.unit) {
    const number = context.purpose === 'main' ? mainNumber(context.unit) : '';
    path.push(number ? { key: `main:${number}`, title: `${number}号主变`, kind: 'unit' }
      : { key: `unit:${keyOf(context.unit)}`, title: context.purpose === 'distribution' && !/间隔|母线|分段|系统|区域/.test(context.unit) ? `${context.unit}间隔` : context.unit, kind: 'unit' });
  }
  return path;
}
function facility(context: DeclaredContext): CompositionGroup[] { return [civil, system(context)]; }
export function canonicalBuildingName(text:string):string {
  const value=normalize(text);
  const voltage=value.match(/(\d+)\s*(?:kV|千伏)?\s*配电(?:装置)?楼/i);
  if(voltage)return `${voltage[1]}千伏配电装置楼`;
  const named=value.match(/警卫室|门卫室|警传室|消防泵房|主控(?:通信)?楼\d*|辅助用房|配电(?:装置)?楼|配电室\d*|综合楼|生产(?:综合)?楼|控制楼/);
  return named?.[0]??'';
}
/** A room-like delivery name, but not a standalone small building. */
export function isRoomBuildingName(text:string):boolean {
  const value=canonicalBuildingName(text)||normalize(text);
  return /室$/.test(value)&&!isStandaloneBuildingName(value);
}
export function isStandaloneBuildingName(text:string):boolean {
  const value=canonicalBuildingName(text)||normalize(text);
  return /消防泵房|警传室|警卫室|门卫室/.test(value);
}
export function buildingPaths(input: CompositionContextEvidence | undefined): CompositionGroup[][] {
  const candidates = input?.spaces ?? [];
  const names = candidates.filter(space => validBuilding(space.building.value)
    && (!purpose(space.building.value) || isStandaloneBuildingName(space.building.value))
    && !/配电装置|开关场|构支架|构架|电缆沟/.test(space.building.value));
  // A room/electrical-mechanical delivery file is not a peer building when a
  // project-level building name is available. Keep the room as a child storey.
  const room=candidates.map(space=>({space,name:canonicalBuildingName(space.building.value)||normalize(space.building.value)}))
    .find(row=>isRoomBuildingName(row.name))
    ?? [...(input?.declarations??[])].reverse().flatMap(declaration=>declaration.names)
      .map(name=>({name:canonicalBuildingName(name.value)||normalize(name.value),evidenceId:name.evidenceId}))
      .find(row=>isRoomBuildingName(row.name))
    ?? (input?.deliveryBuildingNames??[]).map(row=>({name:row.value,evidenceId:row.evidenceId}))
      .find(row=>isRoomBuildingName(row.name));
  const projectBuildings=[...new Map((input?.availableBuildings??[]).map(row=>[row.value,row])).values()]
    .filter(row=>canonicalBuildingName(row.value)&&!isRoomBuildingName(canonicalBuildingName(row.value)));
  const towers=projectBuildings.filter(row=>/楼$/.test(canonicalBuildingName(row.value)));
  const candidatesForRoom=towers.length?towers:projectBuildings;
  const roomBuilding=room&&candidatesForRoom.length===1?candidatesForRoom[0]:undefined;
  if(room&&roomBuilding)return [[civil,{key:`building:${keyOf(canonicalBuildingName(roomBuilding.value))}`,title:canonicalBuildingName(roomBuilding.value),kind:'building',order:0},
    {key:`room:${keyOf(room.name)}`,title:room.name,kind:'storey',order:0}]];
  if (names.length) return names.map(space => [civil,
    { key: `building:${keyOf(canonicalBuildingName(space.building.value)||space.building.value)}`, title: canonicalBuildingName(space.building.value)||normalize(space.building.value), kind: 'building', order: 0 },
    ...space.storeys.filter(item => valid(item.value) || /^(?:Storey|Level)\s*\d+$/i.test(item.value)).map(item => {
      const title = normalize(item.value).replace(/^(?:Storey|Level)\s*#?\s*(-?\d+)$/i, '$1层');
      return { key: `floor:${keyOf(title)}`, title, kind: 'storey' as const };
    })]);
  // A placeholder IfcBuilding does not erase named storeys or the model's
  // architectural delivery name. Both remain source-backed building evidence.
  const floors=candidates.flatMap(space=>space.storeys.map(floor=>({floor,name:canonicalBuildingName(floor.value)}))).filter(row=>row.name);
  if(floors.length)return floors.map(({floor,name})=>[civil,{key:`building:${keyOf(name)}`,title:name,kind:'building',order:0},
    {key:`floor:${keyOf(floor.value)}`,title:floor.value,kind:'storey'}]);
  const fileNames=[...new Set((input?.deliveryBuildingNames??[]).map(n=>n.value).filter(Boolean))];
  if(fileNames.length===1)return [[civil,{key:`building:${keyOf(fileNames[0])}`,title:fileNames[0],kind:'building',order:0},
    ...candidates.flatMap(space=>space.storeys.filter(f=>valid(f.value)).map(f=>({key:`floor:${keyOf(f.value)}`,title:f.value,kind:'storey' as const})))]];
  const labels = [...(input?.declarations ?? [])].reverse().flatMap(d => d.names.filter(n => validBuilding(n.value) && /楼|栋|房|室|车间/.test(n.value) && !/系统|区域/.test(n.value)));
  const first = labels[0];
  return first ? [[civil, { key: `building:${keyOf(first.value)}`, title: first.value, kind: 'building', order: 0 }]] : [];
}

/** The construction/operations template organizes existing wholes. Categories,
 * memberships and physical roots are untouched by business mapping. */
export function assignEngineeringComposition(snapshot: EngineeringSnapshot, evidence: readonly CompositionContextEvidence[]): CompositionAssignment[] {
  const facts = new Map(evidence.map(item => [item.entityId, item])), entities = new Map(snapshot.entities.map(entity => [entity.id, entity]));
  const cache = new Map<string, CompositionAssignment>(), visiting = new Set<string>();
  function assign(entity: EngineeringEntity): CompositionAssignment {
    const found = cache.get(entity.id); if (found) return found;
    if (visiting.has(entity.id)) return { entityId: entity.id, paths: [] };
    visiting.add(entity.id);
    const input = facts.get(entity.id);
    const track: SourceTrack = input?.track ?? 'mixed';
    const uniqueContexts = new Map(declared(input).map(context => [JSON.stringify([context.purpose, context.voltage, context.unit]), context]));
    const contexts = [...uniqueContexts].sort(([a],[b])=>a.localeCompare(b)).map(([,context])=>context);
    if (!contexts.length && input?.deliveryAreaNames?.length) contexts.push(...declared({ ...input, declarations: input.deliveryAreaNames.map(name => ({names:[name]})) }));
    const purposes = new Set(contexts.map(context=>`${context.purpose}:${context.voltage ?? ''}`));
    const nearest = purposes.size === 1 ? contexts[0] : undefined;
    let chosen: DeclaredContext | undefined = nearest;
    const category = entity.category;
    const ownPurpose = purpose(entity.name) ?? (category === 'E19' && /风机|风口|暖气|制冷/.test(entity.name) ? 'hvac' : null);
    const ownFacility = ownPurpose && systems[ownPurpose as Exclude<Purpose, 'distribution'>]?.civil ? ownPurpose : null;
    const hostIds = [...new Set(input?.hostEntityIds ?? [])].filter(id => id !== entity.id && entities.has(id));
    const host = hostIds.length === 1 ? assign(entities.get(hostIds[0])!) : undefined;
    const hostPaths = host?.paths.filter(path => path[0]?.key === 'installation') ?? [];
    const fixed: Partial<Record<string, Purpose>> = { E01: 'main', E02: 'reactive', E03: 'auxiliary', E10: 'reactive', E11: 'reactive', E12: 'reactive', 'E16.protection': 'secondary', M05: 'cables', M08:'cables', M06: 'ground', 'C-D1': 'lighting', 'C-D2': 'fire', 'C-D4':'hvac', 'C-D5':'water', 'C-C2': 'water' };
    if (fixed[category]) chosen = { purpose: fixed[category]! };
    if (ownFacility && !fixed[category]) chosen = { purpose: ownFacility };
    const ownSecondary = ownPurpose === 'secondary' && category.startsWith('E16') && category !== 'E16.terminal_box';
    if (ownSecondary) chosen = { purpose: 'secondary' };
    let paths: CompositionGroup[][] = [];
    const isCivil = category.startsWith('C') || !!(chosen && systems[chosen.purpose as Exclude<Purpose, 'distribution'>]?.civil);
    const explicitBuilding = buildingPaths(input);
    if (isCivil) {
      // An actual IFC/delivery building name wins over a facility purpose such
      // as "消防" derived from the same name.
      if (explicitBuilding.length) paths = explicitBuilding;
      else if (chosen && systems[chosen.purpose as Exclude<Purpose, 'distribution'>]?.civil) paths = [facility(chosen)];
      else if (category === 'C-C1' || /电缆沟/.test(entity.name)) paths = [[civil, { key: 'cable-trenches', title: '电缆沟', kind: 'facility', order: 30 }]];
      else if (['C-C4', 'C-C5'].includes(category) || /围墙|围栏|道路|大门/.test(entity.name)) paths = [[civil, { key: 'site-works', title: '站区性建筑', kind: 'facility', order: 40 }]];
      else {
        paths = explicitBuilding;
        if (!paths.length) {
          const structure = category.startsWith('C-B') || category.startsWith('C-A') && !!input?.deliveryAreaNames?.length || /支架|基础|构架|桁架|防火墙/.test(entity.name) || /支架|基础|构架/.test(nearest?.unit ?? '');
          const related = structure && nearest && ['main', 'distribution', 'reactive', 'auxiliary'].includes(nearest.purpose) ? nearest : undefined;
          const hostGroup = hostPaths.length === 1 ? hostPaths[0][1] : undefined;
          const hostSystem = hostGroup?.kind === 'system' && hostGroup.key !== 'installation-unassigned' ? hostGroup : undefined;
          const group = related ? system(related) : hostSystem;
          if (group) {
            const foundation = ['C-B2','C-B3','C-B4'].includes(category)
              || !['C-B1','C-B5','C-B6','C-B7'].includes(category)
                && /基础|杯口|支墩|桩|承台|筏板|垫层/.test(entity.name) && !/支架|构架/.test(entity.name);
            const structureTitle = !foundation && (input?.deliveryStructureNames?.some(name=>name.value==='防火墙') || category==='C-A1' && /防火墙|防火.*墙|墙.*防火/.test(entity.name))
              ? '防火墙' : supportTitle(entity, category);
            paths = [[civil,
              { key: `area:${group.key}`, title: areaTitle(group), kind: 'area', order: 20 },
              { key: `area:${group.key}:${structureTitle==='防火墙'?'firewall':foundation ? 'foundation' : structureTitle}`, title: structureTitle==='防火墙'?'防火墙':foundation ? '基础' : structureTitle, kind: 'structure', order: structureTitle==='防火墙'?30:foundation ? 20 : 10 },
            ]];
          } else paths = [unclassifiedPath(track, category)];
        }
      }
    } else {
      // Clear material/system roles stand on their own. An independently
      // identified cabinet may share its actual host's project context.
      const fixedPurpose = fixed[category];
      if (fixedPurpose || ownSecondary) paths = [installationPath(chosen!)];
      else if (hostPaths.length === 1 && !ownFacility) { paths = hostPaths; }
      else if (chosen) paths = contexts.map(installationPath);
      else {
        if (category.startsWith('E16')) paths = [installationPath({ purpose: 'secondary' })];
        else if (buildingPaths(input).length) paths = buildingPaths(input);
        else paths = [unclassifiedPath(track, category)];
      }
    }
    // Preserve explicit unit context under fixed-purpose systems (main bank,
    // capacitor bank, station auxiliary unit), without manufacturing identity.
    if (fixed[category] && chosen && !isCivil && nearest?.purpose === chosen.purpose && nearest.unit) paths = [installationPath({ ...chosen, unit: nearest.unit })];
    if (category === 'E01') {
      const number = mainNumber(entity.name);
      if (number) paths = [[installation, system({purpose:'main'}), { key: `main:${number}`, title: `${number}号主变`, kind: 'unit' }]];
    }
    const unique = new Map(paths.map(path => [path.map(part => part.key).join('/'), path]));
    const result = { entityId: entity.id, paths: [...unique.values()] };
    cache.set(entity.id, result); visiting.delete(entity.id); return result;
  }
  return snapshot.entities.map(assign);
}

/** A declared project unit may have no reliably associated products yet. It is
 * still visible as a source-backed group, with zero confirmed whole members. */
export function declaredEngineeringComposition(inputs: readonly { contextId: string; names: EvidenceValue[] }[]): CompositionDeclaration[] {
  const result: CompositionDeclaration[] = [];
  for (const input of inputs) {
    const evidence: CompositionContextEvidence = { entityId: '', declarations: [{ names: input.names }], spaces: [], hostEntityIds: [] };
    const contexts = declared(evidence);
    const civilBuilding = input.names.some(name => /^(?:建构筑物|建筑物|建筑)(?:系统|工程)?$/.test(normalize(name.value)));
    const buildings = civilBuilding ? buildingPaths(evidence) : [];
    for (const path of buildings.length ? buildings : contexts.map(context => systems[context.purpose as Exclude<Purpose, 'distribution'>]?.civil ? facility(context) : installationPath(context)))
      result.push({ path, sourceContextIds: [input.contextId] });
    for (const context of contexts.filter(c=>c.purpose==='main'||c.purpose==='distribution')) {
      const group=system(context);
      for(const [index,title] of (context.purpose==='main'?['构架','支架','基础','防火墙']:['构架','支架','基础']).entries()) result.push({
        path:[civil,{key:`area:${group.key}`,title:areaTitle(group),kind:'area',order:20},
          {key:`area:${group.key}:${title==='基础'?'foundation':title==='防火墙'?'firewall':title}`,title,kind:'structure',order:index*10}],
        sourceContextIds:[input.contextId],
      });
    }
  }
  return result;
}
