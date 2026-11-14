"""Independent, evidence-first engineering recognition for the small tool.

All rules and vocabularies are bundled beside this module. No Viewer process,
JavaScript runtime, repository checkout or desktop source import is required.
"""
from pathlib import Path
import sys,json,re,hashlib,collections,unicodedata
from standard_sources import Reader,identity

HOME=Path(sys._MEIPASS) if getattr(sys,'frozen',False) else Path(__file__).resolve().parent
def asset(name):return json.loads((HOME/(name+'.json')).read_text(encoding='utf-8'))
CATALOG=asset('catalog');STANDARD=asset('standardCatalog');RULES=asset('catalogRules');VOCAB=asset('sourceVocabulary');ALIASES=asset('sourceTypeAliases');PROXIES=asset('proxyCategories')
LABELS={c['code']:c['label'] for c in CATALOG['categories']};TERMS=collections.defaultdict(list)
def norm(value):return re.sub(r'\s+','',unicodedata.normalize('NFKC',value)).casefold()
for item in STANDARD['items']:
    names=[item['term'],item['label'],*item['term'].split('/')]
    if item['annex'] in ('C.24','B.41'):names+=item['label'].split('/')
    if item['annex']=='D.14':names+=['防火墙']
    for name in names:
        key=norm(name)
        if item not in TERMS[key]:TERMS[key].append(item)
NAME_RULES=[(cat,re.compile(pattern,re.I)) for cat,pattern in RULES['nameRules']]
REFINEMENTS={'E-T':['E01','E03'],'E-R':['E02','E11'],'E16':['E16.terminal_box','E16.panel_cabinet','E16.control_cabinet','E16.battery_set','E16.protection'],'C-B4':['C-B2','C-B3','C-B9'],'C-B5':['C-B6','C-B7'],'C-A1':['C-C1','C-C4'],'C-A2':['C-C1','C-C5','C-B3'],'C-A5':['C-C1','M08']}
def compatible(coarse,fine):return coarse==fine or fine in REFINEMENTS.get(coarse,[])
COMPONENTS={**VOCAB['components'],**{k:v['componentType'] for k,v in VOCAB['keywordDictionary']['entries'].items() if 'componentType' in v}}
def values(row,*keys):
    labels={k.upper() for k in keys};return [p for p in row['properties'] if any(k.upper() in labels for k in p['keys']) and p['value'].strip() not in ('','-','/','-100','软件自动生成')]
def proof(row,p):return identity([row['id'],p.get('path',row['source']),p.get('line',0),p['keys']])
def main_number(value):
    match=re.search(r'#\s*(\d+)\s*(?:备用|预留)?主变|(\d+)\s*(?:号|#)\s*(?:备用|预留)?主变|主变(?:系统)?\s*(\d+)',value)
    return str(int(next(g for g in match.groups() if g))) if match else ''
def numbered(value):
    text=re.sub(r'(?:AC|DC)?\d+(?:\.\d+)?\s*(?:kV|千伏)|模型\d+|\d+(?:[x×*]\d+)+','',value,flags=re.I)
    return bool(re.search(r'#\s*\d+|\d+\s*(?:号|#)|(?:主变|组合电器|避雷器|互感器|电抗器组|电容器组|开关柜|屏柜|设备|装置|支架|基础)\s*\d+|[ⅠⅡⅢⅣⅤ]',text))
