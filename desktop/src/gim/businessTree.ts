import type { CbmNode } from './types.js';
import type { FamSourceProperty } from './famParser.js';
import type { SubstationSpatialIndex, SpatialAssetLink, IfcSpatialObject } from './ifcSpatialParser.js';
import { resolveBaseFamilyReferences, isGimEmptyValue } from './gimValueSemantics.js';
import { assignMaterialOwnership } from './businessOwnership.js';
import { assignBuildingOwnership, businessBuildingName } from './businessBuildings.js';

export const BUSINESS_TREE_VERSION = 'business-tree-v5';
export type MaterialKind = '导线' | '母线' | '金具' | '绝缘子' | '套管' | '电缆' | '接地材料' | '其他材料';
export type BusinessKind = 'device' | 'component' | 'building' | 'structure' | 'foundation' | 'plumbing' | 'lighting' | 'fire' | 'other' | MaterialKind;
export type AssignmentStatus = 'confirmed' | 'inferred' | 'shared' | 'unresolved';
export interface BusinessAssignment {
  status: AssignmentStatus; unitKey: string; evidence: string[]; reason: string;
  candidates?: {unitKey: string; distance: number}[];
  relatedUnitKeys?: string[];
}
export interface BusinessObject {
  key: string; name: string; kind: BusinessKind; cbmPaths: string[]; ifcKeys: string[];
  ifcRefs?: {key:string;modelId:string;globalId:string;expressId:number}[];
  subtype?: string;
  featureKeys?: string[];
  ownerKey?: string; voltage?: number; voltageConflict: boolean; context: string[];
  assignment: BusinessAssignment;
}
export interface BusinessRegion { key: string; title: string; domain: 'installation' | 'construction' | 'unknown'; voltage?: number }
export interface BusinessUnit { key: string; title: string; regionKey: string; kind: 'bus' | 'coupler' | 'section' | 'bay' | 'transformer' | 'shared' | 'unresolved' | 'building'; parentKey?: string }
export interface BusinessTreeProjection {
  version: string; objects: Map<string, BusinessObject>; regions: Map<string, BusinessRegion>; units: Map<string, BusinessUnit>;
  objectBySource: Map<string, string>; cbmByPath: Map<string, CbmNode>; members: Map<string, string[]>;
  sourceGeneration?: number;
}
const materialKinds = new Set<string>(['导线','母线','金具','绝缘子','套管','电缆','接地材料','其他材料']);
export const isBusinessMaterial = (kind: BusinessKind): kind is MaterialKind => materialKinds.has(kind);
const norm = (s: string) => s.replace(/\\/g,'/').toLowerCase();
const generic = /^(?:其他|其它|未分类|未命名|电气系统|交流电气系统|安装工程|建筑工程|辅助及附属构筑物|\d+kV系统)$/i;
const id = (...parts: string[]) => `business:${parts.map(encodeURIComponent).join(':')}`;
const busEquipmentName=(name:string)=>/母线|[ⅠⅡⅢIV]+母|[一二三]母/i.test(name)||/^#?\d+[a-z]?\s*(?:EM\s*)?PT$/i.test(name.trim());
const naturalCompare=(a:string,b:string)=>a.localeCompare(b,'zh-CN',{numeric:true});
const secondaryName=/二次|保护|测控|通信|直流|监控|录波|电能表|电度表|电能量|表计|远动|计量|合并单元|智能终端|辅控|报警|监测|记录分析|报文|控制柜|屏柜|时钟|同步|调度|后台|摄像|视频|门禁|UPS/i;
const bayName=(name:string)=>!/虚拟|收纳|占位/.test(name)&&(/间隔|单元|出线|进线|母联|分段/.test(name)||busEquipmentName(name)||/^#?\d+[\dA-Z-]+$/i.test(name));
export function compareBusinessObjects(a:BusinessObject,b:BusinessObject):number {
  const rank=(o:BusinessObject)=>/中性点/.test(o.name)?1:/变压器|主变本体/.test(o.name)&&!secondaryName.test(o.name)&&!/站用|接地变/.test(o.name)?0:o.kind==='device'||o.kind==='component'?2:3;
  return rank(a)-rank(b)||(rank(a)===1?(b.voltage??businessVoltage([b.name]).value??0)-(a.voltage??businessVoltage([a.name]).value??0):0)||naturalCompare(a.name,b.name)||naturalCompare(a.key,b.key);
}
export function compareBusinessRegions(a:BusinessRegion,b:BusinessRegion):number {
  const rank=(r:BusinessRegion)=>r.key==='business:transformers'?0:r.voltage!=null?1:r.key==='business:reactive'?2:r.key==='business:station-service'?3:r.key==='business:ground'?4:r.key==='business:secondary'?5:9;
  return rank(a)-rank(b)||(b.voltage??0)-(a.voltage??0)||naturalCompare(a.title,b.title);
}
export function compareBusinessUnits(a:BusinessUnit,b:BusinessUnit):number {
  const floor=(u:BusinessUnit)=>u.kind==='building'?u.title.match(/^(-?\d+(?:\.\d+)?)m标高层$/):null;
  const af=floor(a),bf=floor(b);if(af&&bf)return Number(af[1])-Number(bf[1])||naturalCompare(a.key,b.key);
  const rank=(u:BusinessUnit)=>/出线/.test(u.title)?0:/进线/.test(u.title)?1:u.kind==='bus'?2:u.kind==='coupler'?3:u.kind==='section'?4:5;
  return rank(a)-rank(b)||naturalCompare(a.title,b.title);
}
/** Geometric subtraction/addition features describe a host, not another asset. */
export const isBusinessIfcFeature = (type:string):boolean => /^(IFCOPENINGELEMENT|IFCOPENINGSTANDARDCASE|IFCVOIDINGFEATURE|IFCFEATUREELEMENTSUBTRACTION|IFCFEATUREELEMENTADDITION|IFCPROJECTIONELEMENT)$/i.test(type);
export type BusinessFamilyValue = Pick<FamSourceProperty,'label'|'rawKey'|'rawValue'>;
export type BusinessSpatialObject = Pick<IfcSpatialObject,'key'|'modelId'|'globalId'|'expressId'|'ifcType'|'name'|'objectType'|'parentObjectKey'|'hostObjectKey'|'spatialKey'> & Partial<Pick<IfcSpatialObject,'sourcePath'>>;
export type BusinessSpatialInput = Pick<SubstationSpatialIndex,'nodeByKey'> & {objects:readonly BusinessSpatialObject[];objectByKey:ReadonlyMap<string,BusinessSpatialObject>;linksByIfcObjectKey:ReadonlyMap<string,readonly Pick<SpatialAssetLink,'cbmPath'>[]>;shapes?:readonly BusinessShape[];connections?:readonly BusinessConnection[];modelUnits?:ReadonlyMap<string,number>};

const nominalVoltages=new Set([0.22,0.38,0.4,0.66,3,6,10,20,35,66,110,220,330,500,750,1000]);
const classificationRules: [BusinessKind, RegExp][] = [
    ['foundation',/独立基础|设备基础|主变基础|变压器基础|构架基础|承台|基础底板|基础|IFCFOOTING|IFCPILE/i],
    ['plumbing',/给排水|给水|排水|排油|管道类型|管道配件|三通|弯头|大小头|异径管|变径管|卫生器具|水泵|水表|地漏|洗脸盆|大便器|排水沟|IFCSANITARYTERMINAL/i],
    ['structure',/电缆隧道|电缆沟|母线支架|构架|龙门架|支架|道路|围墙|大门|油池|基础|灯杆|防火墙/],
    ['fire',/消防喷雾支架|喷淋支架|消防支架|消防|消火栓|灭火|烟感|烟雾探测|声光报警|火灾探测|IFCFIRESUPPRESSIONTERMINAL/],
    ['lighting',/照明箱|室内空调柜机|空调柜机|空调机组|空调器|照明设备|灯具|投光灯|泛光灯|吊灯|吸顶灯|壁灯|路灯|照明灯|防水灯|防爆灯|荧光灯|应急灯|灯|疏散指示|安全出口|IFCLIGHTFIXTURE/],
    ['building',/建筑物|建筑楼|控制楼|控制室|配电室|泵房|厂房|爬梯|楼梯|栏杆|扶手|检修孔|屋面|屋顶/],
    ['component',/中性点成套装置|中性点设备|散热器|主变本体|变压器本体|操动机构|操作机构|油枕|储油柜/],
    ['device',/电流互感器|电压互感器|组合互感器|组合电器|母线设备|母线柜|H?GIS(?![a-z])|断路器|隔离开关|接地开关|避雷器|变压器|主变|接地变|消弧线圈|电抗器|电容器|开关柜|出线柜|进线柜|馈线柜|端子箱|检修箱|配电箱|照明箱|动力箱|汇控柜|保护柜|测控柜|控制柜|屏柜|录波柜|电能表柜|电度表柜|通信柜|柜|摄像机|摄像头/],
    ['套管',/穿墙套管|套管/],
    ['其他材料',/封堵|抱箍|槽盒支架|桥架支架|电缆支架|支架侧架|支架横档|托臂|槽盒|桥架|接线板/],
    ['金具',/设备线夹|耐张线夹|悬垂线夹|T形线夹|线夹|金具球|金具|均压环|屏蔽环|间隔棒|防振锤|引流板/],
    ['绝缘子',/支柱绝缘子|绝缘子串|绝缘子/], ['接地材料',/接地网|接地极|接地线|接地扁钢|接地圆钢|引下线|避雷带/],
    ['电缆',/电缆/], ['母线',/母线|母排/], ['导线',/钢芯铝绞线|铝绞线|铜绞线|绞线|导线|引流线|软导体|硬导体/],
    ['building',/IFCBEAM|IFCCOLUMN|IFCSLAB|IFCWALL|IFCDOOR|IFCWINDOW|IFCROOF|IFCSTAIR|IFCFOOTING|IFCPILE/i],
  ];
for(const rule of classificationRules)rule[1]=new RegExp(rule[1].source,'gi');
/** The most specific/rightmost noun wins. A bay name is context, not an equipment type. */
export function classifyBusinessObject(name: string, type = ''): BusinessKind {
  // Exporter names often append template parameters after a colon, such as
  // 母线-矩形:标准, 0 V, 单相 相位, 2 导线. Those are not the object's head noun.
  const head=name.split(/[:：]/,1)[0].trim();
  if(head!==name&&!/(?:系统|区域|间隔)(?:布置)?$/.test(head)){
    const kind=classifyBusinessObject(head);if(kind!=='other')return kind;
  }
  // An exporter's generic IFC shape class must not override an explicit name.
  if(type){const named=classifyBusinessObject(name);if(named!=='other')return named;}
  const text = `${name} ${type}`;
  // Long semantic phrases outrank their nested nouns (e.g. 设备线夹双导线).
  let best: {kind: BusinessKind; length: number; end: number} | undefined;
  for (const [kind, pattern] of classificationRules) {
    pattern.lastIndex=0;
    let m:RegExpExecArray|null;
    while((m=pattern.exec(text))) {
      const end = m.index! + m[0].length;
      if (!best || m[0].length > best.length || m[0].length === best.length && end > best.end)
        best = {kind,length:m[0].length,end};
    }
  }
  // System qualifiers must not compete with the object's head noun.
  const cleaned = name.replace(/(?:\d+\s*)?主变区域布置/g,'').replace(/[^\s:：]*?(?:间隔|区域|系统)/g,'');
  if (cleaned !== name && cleaned.trim()) return classifyBusinessObject(cleaned,type);
  return best?.kind ?? 'other';
}

/** Profession refines a generic IFC shape, without assigning its ownership. */
export function classifyBusinessIfcObject(source:BusinessSpatialObject):BusinessKind {
  const path=source.sourcePath??'',name=source.name,kind=classifyBusinessObject(name,source.ifcType+' '+(source.objectType??''));
  // The viewer's building lighting branch includes its ancillary power/HVAC
  // equipment. A box/cabinet noun must not override that explicit profession.
  if(['device','other'].includes(kind)&&/动力照明|照明|暖通/.test(path)&&/照明箱|配电箱|动力箱|检修箱|空调|换气扇|风机|采暖/.test(name))return 'lighting';
  if(/接地|防雷/.test(path)&&/扁钢|圆钢|接地|镀锌/.test(name))return '接地材料';
  if((kind==='plumbing'||kind==='other')&&/消防|喷淋|水喷雾|雨淋|灭火/.test(name+' '+(source.objectType??'')))return 'fire';
  if(/基础/.test(path)&&/IFC(?:SLAB|FOOTING|PILE)/.test(source.ifcType)&&!/楼板|屋面|盖板/.test(name))return 'foundation';
  if(kind==='other'&&/给排水|水工|排水|排油/.test(path))return 'plumbing';
  if(kind==='other'&&/建筑|钢结构|檩条系统|地下夹层/.test(path)&&/IFC(?:BUILDINGELEMENTPROXY|BUILDINGELEMENTPART|MEMBER|PLATE|MECHANICALFASTENER|FASTENER|RAILING|RAMP|STAIR)/.test(source.ifcType))return 'building';
  return kind;
}

export function businessVoltage(values: readonly string[]): {value?: number; conflict: boolean} {
  const volts = new Set<number>();
  for (const text of values) {
    if(/[≥≤<>]/.test(text))continue; // A source voltage range is not a nominal level.
    for (const m of text.matchAll(/(?:AC|DC)?\s*(\d+(?:\.\d+)?)\s*(kV|千伏|V|伏)(?![a-z])/gi)) {
    const n = Number(m[1]) * (/^(?:V|伏)$/i.test(m[2]) ? 0.001 : 1);
    if (n > 0 && n <= 1100) volts.add(n);
    }
  }
  return {value:volts.size === 1 ? [...volts][0] : undefined,conflict:volts.size > 1};
}

export function buildBusinessTree(root: CbmNode, fam: ReadonlyMap<string,readonly BusinessFamilyValue[]> = new Map(), spatial?: BusinessSpatialInput | null): BusinessTreeProjection {
  const p: BusinessTreeProjection = {version:BUSINESS_TREE_VERSION,objects:new Map(),regions:new Map(),units:new Map(),objectBySource:new Map(),cbmByPath:new Map(),members:new Map()};
  const families = new Map([...fam].map(([k,v]) => [norm(k),v]));
  const familyNames=new Map<string,readonly BusinessFamilyValue[]|null>();
  for(const [path,rows]of families){const base=path.split('/').pop()!;familyNames.set(base,familyNames.has(base)?null:rows);}
  const familyRows=(node:CbmNode):readonly BusinessFamilyValue[]=>[...new Set([node.famPath,...resolveBaseFamilyReferences(node.rawProperties??{}).map(r=>r.path)].filter(Boolean))].flatMap(path=>{const key=norm(path);return (key.includes('/')?families.get(key):familyNames.get(key))??[];});
  const parents = new Map<string,CbmNode>();
  const walk = (node: CbmNode, context: string[], owner?: BusinessObject): void => {
    if (p.cbmByPath.has(node.path)) return;
    p.cbmByPath.set(node.path,node);
    const names = node.systemNames?.filter(Boolean) ?? [];
    // Leaf SYSTEMNAME fields may describe only its equipment type. Keep the
    // engineering ancestors; repeated full paths are deduplicated in order.
    const next = [...new Set([...context,...names])];
    const isPart = /^(PARTINDEX|DEV_SUBDEVICE)$/i.test(node.entityName);
    const hasObject = !!node.devPath || !!(node.ifcFile && node.ifcGuid);
    let object = owner;
    if (hasObject && !isPart) {
      const rows = familyRows(node);
      const labels = rows.filter(r => /^(设备名称|设备类型|名称|类型|NAME|TYPE)$/i.test(r.label || r.rawKey)).map(r=>r.rawValue);
      const engineeringName=rows.find(r=>/^(工程中名称|设备名称)$/i.test(r.label||r.rawKey)&&!isGimEmptyValue(r.rawValue))?.rawValue;
      const reserved=engineeringName&&/^(备用|预留)$/.test(engineeringName)?engineeringName:undefined;
      const specific=engineeringName&&!/^(备用|预留|未命名|其他|其它|开关柜|组合电器(?:GIS)?|中性点成套装置|主变有载调压设备|变压器|交流避雷器)$/i.test(engineeringName)?engineeringName:undefined;
      const name = (specific || node.devSymbolName || node.name || labels[0] || node.path)+(reserved?`（${reserved}）`:'');
      const ownVoltage = businessVoltage(rows.filter(r=>/^(?:系统标称电压|系统电压|运行电压|标称电压|电压等级|VoltageLevel)$/i.test(r.label || r.rawKey)).map(r=>r.rawValue));
      const hasExplicitUnit=next.some(bayName);
      const namedVoltage=businessVoltage([name]);
      const material=isBusinessMaterial(classifyBusinessObject(name,`${node.name} ${node.devType??''}`));
      const contextVoltage = !material&&namedVoltage.value!=null&&nominalVoltages.has(namedVoltage.value)?namedVoltage:businessVoltage([...(material?[]:[node.name]),...next.filter(n=>hasExplicitUnit||/配电装置|配电区域|间隔|母线|母联|进线|出线/.test(n))]);
      // A 12 kV equipment rating is not evidence for a 12 kV network region.
      const voltage=ownVoltage.value!=null&&nominalVoltages.has(ownVoltage.value)||ownVoltage.conflict ? ownVoltage:contextVoltage;
      object = {key:id('cbm',node.path),name,kind:classifyBusinessObject(name,`${node.name} ${node.devType ?? ''} ${labels.join(' ')}`),
        cbmPaths:[node.path],ifcKeys:[],voltage:voltage.value!=null&&nominalVoltages.has(voltage.value)?voltage.value:contextVoltage.value!=null&&nominalVoltages.has(contextVoltage.value)?contextVoltage.value:undefined,voltageConflict:voltage.conflict,
        context:next,assignment:{status:'unresolved',unitKey:'',evidence:[],reason:'尚无明确业务归属'}};
      p.objects.set(object.key,object);p.objectBySource.set(node.path,object.key);
    } else if (isPart && owner && hasObject) {
      // An explicit assembly child is a member/alias of its physical root.
      owner.cbmPaths.push(node.path);p.objectBySource.set(node.path,owner.key);
    }
    for (const child of node.children) { parents.set(child.path,node);walk(child,next,object); }
  };
  walk(root,[]);
  if (spatial) for (const source of spatial.objects) {
    if (source.ifcType === 'IFCDISTRIBUTIONPORT' || isBusinessIfcFeature(source.ifcType)) continue;
    const links = spatial.linksByIfcObjectKey.get(source.key) ?? [];
    const matches = new Set(links.map(link=>p.objectBySource.get(link.cbmPath)).filter((v):v is string=>!!v));
    let object: BusinessObject | undefined;
    // One-to-many links remain ambiguous; never choose the first candidate.
    if (matches.size === 1) object = p.objects.get([...matches][0]);
    if (!object) {
      const sourceKind=classifyBusinessIfcObject(source),voltage=['device','component'].includes(sourceKind)?businessVoltage([source.name.split(/[:：]/,1)[0]]):{value:undefined,conflict:false};
      object = {key:id('ifc',source.key),name:source.name,kind:sourceKind,
        cbmPaths:[],ifcKeys:[],voltage:voltage.value!=null&&nominalVoltages.has(voltage.value)?voltage.value:undefined,voltageConflict:voltage.conflict,context:[],
        assignment:{status:'unresolved',unitKey:'',evidence:[],reason:matches.size>1 ? 'IFC 对象存在多个 CBM 候选':'未获得明确间隔归属'}};
      p.objects.set(object.key,object);
    }
    object.ifcKeys.push(source.key);p.objectBySource.set(source.key,object.key);
    (object.ifcRefs??=[]).push({key:source.key,modelId:source.modelId,globalId:source.globalId,expressId:source.expressId});
    object.subtype = /IFCBEAM/.test(source.ifcType)?'梁':/IFCCOLUMN/.test(source.ifcType)?'柱':/IFCSLAB/.test(source.ifcType)?'板':/IFCWALL/.test(source.ifcType)?'墙':/IFCDOOR|IFCWINDOW/.test(source.ifcType)?'门窗':object.subtype;
    if (object.kind === 'other'||object.kind==='device'&&classifyBusinessIfcObject(source)==='lighting') {
      object.kind=classifyBusinessIfcObject(source);
      if(/未命名|无名|^null|^&|^(?:其它|其他)$|^[\da-f-]{32,}$/i.test(object.name)&&source.name&&source.name!=='--')object.name=source.name;
    }
  }
  // A direct GUID may be present before Spatial is built; retain source identity.
  const ensureRegion = (key: string,title: string,domain: BusinessRegion['domain'],voltage?: number) => {
    if (!p.regions.has(key)) p.regions.set(key,{key,title,domain,voltage});return key;
  };
  const unit = (regionKey:string,title:string,kind:BusinessUnit['kind'],identity=title,parentKey?:string) => {
    const key=id(regionKey,identity);if(!p.units.has(key))p.units.set(key,{key,title,kind,regionKey,parentKey});return key;
  };
  for (const object of p.objects.values()) {
    const node = p.cbmByPath.get(object.cbmPaths[0]);
    const source = object.ifcKeys.map(k=>spatial?.objectByKey.get(k)).find(Boolean);
    const context = object.context.filter(n=>!generic.test(n));
    const text = context.join(' '), name=object.name;
    const building = ['building','structure','foundation','plumbing','lighting','fire'].includes(object.kind);
    let region: string, title='', kind: BusinessUnit['kind']='bay', identity='', parentKey: string | undefined;
    if (building) {
      let container = source?.spatialKey ? spatial?.nodeByKey.get(source.spatialKey) : undefined;
      let buildingName='', floorName='',floorKey='';
      const seen = new Set<string>();
      while(container && !seen.has(container.key)) {
        seen.add(container.key);
        if(container.kind==='storey') {floorName=/^IFC.*#/.test(container.name)?`未命名楼层${container.elevation!=null?`（源标高 ${container.elevation}）`:''}`:container.name;floorKey=container.key;}
        if(container.kind==='building') {
          buildingName=/^IFC.*#/.test(container.name)?'':container.name;break;
        }
        container=container.parentKey ? spatial?.nodeByKey.get(container.parentKey) : undefined;
      }
      const explicitBuilding=context.map(businessBuildingName).find(Boolean)||businessBuildingName(buildingName);
      region=ensureRegion(explicitBuilding?id('building',explicitBuilding):'business:construction:site',explicitBuilding||'站区','construction');
      title=object.kind==='fire' ? '消防' : object.kind==='lighting' ? '照明' : explicitBuilding&&floorName || '构筑物及设施';
      kind='building';identity=floorKey || title;
      if(object.kind==='fire'||object.kind==='lighting')identity=title;
    } else {
      const transformerNumber=(value:string)=>value.match(/(?<![\d.])[#＃]?(\d+)\s*号?\s*(?:备用)?主变/)??value.match(/主变(?:本体)?(?:系统|间隔)?\s*(\d+)/);
      const transformer=transformerNumber(text)??(['device','component'].includes(object.kind)&&!/导线|引流线|母线|电缆|线夹|绝缘子/.test(name)?transformerNumber(name):null);
      const isTransformer=!!transformer && Number(transformer[1])>0 && !/进线|出线|母联/.test(text+' '+name) && /主变|散热器|中性点/.test(text+' '+name) && !/测控.*柜|保护.*柜|通信.*柜|控制.*柜|屏柜|开关柜|电容器|电抗器|站用变|接地变/.test(name+' '+(node?.name??''));
      if(secondaryName.test(text)||/录波|电能表|电度表|表计|远动|保护.*柜|测控.*柜|通信.*柜|直流.*(?:柜|屏)|监测.*柜|记录分析/.test(name))region=ensureRegion('business:secondary','二次系统','installation');
      else if(isTransformer) {region=ensureRegion('business:transformers','主变压器系统','installation');title=`${Number(transformer![1])}号主变及其附件`;kind='transformer';}
      else if(object.cbmPaths.length&&['device','component'].includes(object.kind)&&/主变压器|主变本体/.test(name)&&!/进线|出线|中性点|保护|测控|套管/.test(name)){
        region=ensureRegion('business:transformers','主变压器系统','installation');title=`${/备用|预留/.test(name)?'备用':''}主变单元（源未编号）`;kind='transformer';identity=node?.path||object.key;
      }
      else if(/无功|电抗器|电容器|补偿/.test(name)||isBusinessMaterial(object.kind)&&/无功|电抗器|电容器|补偿/.test(text)) region=ensureRegion('business:reactive','无功补偿区域','installation');
      else if(/站用|站变|所用变/.test(text+' '+name))region=ensureRegion('business:station-service','站用电系统','installation');
      else if(object.kind==='接地材料'||(object.kind==='电缆'||object.kind==='其他材料'&&/光缆|桥架|槽盒|电缆支架|支架侧架|支架横档|托臂/.test(name))&&!context.some(bayName)||/接地系统|防雷|站区辅助/.test(text)) region=ensureRegion('business:ground','电缆及接地','installation');
      else if(secondaryName.test(text+' '+name))region=ensureRegion('business:secondary','二次系统','installation');
      else if(object.voltage != null && !object.voltageConflict) {
        const explicitArea=context.find(n=>/配电装置|配电区域|GIS区|AIS区|开关场/i.test(n)&&/屋内|屋外|GIS|AIS|[东西南北]区|第\d+区/i.test(n));
        region=ensureRegion(id('voltage',String(object.voltage),...(explicitArea?[explicitArea]:[])),explicitArea||`${object.voltage}千伏配电装置区域`,'installation',object.voltage);
      }
      else region=object.kind==='other'?ensureRegion('business:unresolved:unknown','待分类','unknown'):ensureRegion('business:unresolved:installation','安装区域待确认','installation');
      if(!title) {
        const bay = region==='business:secondary'?undefined:[...context].reverse().find(bayName);
        const internal = /柜内|内部|母排/.test(name) && !!node?.devPath;
        if(bay && /母联/.test(bay)) {title=bay;kind='coupler';}
        else if(bay && /母分|分段间隔/.test(bay)) {title=bay;kind='section';}
        else if(bay && busEquipmentName(bay) && !internal && !/进线|出线/.test(bay)) {
          if(p.regions.get(region)?.voltage!=null){title='母线设备间隔';kind='bus';}else{title='待确认母线归属';kind='unresolved';}
        }
        else if(bay) title=bay;
        else if(object.kind==='device'&&/电容器|电抗器|站用变压器|站用变/.test(name)){title=`${name}单元`;identity=node?.path||object.key;}
        else if(object.kind==='接地材料'&&/接地网|接地系统/.test(name+' '+text)){title='共享接地系统';kind='shared';}
        else if(region==='business:ground'&&/光缆|电缆|桥架|槽盒|支架侧架|托臂/.test(name)){title='电缆敷设系统';kind='shared';}
        else if(region==='business:secondary'){title=[...context].reverse().find(n=>secondaryName.test(n)&&/系统/.test(n))||(/录波/.test(name)?'故障录波系统':/电能|表计|计量|电度表/.test(name)?'电能计量系统':'控制及二次设备');}
        else if(kind!=='transformer') { title='待确认';kind='unresolved'; }
        // Explicit CBM container identity keeps identically named bays distinct.
        let ancestor=node, container:CbmNode|undefined;
        while(bay&&ancestor) {
          if(ancestor.name===bay || !ancestor.devPath && ancestor.systemNames?.[ancestor.systemNames.length-1]===bay){container=ancestor;break;}
          ancestor=parents.get(ancestor.path);
        }
        identity=kind==='bus' ? 'bus' : kind==='unresolved' ? 'unresolved' : identity || container?.path || (bay ? context.join('/') : title);
      }
    }
    const key=unit(region,title,kind,identity||title,parentKey);
    object.assignment.unitKey=key;
    const known=!region.startsWith('business:unresolved:') && region!=='business:construction:site' && kind!=='unresolved' && !object.voltageConflict && !object.assignment.reason.includes('多个 CBM');
    if(known) {object.assignment.status='confirmed';object.assignment.reason=building?'建筑空间或系统归属':'明确业务单元';object.assignment.evidence=[...context,...(source?.spatialKey?[source.spatialKey]:[])];}
    if(kind==='shared'){object.assignment.status='shared';object.assignment.reason='明确的站区共享系统';}
    if(object.voltageConflict) object.assignment.reason='电压证据冲突';
  }
  if(spatial){
    for(const source of spatial.objects)if(isBusinessIfcFeature(source.ifcType)){
      const host=source.hostObjectKey||source.parentObjectKey,owner=host?p.objects.get(p.objectBySource.get(host)??''):undefined;
      if(owner){(owner.featureKeys??=[]).push(source.key);p.objectBySource.set(source.key,owner.key);}
    }
    for(const source of spatial.objects){if(isBusinessIfcFeature(source.ifcType))continue;const o=p.objects.get(p.objectBySource.get(source.key)??'');if(o&&source.parentObjectKey)o.ownerKey=p.objectBySource.get(source.parentObjectKey);}
    const resolve=(o:BusinessObject,seen:Set<string>):void=>{
      if(o.assignment.status!=='unresolved'||!o.ownerKey||seen.has(o.key)||seen.size>64)return;
      seen.add(o.key);const owner=p.objects.get(o.ownerKey);if(!owner)return;resolve(owner,seen);
      if(['confirmed','inferred'].includes(owner.assignment.status)&&owner.key!==o.key&&!o.voltageConflict&&!o.assignment.reason.includes('多个 CBM'))o.assignment={...owner.assignment,evidence:[...owner.assignment.evidence,'IFC decomposition'],reason:'IFC 装配归属'};
    };
    for(const o of p.objects.values())resolve(o,new Set());
    assignBuildingOwnership(p,spatial);
    assignMaterialOwnership(p,spatial);
    for(const o of p.objects.values())resolve(o,new Set());
  }
  rebuildBusinessMembers(p);
  for(const key of p.units.keys())if(!p.members.get(key)?.length)p.units.delete(key);
  for(const key of p.regions.keys())if(!p.members.get(key)?.length)p.regions.delete(key);
  return p;
}

export function rebuildBusinessMembers(p: BusinessTreeProjection): void {
  p.members.clear();
  const add=(key:string,value:string)=>{const rows=p.members.get(key)??[];rows.push(value);p.members.set(key,rows);};
  for(const object of p.objects.values()) {
    const unit=p.units.get(object.assignment.unitKey)!;
    add(unit.key,object.key);add(unit.regionKey,object.key);add(`business:${p.regions.get(unit.regionKey)!.domain}`,object.key);add('business:root',object.key);
  }
}

export interface BusinessShape { objectKey: string; min: [number,number,number]; max: [number,number,number]; evidence: 'geometry' | 'placement' }
export interface BusinessConnection {objectKey:string;endpointKeys:string[]}
