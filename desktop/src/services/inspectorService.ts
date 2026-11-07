import { isRegionalConnectionObject, type RegionalObject } from '../viewer/ifcRegionalData.js';
import { ifcConnectionOwnershipIndex, type IfcConnectionOwnership } from '../gim/ifcConnectionOwnership.js';
import type { ConnectionEndpointEvidence } from '../gim/connectionEndpoints.js';
import { discoverSubstationGlSidecars, substationDevIdentity, buildSubstationAliasIndex, buildSubstationIfcEvidence, findSubstationSourceDocuments } from '../gim/substationEvidence.js';
export { deviceOccurrenceScope } from '../gim/substationEvidence.js';
import type { AppState } from '../app/state.js';
import type { CbmNode } from '../gim/types.js';
import { resolveBaseFamilyReferences } from '../gim/gimValueSemantics.js';
import { parseFamSectionsWithDiagnostics, resolveSubstationBusinessIdentity, type FamSourceProperty } from '../gim/famParser.js';
import { getFileByPath } from '../gim/fileLookup.js';
import { parseKeyValue } from '../gim/kvParser.js';
import { getNodeDisplayName } from '../shared/displayName.js';
import { readGimText } from '../shared/textDecode.js';
import { getFileEntryResolver } from '../gim/entryResolver.js';
export function withEntryPrefix(prefix: string, value: string): string {
  const normalized = value.trim().replace(/\\/g, '/');
  return normalized.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)
    ? normalized
    : `${prefix}/${normalized}`;
}