def name_category(name,standard_fallback=True):
    text=unicodedata.normalize('NFKC',name);text=re.sub(RULES['nameModifiers'],'',text,flags=re.I)
    text=re.sub(r'_DEV$|\d+(?:\.\d+)?\s*(?:mm|cm|毫米)\b|\d+(?:\.\d+)?(?:[x×*]\d+(?:\.\d+)?)+','',text,flags=re.I);text=re.sub(r'\s+','',text);hits=[]
    for category,pattern in NAME_RULES:
        for m in pattern.finditer(text):
            tail=text[m.end():]
            if re.match(r'^[+、及]',tail) or len(m[0])<=2 and re.match(r'^.{0,5}(?:间隔|系统|区域|进线|出线)',tail):continue
            hits.append((m.start(),m.end(),category))
    groups=[]
    for hit in sorted(hits,key=lambda h:(h[0],-(h[1]-h[0]))):
        if groups and hit[0]<groups[-1][1]:
            if hit[1]-hit[0]>groups[-1][1]-groups[-1][0]:groups[-1]=hit
        else:groups.append(hit)
    category=groups[-1][2] if groups else 'U-OBJECT'
    matches=TERMS.get(norm(text),[])
    if not matches:
        matches=[item for item in STANDARD['items'] if len(item['label'])>=3 and item['label'] in text]
        if matches:
            longest=max(len(i['label']) for i in matches);matches=[i for i in matches if len(i['label'])==longest]
    if standard_fallback and len({i['id'] for i in matches})==1:
        coarse=matches[0]['category']
        if not category.startswith(coarse+'.'):return coarse
    if category!='U-OBJECT':return category
    if re.fullmatch(r'(?:CT|PT)[-_\d]*',text,re.I):return 'E13' if text.upper().startswith('CT') else 'E14'
    if re.match(r'^(LW|ZW)\d',text,re.I):return 'E06'
    if re.match(r'^GW\d',text,re.I):return 'E07'
    if re.match(r'^JW\d',text,re.I):return 'E08'
    return 'E16.panel_cabinet' if re.search(r'[柜屏]$',text) else 'E17' if text.endswith('箱') else 'U-OBJECT'
def category_value(value,allow_name=False):
    if value in LABELS:return value
    items=TERMS.get(norm(value),[]);categories={i['category'] for i in items}
    if len(categories)==1:return next(iter(categories))
    alias=ALIASES['dev'].get(value.casefold(),ALIASES['ifc'].get(value.upper()))
    return ('E-T' if alias=='E01' else alias) if alias else name_category(value) if allow_name else 'U-OBJECT'
def interpret(row,has_children=False):
    type=row['source_type'];props=values(row,'TYPE','DEVICETYPE','EQUIPMENTTYPE','设备类型','设备类别','材料类型','构件类型','MATERIALTYPE','SYSCLASSIFYNAME','PARTNAME')
    props=[dict(p,confidence='candidate') if any(k.upper() in ('SYSCLASSIFYNAME','PARTNAME') for k in p['keys']) and not (VOCAB['keywordDictionary']['entries'].get(p['value'].strip().casefold(),{}).get('evidence',{}).get('verification')=='verified' and VOCAB['keywordDictionary']['entries'].get(p['value'].strip().casefold(),{}).get('evidence',{}).get('originalLocation')) else p for p in props]
    declarations=[{'keys':['source_type'],'value':type,'path':row['source'],'line':0},*props]
    standard=[(item,p) for p in declarations for item in TERMS.get(norm(p['value']),[])];unique={i['id']:i for i,p in standard}
    component=[(COMPONENTS[p['value'].strip().casefold()],p) for p in declarations if p['value'].strip().casefold() in COMPONENTS]
    typed=category_value(type);structured=[(category_value(p['value'],not any(k.upper() in ('SYSCLASSIFYNAME','PARTNAME') for k in p['keys'])),p) for p in props];structured=[(c,p) for c,p in structured if c not in ('U-OBJECT','part')]
    if type=='IFCBUILDINGELEMENTPROXY':
        structured += [(PROXIES['categories'][p['value'].strip()],p) for p in values(row,'类别(Category)','类别','Category') if p['value'].strip() in PROXIES['categories']]
    if not component and typed=='U-OBJECT' and not standard and not TERMS.get(norm(row['name'])):
        candidate=COMPONENTS.get(row['name'].strip().casefold()) or COMPONENTS.get(re.split(r'[_－:：]',row['name'])[-1].strip().casefold())
        if candidate:component=[(candidate,{'keys':['Name'],'value':row['name'],'path':row['source'],'line':0,'confidence':'candidate'})]
    if typed=='E01' and type!='E01':typed='E-T'
    for p in values(row,'IFC.PredefinedType'):
        enum=ALIASES.get('ifcPredefined',{}).get(type+'.'+p['value'].upper())
        if enum:typed=enum;structured.append((enum,p))
    role_values=values(row,'OBJECTROLE','COMPONENTROLE','对象角色','组件角色');roles=set()
    for p in role_values:
        if re.search(r'内部|组成|部件|component|part',p['value'],re.I):roles.add('part')
        if re.search(r'独立|independent',p['value'],re.I):roles.add('independent')
    meaning='object';category=typed;basis='type' if typed!='U-OBJECT' else 'unknown';status='confirmed' if basis=='type' else 'unresolved';evidence=[proof(row,declarations[0])] if basis=='type' else []
    if re.fullmatch(r'IFC(?:DISTRIBUTIONPORT|PORT|OPENINGELEMENT|OPENINGSTANDARDCASE|ANNOTATION|GRID|VOIDINGFEATURE|FEATUREELEMENT.*)',type):meaning='source_only';category=''
    elif type in ('IFCFASTENER','IFCMECHANICALFASTENER'):meaning='detail';category=''
    elif has_children and re.search(RULES['group'],row['name'],re.I) and type in ('IFCELEMENTASSEMBLY','IFCBUILDINGELEMENTPROXY'):meaning='container';category=''
    elif roles=={'part','independent'}:basis='attribute_conflict';category='U-OBJECT'
    elif typed=='part' or 'part' in roles or typed=='U-OBJECT' and len({c for c,p in component})==1 and not standard:meaning='part';category='';basis='object_component_attribute'
    else:
        for c,p in structured:
            if category=='U-OBJECT' or compatible(category,c):category=c;basis='object_attribute';evidence.append(proof(row,p))
            elif not compatible(c,category):category='U-OBJECT';basis='attribute_conflict';break
        if basis!='attribute_conflict' and category!='U-OBJECT':
            identities=[(name_category(p['value'],False),p) for p in values(row,'设备名称','DEVICENAME','PROJECTNAME','工程中名称')]
            identity_name=next(((c,p) for c,p in identities if compatible(category,c)),None);named=name_category(row['name'],False)
            if identity_name and identity_name[0]!=category:category=identity_name[0];basis='type+object_identity';status='candidate';evidence.append(proof(row,identity_name[1]))
            elif compatible(category,named) and category!=named:category=named;basis='type+name_refinement';status='candidate'
        if category=='U-OBJECT' and basis!='attribute_conflict':
            category=name_category(row['name']);basis='object_name' if category!='U-OBJECT' else 'unknown';status='candidate' if category!='U-OBJECT' else 'unresolved'
            if category=='U-OBJECT':
                for p in values(row,'设备名称','DEVICENAME','PROJECTNAME','工程中名称'):
                    named=name_category(p['value'])
                    if named!='U-OBJECT':category=named;basis='family_identity_candidate';status='candidate';break
        if basis=='unknown' and re.search(RULES['part'],row['name']) and not re.search(RULES['independent'],row['name']):meaning='part';category='';basis='component_head'
        if not category or category=='U-OBJECT':
            if re.search(RULES['sourceOnly'],row['name']):meaning='source_only';category=''
        if re.search(r'螺母|螺钉|垫圈|销轴|开口销|膨胀螺栓|^螺栓$',row['name']) and typed=='U-OBJECT' and not structured:meaning='detail';category=''
    designations=values(row,'PROJECTNAME','工程中名称');numbers={main_number(p['value']) for p in designations}-{''};number=next(iter(numbers)) if len(numbers)==1 else ''
    purpose_values=values(row,'用途','设备用途','PURPOSE');purpose={p['value'].strip().casefold() for p in purpose_values}
    if category in ('E01','E-T','E03'):
        if purpose&{'站用','站用变压器','station_service_transformer'}:category='E03';status='confirmed'
        elif purpose&{'主变','主变压器','main_transformer'} or number:category='E01';status='confirmed'
        elif category=='E-T':status='candidate'
    if re.search('neutralpointequipment',type,re.I) or re.search(r'中性点(?:成套|装置|设备)',row['name']):meaning='neutral_set';category='E01'
    if basis in ('type','object_attribute'):status='candidate' if category in ('E-T','E-R','C-B4') else 'confirmed'
    if category=='E01' and number:status='confirmed'
    if basis=='attribute_conflict' or not category:status='unresolved'
    equipment_ids={item['id'] for item,p in standard if item['kind']=='equipment'}
    if len(equipment_ids)>1:
        contexts={(p.get('section'),p.get('containerId'),p.get('applicability')) for item,p in standard if item['kind']=='equipment'}
        category=typed if len(contexts)>1 and typed!='U-OBJECT' else 'U-OBJECT';basis='contextual_type_candidates' if len(contexts)>1 else 'attribute_conflict';status='candidate' if category!='U-OBJECT' else 'unresolved'
    if status=='confirmed' and typed=='U-OBJECT' and structured and all(p.get('confidence')=='candidate' for c,p in structured):status='candidate'
    result={'category':category,'meaning':meaning,'basis':basis,'conflict':'object_attributes_conflict' if basis=='attribute_conflict' else '', 'classificationStatus':status,'categoryStatus':status,'classificationEvidence':list(dict.fromkeys(evidence)), 'sourceName':row['name']}
    if len(unique)==1:
        item=next(iter(unique.values()));result['standardClass']={**{k:item[k] for k in ['id','kind','term','label','category']},'status':'candidate' if all(p.get('confidence')=='candidate' for i,p in standard) else 'confirmed','evidence':[proof(row,p) for i,p in standard]}
    if len({c for c,p in component})==1:result['componentType']={'id':component[0][0],'status':'candidate' if all(p.get('confidence')=='candidate' for c,p in component) else 'confirmed','evidence':[proof(row,p) for c,p in component]}
    return result