export function getCachedByPath<T>(map: Map<string, T>, path: string): T | undefined {
  const exact = map.get(path);
  if (exact !== undefined) return exact;
  const wanted = path.replace(/\\/g, '/').toLowerCase();
  for (const [candidate, value] of map) {
    if (candidate.replace(/\\/g, '/').toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** 将 Fragments 的模型标识转成来源按钮可用的 IFC 路径。 */
export interface InspectorSummary {
  name: string;
  identity: string;
  keyRows: Array<{ label: string; value: string }>;
  idRows: Array<{ label: string; value: string }>;
  systemPath: string;
  componentCount: number;
}

const PLACEHOLDER_VALUES = new Set(['-', '/', '\\', '—', '&其他', '未填写', 'null', 'undefined']);

/** 去掉占位符与值内重复键名（如 `工程中名称=开关柜`）。 */
export function normalizeBusinessValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let text = String(value).trim();
  if (!text) return null;
  const separator = text.indexOf('=');
  if (separator > 0 && separator <= 24) {
    const prefix = text.slice(0, separator).trim();
    if (prefix && !/\s/.test(prefix) && !/[=,]/.test(prefix)) text = text.slice(separator + 1).trim();
  }
  if (!text || PLACEHOLDER_VALUES.has(text)) return null;
  return text;
}

function pickBusinessValue(
  sources: ReadonlyArray<Record<string, string>>,
  candidates: readonly string[],
): { value: string; key: string } | null {
  for (const candidate of candidates) {
    for (const source of sources) {
      const normalized = normalizeBusinessValue(source[candidate]);
      if (normalized) return { value: normalized, key: candidate };
      const upper = candidate.toUpperCase();
      for (const [key, raw] of Object.entries(source)) {
        if (key.toUpperCase() !== upper) continue;
        const match = normalizeBusinessValue(raw);
        if (match) return { value: match, key };
      }
    }
  }
  return null;
}

/**
 * 设备由多个部件（PARTINDEX / DEV_SUBDEVICE）组成。GIM 把部分业务属性写在
 * 部件自己的 DEV/FAM 上，而用户是按“设备”阅读属性的，所以这里把设备下
 * 组件的属性并按设备优先合并；组件自身的值只补缺，不覆盖设备值。
 */
function collectComponentNodes(node: CbmNode, out: CbmNode[], limit = 120): void {
  for (const child of node.children) {
    if (out.length >= limit) return;
    out.push(child);
    collectComponentNodes(child, out, limit);
  }
}

export async function readDevKv(state: AppState, devKey: string): Promise<Record<string, string> | null> {
  if (state.currentFiles) {
    const file = getFileByPath(state.currentFiles, getFileEntryResolver(state.currentFiles)(devKey) ?? devKey);
    return file ? parseKeyValue(await readGimText(file)) : null;
  }
  return getCachedByPath(state.cachedDevProperties, devKey) ?? null;
}

async function collectPropertySources(
  state: AppState,
  node: CbmNode,
): Promise<{ sources: Record<string, string>[]; componentCount: number }> {
  const cbmKv = node.rawProperties ?? {};
  const componentNodes: CbmNode[] = [];
  collectComponentNodes(node, componentNodes);
  const devMerged: Record<string, string> = {};
  const famKv: Record<string, string> = {};
  const famPaths = new Set<string>();
  if (node.famPath) famPaths.add(withEntryPrefix('CBM', node.famPath));
  for (const ref of resolveBaseFamilyReferences(cbmKv)) famPaths.add(withEntryPrefix('CBM', ref.path));

  let componentCount = 0;
  const devSources: Array<{ key: string; kv: Record<string, string> }> = [];
  if (node.devPath) {
    const key = withEntryPrefix('DEV', node.devPath);
    const kv = await readDevKv(state, key);
    if (kv) devSources.push({ key, kv });
  }
  for (const component of componentNodes) {
    if (devSources.length >= 64) break;
    const refs = new Set<string>();
    if (component.devPath) refs.add(withEntryPrefix('DEV', component.devPath));
    for (const ref of resolveBaseFamilyReferences(component.rawProperties ?? {})) {
      refs.add(withEntryPrefix('DEV', ref.path));
    }
    for (const key of refs) {
      if (devSources.some((row) => row.key === key)) continue;
      const kv = await readDevKv(state, key);
      if (kv) devSources.push({ key, kv });
    }
    if (component.famPath) famPaths.add(withEntryPrefix('CBM', component.famPath));
    for (const ref of resolveBaseFamilyReferences(component.rawProperties ?? {})) {
      famPaths.add(withEntryPrefix('CBM', ref.path));
    }
  }
  for (let i = 0; i < devSources.length; i++) {
    const { kv } = devSources[i];
    let contributed = false;
    for (const [key, value] of Object.entries(kv)) {
      if (devMerged[key] !== undefined) continue;
      devMerged[key] = value;
      contributed = true;
    }
    if (contributed && i > 0) componentCount++;
    for (const ref of resolveBaseFamilyReferences(kv)) famPaths.add(withEntryPrefix('DEV', ref.path));
  }

  for (const path of famPaths) {
    let sections = getCachedByPath(state.cachedFamProperties, path);
    if (!sections && state.currentFiles) {
      const file = getFileByPath(state.currentFiles, path);
      if (file) sections = (await readInspectorFamily(state,path))?.sections;
    }
    if (!sections) continue;
    for (const section of sections.values()) {
      for (const [key, value] of section) {
        if (famKv[key] !== undefined) continue;
        const normalized = normalizeBusinessValue(value);
        if (normalized) famKv[key] = normalized;
      }
    }
  }
  return { sources: [famKv, devMerged, cbmKv], componentCount };
}

export async function buildInspectorSummary(state: AppState, node: CbmNode): Promise<InspectorSummary> {
  const { sources, componentCount } = await collectPropertySources(state, node);
  const cbmKv = sources[2];

  const namePick = pickBusinessValue(sources, ['工程中名称', 'PARTNAME', 'SYMBOLNAME', '设备名称', 'NAME']);
  const name = namePick?.value
    ?? getNodeDisplayName(node, state.ifcGuidToName, state.currentIfcEntries);
  const typeLabel = normalizeBusinessValue(node.entityName)
    ?? normalizeBusinessValue(cbmKv['ENTITYNAME'])
    ?? '';
  const voltage = pickBusinessValue(sources, ['电压等级', 'VOLTAGEGRADE', 'VOLTAGE', '额定电压'])?.value ?? '';
  const systemPath = ['SYSTEMNAME1', 'SYSTEMNAME2', 'SYSTEMNAME3', 'SYSTEMNAME4']
    .map((key) => normalizeBusinessValue(cbmKv[key]))
    .filter((value): value is string => Boolean(value))
    .join(' / ');

  const keyDefinitions: Array<{ label: string; candidates: string[] }> = [
    { label: '设备名称', candidates: ['工程中名称', 'PARTNAME', 'SYMBOLNAME', '设备名称', 'NAME'] },
    { label: '电压等级', candidates: ['电压等级', 'VOLTAGEGRADE', 'VOLTAGE'] },
    { label: '制造商', candidates: ['生产厂家', '厂家', 'MANUFACTURER', '制造厂家'] },
    { label: '型号', candidates: ['装置型号', '型号', '设备型号', 'MODEL'] },
    { label: '额定容量', candidates: ['额定容量', 'RATEDCAPACITY'] },
    { label: '额定电压', candidates: ['额定电压', 'RATEDVOLTAGE'] },
    { label: '装置名称', candidates: ['装置名称'] },
    { label: '建设期次', candidates: ['建设期次', 'CONSTRUCTIONPHASE'] },
  ];
  const keyRows: Array<{ label: string; value: string }> = [];
  for (const definition of keyDefinitions) {
    if (keyRows.length >= 8) break;
    const picked = pickBusinessValue(sources, definition.candidates);
    if (picked) keyRows.push({ label: definition.label, value: picked.value });
  }

  const idDefinitions: Array<{ label: string; candidates: string[] }> = [
    { label: '调度编码', candidates: ['调度编码', 'SCHEDULCODE', 'DISPATCHCODE'] },
    { label: '实物 ID', candidates: ['实物ID', 'MATERIALID', 'ASSETID'] },
    { label: '电网标识编码', candidates: ['电网工程标识系统编码', 'GRIDIDENTIFICATIONSYSTEMCODE'] },
    { label: '设计模型编码', candidates: ['三维设计模型编码', 'DESIGNMODELCODE'] },
    { label: '装置编号', candidates: ['装置编号', '设备编号'] },
  ];
  const idRows: Array<{ label: string; value: string }> = [];
  for (const definition of idDefinitions) {
    const picked = pickBusinessValue(sources, definition.candidates);
    if (picked) idRows.push({ label: definition.label, value: picked.value });
  }

  return {
    name,
    identity: [typeLabel, voltage, systemPath].filter(Boolean).join(' · '),
    keyRows,
    idRows,
    systemPath,
    componentCount,
  };
}


export async function readInspectorFamily(state:AppState,path:string) {
  const actual=state.currentFiles ? getFileEntryResolver(state.currentFiles)(path) : null;
  const file=state.currentFiles && actual ? getFileByPath(state.currentFiles,actual) : undefined;
  return file ? parseFamSectionsWithDiagnostics(await readGimText(file),actual!) : null;
}

export function inspectAuxiliarySources(state:AppState,node:CbmNode):Array<{label:string;value:string;kind?:'gl'|'dev'}> {
  const rows:Array<{label:string;value:string;kind?:'gl'|'dev'}>=[];
  const documents=findSubstationSourceDocuments(node,state.currentCbmTree,state.fileDevRelations);
  if(documents.length)rows.push({label:'原始设计文档',value:documents.join('、')});
  for(const link of buildSubstationIfcEvidence(state.currentCbmTree,state.currentIfcEntries).filter(link=>link.cbmPath===node.path))
    rows.push({label:'IFC 关联证据',value:`${link.evidence} · ${link.confidence} · ${link.rawReference}`});
  const identity=substationDevIdentity(node.devPath);
  const sidecars=discoverSubstationGlSidecars(state.currentFiles?.keys()??state.substationEntryPaths,state.currentCbmTree).filter(sidecar=>sidecar.devIdentity===identity);
  for(const sidecar of sidecars)rows.push({label:'辅助连接来源',kind:'gl',value:sidecar.path});
  if(sidecars.length)rows.push({label:'关联证据',value:'同 UUID 辅助来源；未推断连接点空间位置'});
  const child=buildSubstationAliasIndex(state.currentCbmTree).partToChildDev.get(node.path);
  if(child)rows.push({label:'部件语义别名',kind:'dev',value:`DEV/${child}`});
  return rows;
}

export interface InspectorFamilyData {
  path:string;
  sections?:Map<string,Map<string,string>>;
  properties:FamSourceProperty[];
}
/** Resolve/read/classify parameter sources before the view renders any rows. */
export async function inspectNodeParameters(state:AppState,node:CbmNode) {
  const seen=new Set<string>(),properties:FamSourceProperty[]=[];
  const readFamily=async(path:string):Promise<InspectorFamilyData|null>=>{
    if(seen.has(path.toLowerCase()))return null;seen.add(path.toLowerCase());
    const parsed=state.currentFiles ? await readInspectorFamily(state,path) : null;
    const records=parsed?.properties ?? (!state.currentFiles ? getCachedByPath(state.cachedFamSourceProperties,path) : undefined) ?? [];
    properties.push(...records);
    return {path,sections:parsed?.sections ?? (!state.currentFiles ? getCachedByPath(state.cachedFamProperties,path) : undefined),properties:records};
  };
  const cbmFamilies:InspectorFamilyData[]=[],devFamilies:InspectorFamilyData[]=[];
  const refs=resolveBaseFamilyReferences(node.rawProperties??{});
  if(node.famPath&&!refs.some(ref=>ref.path===node.famPath))refs.unshift({key:'BASEFAMILY',path:node.famPath});
  for(const ref of refs){const family=await readFamily(withEntryPrefix('CBM',ref.path));if(family)cbmFamilies.push(family);}
  const dev=node.devPath ? await readDevKv(state,withEntryPrefix('DEV',node.devPath)) : null;
  for(const ref of resolveBaseFamilyReferences(dev??{})){const family=await readFamily(withEntryPrefix('DEV',ref.path));if(family)devFamilies.push(family);}
  return {cbmFamilies,devFamilies,dev,identity:resolveSubstationBusinessIdentity(properties)};
}
export function inspectRegionalConnectionOwnership(state:AppState,modelId:string,object:RegionalObject):IfcConnectionOwnership|undefined {
  return isRegionalConnectionObject(object)
    ? ifcConnectionOwnershipIndex(state.currentCbmTree,state.currentIfcEntries).get(modelId,object.globalId) : undefined;
}

export function findCbmNodeByPath(root: CbmNode | null, path: string): CbmNode | null {
  if (!root) return null;
  const queue: CbmNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node.path === path) return node;
    queue.push(...node.children);
  }
  return null;
}