def normalize(rows,scope):
    rows=sorted(rows,key=lambda r:r['id']);raw={r['id']:r for r in rows};children=collections.defaultdict(list)
    for r in rows:
        if r['parent']:children[r['parent']].append(r)
    if len(raw)!=len(rows):raise ValueError('Duplicate source occurrence identity')
    parents={r['parent'] for r in rows if r['parent']};meanings={r['id']:interpret(r,r['id'] in parents) for r in rows};entities={};pending={};owners={};diagnostics=[];visiting=set()
    def entity(seed,category,name,proof,sources):
        id='entity:'+identity([scope,seed]);m=meanings[sources[0]]
        if id in entities:return id
        entities[id]={'id':id,'category':category,'name':name,'kind':'whole','boundaryEvidence':proof,'boundaryStatus':'candidate' if m['classificationStatus']!='confirmed' or m.get('standardClass') and not values(raw[sources[0]],'PROJECTNAME','工程中名称','GRIDIDENTIFICATIONSYSTEMCODE','设备编码','电网工程标识系统编码') else 'confirmed','classificationState':'unknown' if category=='U-OBJECT' else 'identified','classificationStatus':m['classificationStatus'],'sourceIds':[],'classificationConflicts':0,'standardClass':m.get('standardClass')}
        for s in sources:owners[s]=id
        return id
    def bundle(source,reason,seed=None):
        id='pending:'+identity([scope,source if seed is None else seed]);pending.setdefault(id,{'id':id,'reason':reason,'sourceIds':[]});owners[source]=id;return id
    # Explicit single-phase designations, never common names or directories.
    banks=collections.defaultdict(list)
    for r in rows:
        m=meanings[r['id']];numbers={main_number(p['value']) for p in values(r,'PROJECTNAME','工程中名称')}-{''}
        if m['meaning']=='object' and m['category']=='E01' and len(numbers)==1 and any(p['value'] in ('1','单相') for p in values(r,'相数','PHASECOUNT')) and not r['parent']:
            banks[next(iter(numbers))+(':reserve' if any(re.search('备用|预留',p['value']) for p in values(r,'PROJECTNAME','工程中名称')) else '')].append(r)
    for number,members in banks.items():
        if len(members)<2:continue
        phases=[p['value'].upper() for r in members for p in values(r,'PHASE','相别','PHASELABEL')];codes={p['value'] for r in members for p in values(r,'GRIDIDENTIFICATIONSYSTEMCODE','设备编码','电网工程标识系统编码')}
        if len(members)>3 or len(phases)!=len(set(phases)) or len(codes)>1:
            for r in members:bundle(r['id'],'transformer_bank_identity_conflict')
            continue
        id=entity('main-bank:'+number,'E01',number.replace(':reserve','号备用')+'号主变','explicit_main_designation+single_phase_bodies',[r['id'] for r in members]);entities[id]['kind']='transformer_bank';entities[id]['boundaryStatus']='candidate'
    def assign(id):
        if id in owners:return owners[id]
        if id in visiting:raise ValueError('Source assembly cycle: '+id)
        visiting.add(id);r=raw[id];m=meanings[id];above=assign(r['parent']) if r['parent'] in raw else None;cat=entities.get(above,{}).get('category');role={p['value'].casefold() for p in values(r,'OBJECTROLE','对象角色','COMPONENTROLE','组件角色')};independent=bool(role&{'independent','独立'})
        if m['basis']=='attribute_conflict':bundle(id,'object_attributes_conflict')
        elif m['meaning']=='neutral_set':
            if cat in ('E01','E-T','E03'):owners[id]=above
            else:bundle(id,'neutral_set_main_unresolved')
        elif above and cat and cat.startswith('E') and cat!='E18' and (m['category'] in ('E16.terminal_box','M10') or m.get('componentType') and not independent):m['meaning']='part';owners[id]=above
        elif m['meaning'] in ('source_only','detail','container'):owners[id]=above
        elif m['meaning']=='part':
            if above:owners[id]=above
            else:bundle(id,'component_whole_unresolved')
        elif above in pending and not independent and not m['category'].startswith('E16') and m['category']!='E17':owners[id]=above
        elif above and cat and cat!='U-OBJECT' and not independent and not (cat.startswith('E') and m['category'] in ('C-B1','C-B2','C-B3','C-B4','C-B9') or cat=='E18' and m['category'].startswith('E') or cat.startswith('C') and (m['category'].startswith('C') and m['category']!=cat or m['category'].startswith('E')) or m['category'].startswith('E16') or m['category']=='E17'):owners[id]=above
        else:entity(id,m['category'],r['name'],'object_identity' if m['category']!='U-OBJECT' else 'outward_object_boundary_unconfirmed',[id])
        visiting.remove(id);return owners.get(id)
    for r in rows:assign(r['id'])
    def host_key(value):
        text=norm(value);n=main_number(value)
        return 'main:'+n+(':reserve' if re.search('备用|预留',value) else ':active') if n and re.search(r'主变(?:压器)?(?:系统)?\d*$',text) else text
    codes=collections.defaultdict(set);names=collections.defaultdict(set)
    def index_hosts():
        for r in rows:
            owner=owners.get(r['id']);m=meanings[r['id']]
            if owner not in entities or not entities[owner]['category'].startswith('E') or entities[owner]['category']=='E18' or m['meaning']!='object':continue
            for p in values(r,'GRIDIDENTIFICATIONSYSTEMCODE','设备编码','电网工程标识系统编码'):codes[host_key(p['value'])].add(owner)
            for p in values(r,'PROJECTNAME','工程中名称'):names[host_key(p['value'])].add(owner)
            if numbered(r['name']):names[host_key(r['name'])].add(owner)
    index_hosts()
    for r in rows:
        id=r['id'];m=meanings[id];explicit_codes=values(r,'HOSTEQUIPMENTID','HOSTEQUIPMENTCODE','PARENTEQUIPMENTID','所属设备编码','宿主设备编码');explicit_names=values(r,'HOSTEQUIPMENTNAME','PARENTEQUIPMENTNAME','所属设备名称','所属设备工程中名称','宿主设备名称');explicit=explicit_codes or explicit_names
        roles={p['value'].casefold() for p in values(r,'OBJECTROLE','对象角色')}
        if roles&{'independent','独立'} or m['basis']=='attribute_conflict':continue
        inferred_name=False
        if m['meaning']=='neutral_set':
            proposed=explicit_names or [p for p in values(r,'PROJECTNAME','工程中名称') if main_number(p['value'])]
        elif m['meaning']=='part' or m.get('componentType',{}).get('status')=='confirmed':
            proposed=explicit_names if explicit else [p for p in values(r,'PROJECTNAME','工程中名称') if numbered(p['value'])]
            prefix=re.split(r'[_－:：]',r['name'])[0]
            if not proposed and not explicit and numbered(prefix):proposed=[{'value':prefix,'keys':['Name'],'path':r['source'],'line':0}];inferred_name=True
        else:continue
        direct=[owners.get(s) for s in r.get('declaredHosts',[])]
        constraints=[{owner} if owner in entities and entities[owner]['category'].startswith(('E','M')) else set() for owner in direct]+[codes[host_key(p['value'])] for p in explicit_codes]+[names[host_key(p['value'])] for p in proposed]
        if not constraints:continue
        candidates=set.intersection(*(set(v) for v in constraints));evidence=[r.get('declaredHostEvidence',{}).get(s,'PARTINDEX:'+str(s)) for s in r.get('declaredHosts',[])]+[proof(r,p) for p in explicit_codes+proposed]
        resolved=[v for v in constraints if v];conflicting=len(resolved)>1 and not set.intersection(*(set(v) for v in resolved))
        if len(candidates)==1:
            target=next(iter(candidates))
            if not explicit and m['meaning']=='object' and target==owners.get(id):continue
            previous=owners.get(id);owners[id]=target;m['membershipEvidence']=evidence;m['membershipStatus']='confirmed' if explicit else 'candidate'
            if m['meaning']!='neutral_set':m['meaning']='part';m['basis']='declared_component_host'
            queue=list(children[id])
            while queue:
                child=queue.pop()
                if owners.get(child['id'])==previous and meanings[child['id']]['meaning'] in ('part','detail','container','source_only'):
                    owners[child['id']]=target;meanings[child['id']]['membershipEvidence']=evidence;meanings[child['id']]['membershipStatus']=m['membershipStatus'];queue.extend(children[child['id']])
        elif not direct and not inferred_name and not any(constraints) and len(proposed)==1 and numbered(proposed[0]['value']) and name_category(proposed[0]['value']).startswith('E') and m['meaning']=='part':
            name=proposed[0]['value'];code=explicit_codes[0]['value'] if explicit_codes else '';seed='declared-host:'+identity([code,host_key(name)]);target=entity(seed,name_category(name),name,'declared_component_host_boundary',[id]);entities[target]['boundaryStatus']='candidate';entities[target]['classificationStatus']='candidate';names[host_key(name)].add(target)
            if code:codes[host_key(code)].add(target)
            m['membershipEvidence']=evidence;m['membershipStatus']='candidate'
        elif explicit or direct or any(constraints):
            reason='component_host_conflict' if conflicting else 'component_host_ambiguous' if any(constraints) else 'component_host_not_found'
            bundle(id,reason,'component-host:'+id);m['membershipStatus']='unresolved';m['membershipEvidence']=evidence
            if conflicting:m['conflict']=reason
            diagnostics.append({'kind':reason,'identity':id,'name':r['name']})
    used=set(owners.values());entities={k:v for k,v in entities.items() if k in used};pending={k:v for k,v in pending.items() if k in used};members=[]
    for r in rows:
        id=r['id'];owner=owners.get(id);m=meanings[id];target=entities.get(owner) or pending.get(owner)
        if target:target['sourceIds'].append(id)
        members.append({'sourceId':id,'ownerId':owner,'interpretation':m,'disposition':'whole_member' if owner in entities else 'pending_whole_member' if owner in pending else 'source_only'})
    return {'scope':scope,'evidenceBinding':{'scope':scope,'sourceRevision':0},'rulesVersion':'gim-element-standard-recognition-1|'+STANDARD['version']+'|'+ALIASES['version'],'entities':sorted(entities.values(),key=lambda e:e['id']),'pending':sorted(pending.values(),key=lambda e:e['id']),'memberships':members,'relationships':[],'aliases':[],'diagnostics':diagnostics}

def scan_standard(root,scope=None):
    reader=Reader(root);records=reader.scan()
    if scope is None:
        digest=hashlib.sha256()
        for path in sorted(reader.files):
            digest.update(path.encode('utf-8')+b'\0')
            if path.lower().endswith(('.cbm','.dev','.fam','.ifc')):digest.update(reader.files[path].read_bytes())
        scope=digest.hexdigest()
    snapshot=normalize(records,scope)
    reasons=(['source-cycle'] if reader.diagnostics else [])+(['source-reference-unresolved'] if any(r['status'] not in ('resolved','entry-fallback') for r in reader.references) else [])
    return {'schema':'gim-element-standard-v1','scope':scope,'engine':{'implementation':'independent-python','rulesVersion':snapshot['rulesVersion'],'standardCatalogVersion':STANDARD['version']},'snapshot':snapshot,'sources':[{k:r.get(k,'') for k in ['id','track','name','source','parent','source_type','attributeOnly','attributeContextId']} for r in records],'sourceAliases':reader.aliases,'sourceReferences':reader.references,'sourceDiagnostics':reader.diagnostics,'complete':not reasons,'incompleteReasons':reasons,'inventory':{**{ext:sum(p.lower().endswith('.'+ext) for p in reader.files) for ext in ['cbm','dev','fam','ifc']},'physicalDevRoots':sum(r['track']=='dev' and not r['parent'] and not r.get('attributeOnly') for r in records),'attributeSources':sum(bool(r.get('attributeOnly')) for r in records),'entries':len(reader.files)}}