export function connectionOwnershipRows(state: AppState, evidence: IfcConnectionOwnership): Array<[string,string]> {
  return [
    ['CBM 来源关联', evidence.status === 'confirmed' ? '源 IFCGUID 已核对'
      : evidence.status === 'ambiguous' ? `${evidence.semanticNodes.length} 个来源候选` : '源模型未提供可验证关联'],
    ['DEV 装配归属', evidence.deviceNodes.length === 1
      ? getNodeDisplayName(evidence.deviceNodes[0], state.ifcGuidToName, state.currentIfcEntries)
      : evidence.deviceNodes.length ? `${evidence.deviceNodes.length} 个候选，未自动归属` : '未建立'],
  ];
}

export function connectionEndpointRows(state: AppState, modelId: string, references?: readonly ConnectionEndpointEvidence[]): Array<[string,string]> {
  if(references===undefined)return [['设备端点关联','端点证据尚未收集；未据此推断设备归属']];
  if(!references.length)return [['设备端点关联','未发现可用的已支持引用；整站显示不依赖此关联']];
  const groups=new Map<string,ConnectionEndpointEvidence[]>();
  for(const ref of references){const key=`${ref.kind}:${ref.reference}`,items=groups.get(key)??[];items.push(ref);groups.set(key,items);}
  const index=ifcConnectionOwnershipIndex(state.currentCbmTree,state.currentIfcEntries);
  return [...groups.values()].slice(0,32).map(items=>{
    const ref=items[0];
    if(ref.kind==='ifc-element'){
      const evidence=index.get(modelId,ref.reference);
      return ['IFC 端点对象',evidence.semanticNodes.length===1
        ? `${getNodeDisplayName(evidence.semanticNodes[0],state.ifcGuidToName,state.currentIfcEntries)} · 源连接关系已核对`
        : `${ref.reference} · ${evidence.semanticNodes.length?`${evidence.semanticNodes.length} 个 CBM 候选`:'尚无 CBM/DEV 映射'}`] as [string,string];
    }
    const ports=state.substationConnectionPorts?.get(ref.reference)??[];
    const owners=[...new Map(ports.map(port=>[port.key,port])).values()];
    const names=owners.map(owner=>{
      const node=state.cbmNodeIndex.get(owner.nodePath)??findCbmNodeByPath(state.currentCbmTree,owner.nodePath);
      return node?getNodeDisplayName(node,state.ifcGuidToName,state.currentIfcEntries):owner.nodePath;
    });
    const label=[...new Set(items.map(item=>`${item.propertySet??''} / ${item.propertyName??''}`))].join('；');
    return [label||'源接线点',owners.length===1?`${names[0]} · GUID 与 DEV 装配引用已核对`
      : owners.length?`${owners.length} 个实例候选：${names.join('、')}；未自动归属`
        : `${ref.reference} · ${state.substationConnectionPorts?'没有可验证的 DEV 实例':'接线点 sidecar 证据尚未就绪'}`] as [string,string];
  });
}