def ledger_from_standard(data):
    groups=('设备','装置性材料','构件','其他');snapshot=data['snapshot'];sources={s['id']:s for s in data['sources']};members={m['sourceId']:m for m in snapshot['memberships']};rows=[];totals={g:{'dev':0,'ifc':0,'已确认':0,'候选':0,'未确认':0} for g in groups};tree=[]
    for e in [*snapshot['entities'],*snapshot['pending']]:
        code=e.get('category','U-PENDING');group=groups[0] if code.startswith('E') else groups[1] if code.startswith('M') else groups[2] if code.startswith('C') else groups[3];ids=e['sourceIds'];track='dev' if any(sources[i]['track']=='dev' for i in ids) else 'ifc';status='未确认' if code.startswith('U') else '已确认' if e.get('classificationStatus')=='confirmed' and e.get('boundaryStatus')=='confirmed' else '候选';name=e.get('name','待归整体集合');label=LABELS.get(code,'待归整体');standard=e.get('standardClass') or {}
        rows.append({'group':group,'cat':label,'sub':standard.get('label',''),'template':name,'code':code,'stdcat':label,'std_sub':'','dev':int(track=='dev'),'ifc':int(track=='ifc'),'total':1,'st':{status:1},'samples':[[track,name,'; '.join(sorted({sources[i]['source'] for i in ids})),sources[ids[0]]['source_type'] if ids else '',status,e['id']]],'files':[[sources[i]['source'],1] for i in ids],'entityId':e['id'],'standardClass':standard})
        totals[group][track]+=1;totals[group][status]+=1;tree.append({'id':e['id'],'name':name,'category':code,'pending':'category' not in e,'parts':[{'sourceId':i,'name':sources[i]['name'],'type':sources[i]['source_type'],'source':sources[i]['source'],'rawParent':sources[i]['parent'],'interpretation':members[i]['interpretation']} for i in ids]})
    totals['设备'].update({'台数':sum(e['category'].startswith('E') for e in snapshot['entities']),'附件并入':sum(m['interpretation']['meaning']=='neutral_set' and m['disposition']=='whole_member' for m in snapshot['memberships']),'部件上卷':sum(m['interpretation']['meaning']=='part' and m['disposition']=='whole_member' for m in snapshot['memberships'])})
    buckets={}
    for row in rows:
        template=unicodedata.normalize('NFKC',row['template']);template=re.sub(r'\d+(?:\.\d+)?\s*(?:kv|千伏|mm|cm|毫米)|\d+(?:\.\d+)?(?:[x×*]\d+(?:\.\d+)?)+|\d+','',template,flags=re.I);template=re.sub(r'[_\-—.。、,，:：/\\()（）\s]+','',template).strip('#号第') or row['template']
        key=(row['group'],row['code'],row['sub'],template)
        if key not in buckets:row['template']=template;row['entityIds']=[row['entityId']];buckets[key]=row;continue
        old=buckets[key];old['dev']+=row['dev'];old['ifc']+=row['ifc'];old['total']+=1;old['samples']+=row['samples'];old['files']+=row['files'];old['entityIds'].append(row['entityId'])
        for status,count in row['st'].items():old['st'][status]=old['st'].get(status,0)+count
    return {'rows':list(buckets.values()),'totals':totals,'entityTree':tree,'recognition':data,'stats':{'cbm文件':data['inventory']['cbm'],'dev文件':data['inventory']['dev'],'fam文件':data['inventory']['fam'],'ifc文件':data['inventory']['ifc'],'来源对象':len(sources),'整体':len(snapshot['entities']),'待归整体':len(snapshot['pending']),'仅来源':sum(m['disposition']=='source_only' for m in snapshot['memberships'])}}
