"""Independent, evidence-first engineering recognition for the small tool.

All rules and vocabularies are bundled beside this module. No Viewer process,
JavaScript runtime, repository checkout or desktop source import is required.
"""
from pathlib import Path
import sys,json,re,hashlib,collections,unicodedata,functools
from standard_sources import Reader,identity

HOME=Path(sys._MEIPASS) if getattr(sys,'frozen',False) else Path(__file__).resolve().parent
def asset(name):return json.loads((HOME/(name+'.json')).read_text(encoding='utf-8'))
CATALOG=asset('catalog');STANDARD=asset('standardCatalog');COMPOSITION=asset('compositionPolicy');VOCAB=asset('sourceVocabulary');ALIASES=asset('sourceCompatibilityPolicy');PROXIES=asset('proxyCategories')
POLICY=asset('recognitionPolicy')
for item in STANDARD['items']:item['recognitionCode']=POLICY['terms'][item['term'].lower()]
LABELS={c['code']:c['label'] for c in POLICY['recognitionCodes']};TERMS=collections.defaultdict(list)
def norm(value):return re.sub(r'\s+','',unicodedata.normalize('NFKC',value)).casefold()
for item in STANDARD['items']:
    names=[item['term'],item['label'],*item['label'].split('/'),*item['term'].split('/'),*item['aliases']]
    for name in names:
        key=norm(name)
        if item not in TERMS[key]:TERMS[key].append(item)
NAME_TERMS=sorted({norm(label) for item in STANDARD['items'] for label in [item['label'],*item['label'].split('/'),*item['aliases']] if len(label)>=2 and re.search('[\u3400-\u9fff]',label)},key=lambda label:(-len(label),label))
NAME_EXPRESSION=re.compile('|'.join(re.escape(label) for label in NAME_TERMS))
def resolved_terms(value):
    items=TERMS.get(norm(value),[]);preferred=POLICY['standardTermDefaults'].get(norm(value))
    return [item for item in items if item['id']==preferred] if preferred else items
def named_catalog(text):
    exact=resolved_terms(text)
    if exact:return exact
    hits=list(NAME_EXPRESSION.finditer(text))
    if not hits:return []
    longest=max(len(hit[0]) for hit in hits)
    return list({item['id']:item for hit in hits if len(hit[0])==longest for item in resolved_terms(hit[0])}.values())
REFINEMENTS={'E-T':['E01','E03'],'E-R':['E02','E11'],'E16':['E16.panel_cabinet','E16.control_cabinet'],'C-B4':['C-B2','C-B3','C-B9'],'C-A4':['C-A4.steel'],'C-A3':['C-A3.steel']}
def compatible(coarse,fine):return coarse==fine or fine in REFINEMENTS.get(coarse,[])
COMPONENTS=VOCAB['componentDictionary']['entries']
COMPONENT_WORDS=sorted((word for word in COMPONENTS if len(word)>=3 and re.search('[\u3400-\u9fff]',word)),key=lambda w:-len(w))
COMPONENT_EXPRESSION=re.compile('|'.join(re.escape(word) for word in COMPONENT_WORDS))
DIRECTORY_ROLES={c['code']:next(i['recognitionCode'] for i in STANDARD['items'] if i['category']==c['code']) for c in CATALOG['categories']}
DIRECTORY_BY_CODE={key:c for c in CATALOG['categories'] for key in [c['code'],c['label']]}
DIRECTORY_ROLES.update(E01='E-T',E02='E-R')
class EvidenceRecord(dict):
    """Occurrence-local key index; never serialized or attached to raw evidence."""
    def __init__(self,row):
        super().__init__(row);self.by_key=collections.defaultdict(list)
        for at,p in enumerate(row['properties']):
            if p['value'].strip() in ('','-','/','-100','软件自动生成'):continue
            for key in {k.upper() for k in p['keys']}:self.by_key[key].append(at)
def values(row,*keys):
    if isinstance(row,EvidenceRecord):return [row['properties'][at] for at in sorted({at for key in keys for at in row.by_key.get(key.upper(),[])})]
    labels={k.upper() for k in keys};return [p for p in row['properties'] if any(k.upper() in labels for k in p['keys']) and p['value'].strip() not in ('','-','/','-100','软件自动生成')]
def proof(row,p):return identity([row['id'],p.get('path',row['source']),p.get('line',0),p['keys']])
def main_number(value):
    match=re.search(r'#\s*(\d+)\s*(?:备用|预留)?主变|(\d+)\s*(?:号|#)\s*(?:备用|预留)?主变|主变(?:系统)?\s*(\d+)',value)
    return str(int(next(g for g in match.groups() if g))) if match else ''
def numbered(value):
    text=re.sub(r'(?:AC|DC)?\d+(?:\.\d+)?\s*(?:kV|千伏)|模型\d+|\d+(?:[x×*]\d+)+','',value,flags=re.I)
    return bool(re.search(r'#\s*\d+|\d+\s*(?:号|#)|(?:主变|组合电器|避雷器|互感器|电抗器组|电容器组|开关柜|屏柜|设备|装置|支架|基础)\s*\d+|[ⅠⅡⅢⅣⅤ]',text))
@functools.lru_cache(maxsize=4096)
def name_category(name):
    categories={item['recognitionCode'] for item in named_catalog(norm(name))}
    contextual=POLICY['contextualTerms'].get(norm(name),{})
    if not categories and contextual.get('defaultKind')=='material':categories={contextual['materialRecognitionCode']}
    if not categories:
        matches=[c for c in CATALOG['categories'] if c['label'] in norm(name)];longest=max((len(c['label']) for c in matches),default=0)
        categories={DIRECTORY_ROLES[c['code']] for c in matches if len(c['label'])==longest}
    return next(iter(categories)) if len(categories)==1 else 'U-OBJECT'
def category_value(value):
    items=resolved_terms(value)
    if items:return items[0]['recognitionCode'] if len(items)==1 else 'U-OBJECT'
    if value in DIRECTORY_BY_CODE:return DIRECTORY_ROLES[DIRECTORY_BY_CODE[value]['code']]
    alias=ALIASES.get('structured',{}).get(value,ALIASES['dev'].get(value.casefold(),ALIASES['ifc'].get(value.upper())))
    return ('E-T' if alias=='E01' else alias) if alias else 'U-OBJECT'
def interpret(row,has_children=False,equipment_member=False):
    if not isinstance(row,EvidenceRecord):row=EvidenceRecord(row)
    type=row['source_type'];props=values(row,'TYPE','类型','模型分类名称','装置名称','DEVICETYPE','EQUIPMENTTYPE','设备类型','设备类别','材料类型','构件类型','MATERIALTYPE','CONSTRUCTIONTYPE','MATERIALSUBTYPE','EQUIPMENTSUBTYPE','材料子类','设备子类','SYSCLASSIFYNAME','PARTNAME','COMPONENTTYPE','部件类型')
    roles=set()
    for p in values(row,'OBJECTROLE','COMPONENTROLE','对象角色','组件角色'):
        if re.search(r'内部|组成|部件|component|part',p['value'],re.I):roles.add('part')
        if re.search(r'独立|independent',p['value'],re.I):roles.add('independent')
        for role,label in [('source_only','非物理来源'),('detail','细部'),('container','装配容器')]:
            if p['value'].strip().casefold() in (role,label):roles.add(role)
    component_context=equipment_member or 'part' in roles or bool(row.get('declaredHosts')) or bool(values(row,'COMPONENTTYPE','部件类型','所属设备编码','宿主设备编码','HOSTEQUIPMENTID','HOSTEQUIPMENTCODE','PARENTEQUIPMENTID','所属设备名称','所属设备工程中名称','宿主设备名称','HOSTEQUIPMENTNAME','PARENTEQUIPMENTNAME'))
    raw_declarations=[{'keys':['source_type'],'value':type,'path':row['source'],'line':0},*props]
    chinese=[p for p in raw_declarations if re.search('[\u3400-\u9fff]',p['value']) and (resolved_terms(p['value']) or p['value'].strip().casefold() in COMPONENTS)]
    declarations=chinese or raw_declarations
    def context_rule(value):return POLICY['contextualTerms'].get(value.strip().casefold(),{})
    def ground_word(value):return bool(context_rule(value).get('materialRecognitionCode'))
    needs_hint=any(p['value'].strip().casefold() in COMPONENTS and (len(COMPONENTS[p['value'].strip().casefold()]['componentIds'])>1 or COMPONENTS[p['value'].strip().casefold()].get('defaultComponentId') or resolved_terms(p['value'])) for p in declarations)
    hint=next((COMPONENTS[p.strip().casefold()] for p in [*[v['value'] for v in values(row,'设备名称','DEVICENAME')],row['name']] if re.search('[\u3400-\u9fff]',p) and p.strip().casefold() in COMPONENTS),None) if needs_hint else None
    material_rule=next((context_rule(p['value']) for p in declarations if ground_word(p['value'])),None)
    ground_material=bool(material_rule) and (material_rule.get('defaultKind')=='material' or component_context and 'independent' not in roles or any(ground_word(p['value']) for p in values(row,'MATERIALTYPE','材料类型')) or hint and material_rule['componentId'] in hint['componentIds'])
    ground_member=ground_material and component_context and 'independent' not in roles
    if ground_member:roles.add('part')
    def model_terms(value):return [] if ground_material and ground_word(value) else resolved_terms(value)
    standard=[];component=[];ambiguous_namespace=[]
    def verified(entry):return entry.get('defaultCatalogId') or entry.get('defaultComponentId') or entry.get('evidence',{}).get('verification')=='verified' and entry.get('evidence',{}).get('sourceLocation')
    for original in declarations:
        p=dict(original);word=p['value'].strip().casefold();items=model_terms(p['value']);part=COMPONENTS.get(word)
        use_part=False
        if part and not ground_word(p['value']) and 'independent' not in roles:
            if not items or component_context:use_part=True
            elif context_rule(p['value']):use_part=bool(hint and set(hint['componentIds'])&set(part['componentIds']))
            elif word in POLICY['modelPreferredTerms']:use_part=bool(hint and set(hint['componentIds'])&set(part['componentIds']))
            else:ambiguous_namespace.append(word);continue
        if use_part:
            ids=[id for id in part['componentIds'] if hint and id in hint['componentIds']] or ([part['defaultComponentId']] if part.get('defaultComponentId') else part['componentIds'])
            if not verified(part) and not hint:p['confidence']='candidate'
            component.extend((id,p) for id in ids);continue
        family=DIRECTORY_BY_CODE.get(p['value'])
        if not items and family:items=[{'id':'category:'+family['code'],'kind':family['kind'],'label':family['label'],'term':family['code'],'category':family['code'],'recognitionCode':DIRECTORY_ROLES[family['code']],'catalogCategory':family['label'],'catalogGroup':family['groupLabel']}]
        if any(k.upper() in ('SYSCLASSIFYNAME','PARTNAME') for k in p['keys']) and not verified(VOCAB['keywordDictionary']['entries'].get(word,{})):p['confidence']='candidate'
        standard.extend((item,p) for item in items)
    if ground_member:component.append((material_rule['componentId'],next(p for p in declarations if ground_word(p['value']))))
    structured=[(item['recognitionCode'],p) for item,p in standard if p['keys']!=['source_type']]
    structured += [(category_value(p['value']),p) for p in props if p in declarations and not resolved_terms(p['value']) and not (ground_material and ground_word(p['value'])) and p['value'].strip().casefold() not in COMPONENTS]
    structured=[(c,p) for c,p in structured if c not in ('U-OBJECT','part')]
    typed=material_rule['materialRecognitionCode'] if ground_material else category_value(type)
    if component and not standard and not ground_material:typed='part'
    elif ground_material:typed=material_rule['materialRecognitionCode']
    elif ambiguous_namespace:typed='U-OBJECT'
    elif not any(p['keys']==['source_type'] for p in declarations) or standard and not resolved_terms(type):typed='U-OBJECT'
    if not component and not standard and not structured and typed=='U-OBJECT' and not TERMS.get(norm(row['name'])):
        own=row['name'].strip().casefold();tail=re.split(r'[_－:：]',row['name'])[-1].strip().casefold();hit=COMPONENT_EXPRESSION.search(row['name'])
        word=own if own in COMPONENTS else tail if tail in COMPONENTS else hit[0] if hit else None
        if word:component=[(id,{'keys':['Name'],'value':row['name'],'path':row['source'],'line':0,'confidence':'candidate'}) for id in COMPONENTS[word]['componentIds']]
    if type=='IFCBUILDINGELEMENTPROXY':structured += [(PROXIES['categories'][p['value'].strip()],p) for p in values(row,'类别(Category)','类别','Category') if p['value'].strip() in PROXIES['categories']]
    for p in ([] if chinese else values(row,'IFC.PredefinedType')):
        enum=ALIASES.get('ifcPredefined',{}).get(type+'.'+p['value'].upper())
        if enum:typed=enum;structured.append((enum,p))
    if typed=='E01' and type!='E01':typed='E-T'
    meaning='object';category=typed;basis='type' if typed!='U-OBJECT' else 'unknown';status='confirmed' if basis=='type' else 'unresolved'
    if 'source_only' in roles or re.fullmatch(r'IFC(?:DISTRIBUTIONPORT|PORT|OPENINGELEMENT|OPENINGSTANDARDCASE|ANNOTATION|GRID|VOIDINGFEATURE|FEATUREELEMENT.*)',type):meaning='source_only';category=''
    elif 'detail' in roles or type in ('IFCFASTENER','IFCMECHANICALFASTENER'):meaning='detail';category=''
    elif 'container' in roles:meaning='container';category=''
    elif roles=={'part','independent'}:basis='attribute_conflict';category='U-OBJECT'
    elif typed=='part' and 'independent' in roles:category='U-OBJECT'
    elif typed=='part' or 'part' in roles or typed=='U-OBJECT' and any(p.get('confidence')!='candidate' for c,p in component) and not standard:meaning='part';category=typed if typed not in ('U-OBJECT','part') else '';basis='object_component_attribute'
    elif has_children and typed=='U-OBJECT' and not structured and type in ('IFCELEMENTASSEMBLY','IFCBUILDINGELEMENTPROXY'):meaning='container';category=''
    else:
        contexts={(p.get('section'),p.get('containerId'),p.get('applicability')) for c,p in structured}
        if len(contexts)>1 and len({c for c,p in structured})>1:basis='contextual_category_candidates';status='candidate'
        else:
            for c,p in structured:
                if category=='U-OBJECT' or compatible(category,c):category=c;basis='object_attribute'
                elif not compatible(c,category):category='U-OBJECT';basis='attribute_conflict';break
        if basis!='attribute_conflict' and category=='U-OBJECT':
            fallback_name=next((name for name in [*[p['value'] for p in values(row,'设备名称','DEVICENAME','PROJECTNAME','工程中名称')],row['name']] if re.search('[\u3400-\u9fff]',name) and name_category(name)!='U-OBJECT'),row['name'])
            category=name_category(fallback_name);basis='object_name' if category!='U-OBJECT' else 'unknown';status='candidate'
        if basis=='unknown':
            for p in values(row,'设备名称','DEVICENAME','PROJECTNAME','工程中名称'):
                named=name_category(p['value'])
                if named!='U-OBJECT':category=named;basis='family_identity_candidate';status='candidate';break
    numbers={main_number(p['value']) for p in values(row,'PROJECTNAME','工程中名称')}-{''}
    purpose={p['value'].strip().casefold() for p in values(row,'用途','设备用途','PURPOSE')}
    if category in ('E01','E-T','E03'):
        if purpose&{'站用','站用变压器','station_service_transformer'}:category='E03';status='confirmed'
        elif purpose&{'主变','主变压器','main_transformer'} or len(numbers)==1:category='E01';status='confirmed'
        elif category=='E-T':status='candidate'
    if re.search('neutralpointequipment',type,re.I):meaning='neutral_set';category='E01'
    if basis in ('type','object_attribute'):status='candidate' if category in ('E-T','E-R','C-B4') else 'confirmed'
    if category=='E01' and len(numbers)==1:status='confirmed'
    if basis=='attribute_conflict' or not category or category=='U-OBJECT':status='unresolved'
    if status=='confirmed' and typed=='U-OBJECT' and structured and all(p.get('confidence')=='candidate' for c,p in structured):status='candidate'
    unique={item['id']:item for item,p in standard};per_declaration={}
    for item,p in standard:
        key=proof(row,p);previous=per_declaration.get(key);per_declaration[key]=item['id']
        if previous and previous!=item['id']:category='U-OBJECT';basis='standard_category_ambiguous';status='unresolved';break
    if len({i['id'] for i,p in standard if i['kind']=='equipment'})>1:category='U-OBJECT';basis='attribute_conflict';status='unresolved'
    if ambiguous_namespace:category='U-OBJECT';basis='vocabulary_namespace_ambiguous';status='unresolved'
    result={'category':category,'meaning':meaning,'basis':basis,'conflict':'object_attributes_conflict' if basis=='attribute_conflict' else '', 'classificationStatus':status,'categoryStatus':status,'classificationEvidence':[proof(row,p) for p in declarations], 'sourceName':row['name']}
    observations=[]
    for field in VOCAB['keywordDictionary']['fields']:
        for p in values(row,field):
            word=p['value'].strip().casefold();model_entry=VOCAB['keywordDictionary']['entries'].get(word);part_entry=COMPONENTS.get(word)
            entry=part_entry if any(proof(row,candidate)==proof(row,p) for id,candidate in component) else model_entry
            ambiguous=word in ambiguous_namespace or len(resolved_terms(p['value']))>1 or entry and entry['evidence']['verification']=='ambiguous' and not (entry.get('defaultCatalogId') or entry.get('defaultComponentId'))
            observations.append({'field':field,'rawValue':p['value'],'status':'ambiguous' if ambiguous else 'mapped' if entry else 'unresolved','verification':'ambiguous' if ambiguous else entry['evidence']['verification'] if entry else 'unverified','evidenceId':proof(row,p),'dictionaryVersion':VOCAB['keywordDictionary']['version'],'dictionaryEvidence':json.dumps(entry.get('evidences',[entry['evidence']]),ensure_ascii=False) if entry else ''})
    if observations:result['vocabularyObservations']=observations
    if len(unique)==1:
        item=next(iter(unique.values()));result['standardClass']={**{k:item[k] for k in ['id','kind','term','label','category','catalogCategory','catalogGroup']},'status':'candidate' if all(p.get('confidence')=='candidate' for i,p in standard) else 'confirmed','evidence':[proof(row,p) for i,p in standard]}
    if len({c for c,p in component})==1:result['componentType']={'id':component[0][0],'status':'candidate' if all(p.get('confidence')=='candidate' for c,p in component) else 'confirmed','evidence':[proof(row,p) for c,p in component]}
    return result

def unclassified_assembly_candidate(row,meaning):
    if COMPOSITION['unclassifiedAssemblyMembers']['status']!='candidate' or meaning['meaning']!='object' or meaning.get('conflict'):return False
    if meaning['classificationStatus']=='confirmed' or meaning.get('standardClass',{}).get('status')=='confirmed':return False
    if category_value(row['source_type'])!='U-OBJECT':return False
    if values(row,'GRIDIDENTIFICATIONSYSTEMCODE','电网工程标识系统编码','设备编码','PROJECTNAME','工程中名称'):return False
    if values(row,'OBJECTROLE','对象角色','COMPONENTROLE','组件角色'):return False
    # A mapped source classification, even a candidate, is not a blank assembly fragment.
    keys=('TYPE','类型','模型分类名称','装置名称','DEVICETYPE','EQUIPMENTTYPE','设备类型','设备类别','材料类型','构件类型','MATERIALTYPE','CONSTRUCTIONTYPE','SYSCLASSIFYNAME','PARTNAME','材料子类','MATERIALSUBTYPE','设备子类','EQUIPMENTSUBTYPE')
    return not any(category_value(p['value'])!='U-OBJECT' for p in values(row,*keys))

def normalize(rows,scope):
    rows=sorted((r if isinstance(r,EvidenceRecord) else EvidenceRecord(r) for r in rows),key=lambda r:r['id']);raw={r['id']:r for r in rows};children=collections.defaultdict(list)
    for r in rows:
        if r['parent']:children[r['parent']].append(r)
    if len(raw)!=len(rows):raise ValueError('Duplicate source occurrence identity')
    parents={r['parent'] for r in rows if r['parent']};meanings={r['id']:interpret(r,r['id'] in parents) for r in rows};entities={};pending={};owners={};diagnostics=[];visiting=set();equipment_contexts={}
    def entity(seed,category,name,proof,sources):
        id='entity:'+identity([scope,seed]);m=meanings[sources[0]]
        if id in entities:return id
        entities[id]={'id':id,'category':category,'name':name,'kind':'whole','boundaryEvidence':proof,'boundaryStatus':'candidate' if m['classificationStatus']!='confirmed' or m.get('standardClass') and not values(raw[sources[0]],'PROJECTNAME','工程中名称','GRIDIDENTIFICATIONSYSTEMCODE','设备编码','电网工程标识系统编码') else 'confirmed','classificationState':'unknown' if category=='U-OBJECT' else 'identified','classificationStatus':m['classificationStatus'],'sourceIds':[],'classificationConflicts':0,'standardClass':m.get('standardClass')}
        for s in sources:owners[s]=id
        return id
    def bundle(source,reason,seed=None):
        id='pending:'+identity([scope,source if seed is None else seed]);pending.setdefault(id,{'id':id,'reason':reason,'sourceIds':[]});owners[source]=id;return id
    def host_compatibility(meaning,host):
        code=host.get('recognitionCode',host['category'])
        return 'compatible' if code.startswith('E') else 'unconfigured' if code in ('','U-OBJECT') else 'incompatible'
    def accepts_host(meaning,host):return host_compatibility(meaning,host)=='compatible'
    # Explicit single-phase designations, never common names or directories.
    banks=collections.defaultdict(list)
    for r in rows:
        m=meanings[r['id']];numbers={main_number(p['value']) for p in values(r,'PROJECTNAME','工程中名称')}-{''}
        if m['meaning']=='object' and m['category']=='E01' and len(numbers)==1 and any(p['value'] in ('1','单相') for p in values(r,'相数','PHASECOUNT')) and not r['parent'] and not any(re.search('独立|independent',p['value'],re.I) for p in values(r,'OBJECTROLE','对象角色','COMPONENTROLE','组件角色')):
            banks[next(iter(numbers))+(':reserve' if any(re.search('备用|预留',p['value']) for p in values(r,'PROJECTNAME','工程中名称')) else '')].append(r)
    for number,members in banks.items():
        if len(members)<2:continue
        phases=[p['value'].upper() for r in members for p in values(r,'PHASE','相别','PHASELABEL')];codes={p['value'] for r in members for p in values(r,'GRIDIDENTIFICATIONSYSTEMCODE','设备编码','电网工程标识系统编码')}
        if len(members)>3 or len(phases)!=len(set(phases)) or len(codes)>1:
            for r in members:bundle(r['id'],'transformer_bank_identity_conflict')
            continue
        id=entity('main-bank:'+number,'E01',number.replace(':reserve','号备用')+'号主变','explicit_main_designation+single_phase_bodies',[r['id'] for r in members]);entities[id]['kind']='transformer_bank';entities[id]['boundaryStatus']='candidate'
    def declared_equipment(m):return m['category'].startswith('E') and m['basis'] not in ('object_name','standard_name_candidate','family_identity_candidate','unknown')
    def assign(id):
        if id in owners:return owners[id]
        if id in visiting:raise ValueError('Source assembly cycle: '+id)
        visiting.add(id);r=raw[id];m=meanings[id];above=assign(r['parent']) if r['parent'] in raw else None;cat=entities.get(above,{}).get('category');role={p['value'].casefold() for p in values(r,'OBJECTROLE','对象角色','COMPONENTROLE','组件角色')};independent=bool(role&{'independent','独立'})
        parent_meaning=meanings.get(r['parent']);parent_equipment=equipment_contexts.get(r['parent'],False) or bool(parent_meaning and declared_equipment(parent_meaning))
        if parent_equipment and not independent and any(p['value'].strip().casefold() in POLICY['contextualTerms'] for p in [{'value':r['source_type']},*values(r,'TYPE','类型','模型分类名称','装置名称','DEVICETYPE','EQUIPMENTTYPE','MATERIALTYPE','SYSCLASSIFYNAME','PARTNAME','设备类型','设备类别','材料类型','材料子类','MATERIALSUBTYPE','设备子类','EQUIPMENTSUBTYPE','COMPONENTTYPE','部件类型')]):
            m=interpret(r,id in parents,equipment_member=True);meanings[id]=m
        if m['basis']=='attribute_conflict':bundle(id,'object_attributes_conflict')
        elif (above in entities and parent_equipment and not independent and not m.get('conflict')
              and r.get('track')=='dev' and r['parent'] and m.get('componentType',{}).get('status')!='confirmed'
              and not unclassified_assembly_candidate(r,m) and m['meaning'] not in ('source_only','container','detail','neutral_set')):
            owners[id]=above;m['meaning']='part';m['independent']=False;m['membershipStatus']='confirmed';m['basis']='source_composition_member'
            m['membershipEvidence']=['assembly:'+r['parent']+'->'+id,'policy:'+COMPOSITION['version']+':whole-boundary']
        elif m['meaning']=='neutral_set':
            if cat in ('E01','E-T','E03') and not independent:owners[id]=above
            else:bundle(id,'neutral_set_main_unresolved')
        elif above in entities and m.get('componentType',{}).get('status')=='confirmed' and not independent:
            compatibility=host_compatibility(m,entities[above])
            if compatibility=='compatible':m['meaning']='part';m['membershipStatus']='confirmed';owners[id]=above
            else:
                reason='component_host_'+compatibility;bundle(id,reason);m['membershipStatus']='unresolved';diagnostics.append({'kind':reason,'identity':id,'name':r['name']})
        elif m['meaning'] in ('source_only','detail','container'):owners[id]=above
        elif above and parent_equipment and unclassified_assembly_candidate(r,m):
            owners[id]=above;m['meaning']='part';m['membershipStatus']='candidate';m['basis']='unclassified_equipment_assembly_member'
            m['membershipEvidence']=['assembly:'+r['parent']+'->'+id,'policy:'+COMPOSITION['version']+':unclassified-assembly-member']
        elif m['meaning']=='part':
            if m.get('componentType') and m['componentType']['status']!='confirmed' and not role&{'part','内部部件','部件'}:bundle(id,'component_type_unresolved');m['membershipStatus']='unresolved'
            elif above:owners[id]=above;m['membershipStatus']='confirmed'
            else:bundle(id,'component_whole_unresolved')
        else:entity(id,m['category'],r['name'],'object_identity' if m['category']!='U-OBJECT' else 'outward_object_boundary_unconfirmed',[id])
        equipment_contexts[id]=declared_equipment(m) or parent_equipment and m['meaning'] in ('part','container','detail','source_only')
        visiting.remove(id);return owners.get(id)
    for r in rows:assign(r['id'])
    def host_key(value):
        text=norm(value);n=main_number(value)
        return 'main:'+n+(':reserve' if re.search('备用|预留',value) else ':active') if n and re.search(r'主变(?:压器)?(?:系统)?\d*$',text) else text
    codes=collections.defaultdict(set);names=collections.defaultdict(set)
    def index_hosts():
        for r in rows:
            owner=owners.get(r['id']);m=meanings[r['id']]
            if owner not in entities or not entities[owner]['category'].startswith('E') or m['meaning']!='object':continue
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
            proposed=explicit_names
        else:continue
        direct=[owners.get(s) for s in r.get('declaredHosts',[])]
        constraints=[{owner} if owner in entities and entities[owner]['category'].startswith('E') else set() for owner in direct]+[codes[host_key(p['value'])] for p in explicit_codes]+[names[host_key(p['value'])] for p in proposed]
        if not constraints:continue
        matched=set.intersection(*(set(v) for v in constraints));candidates={id for id in matched if accepts_host(m,entities[id])};evidence=[r.get('declaredHostEvidence',{}).get(s,'PARTINDEX:'+str(s)) for s in r.get('declaredHosts',[])]+[proof(r,p) for p in explicit_codes+proposed]
        resolved=[v for v in constraints if v];conflicting=len(resolved)>1 and not set.intersection(*(set(v) for v in resolved))
        if len(candidates)==1:
            target=next(iter(candidates))
            if not explicit and m['meaning']=='object' and target==owners.get(id):continue
            previous=owners.get(id)
            composition_conflict=previous in entities and previous!=target and m.get('membershipStatus')=='confirmed' and bool(r['parent'])
            if composition_conflict:
                target=bundle(id,'composition_host_conflict','component-host:'+id);m['conflict']='composition_host_conflict'
                diagnostics.append({'kind':'composition_host_conflict','identity':id,'name':r['name']})
            owners[id]=target;m['membershipEvidence']=evidence;m['membershipStatus']='unresolved' if composition_conflict else 'confirmed' if explicit or direct else 'candidate'
            if m['meaning']!='neutral_set':m['meaning']='part';m['basis']='declared_component_host'
            queue=list(children[id])
            while queue:
                child=queue.pop()
                if owners.get(child['id'])==previous and meanings[child['id']]['meaning'] in ('part','detail','container','source_only'):
                    owners[child['id']]=target;meanings[child['id']]['membershipEvidence']=evidence;meanings[child['id']]['membershipStatus']=m['membershipStatus'];queue.extend(children[child['id']])
        elif not direct and not inferred_name and not any(constraints) and len(proposed)==1 and numbered(proposed[0]['value']) and (main_number(proposed[0]['value']) or name_category(proposed[0]['value']).startswith('E')) and m['meaning']=='part' and accepts_host(m,{'category':'E01' if main_number(proposed[0]['value']) else name_category(proposed[0]['value'])}):
            name=proposed[0]['value'];code=explicit_codes[0]['value'] if explicit_codes else '';seed='declared-host:'+identity([code,host_key(name)]);target=entity(seed,'E01' if main_number(name) else name_category(name),name,'declared_component_host_boundary',[id]);entities[target]['boundaryStatus']='candidate';entities[target]['classificationStatus']='candidate';names[host_key(name)].add(target)
            if code:codes[host_key(code)].add(target)
            m['membershipEvidence']=evidence;m['membershipStatus']='candidate'
        elif explicit or direct or any(constraints):
            reason='component_host_conflict' if conflicting else 'component_host_unconfigured' if matched and not candidates and any(host_compatibility(m,entities[id])=='unconfigured' for id in matched) else 'component_host_incompatible' if matched and not candidates else 'component_host_ambiguous' if any(constraints) else 'component_host_not_found'
            bundle(id,reason,'component-host:'+id);m['membershipStatus']='unresolved';m['membershipEvidence']=evidence
            if conflicting:m['conflict']=reason
            diagnostics.append({'kind':reason,'identity':id,'name':r['name']})
    subtype_witnesses=collections.defaultdict(dict);wanted_components={id for rule in COMPOSITION['hostSubtypes'] for id in rule['requiresComponents']+rule['conflictsWith']}
    used=set(owners.values());entities={k:v for k,v in entities.items() if k in used};pending={k:v for k,v in pending.items() if k in used};members=[]
    for r in rows:
        id=r['id'];owner=owners.get(id);m=meanings[id];target=entities.get(owner) or pending.get(owner)
        if target:target['sourceIds'].append(id)
        component=m.get('componentType',{})
        if owner in entities and m['meaning']=='part' and component.get('status')=='confirmed' and component.get('id') in wanted_components:
            subtype_witnesses[owner].setdefault(component['id'],component['evidence'])
        members.append({'sourceId':id,'ownerId':owner,'interpretation':m,'disposition':'whole_member' if owner in entities else 'pending_whole_member' if owner in pending else 'source_only'})
    for e in entities.values():
        witnesses=subtype_witnesses.get(e['id'],{})
        matches=[rule for rule in COMPOSITION['hostSubtypes'] if e['category'] in rule['hostRecognitionCodes'] and e['classificationStatus']=='confirmed' and all(id in witnesses for id in rule['requiresComponents']) and not any(id in witnesses for id in rule['conflictsWith'])]
        if len(matches)==1:
            rule=matches[0];e.update(subtype=rule['id'],subtypeLabel=rule['label'],subtypeStatus='confirmed',subtypeEvidence=['policy:'+COMPOSITION['version']+':host-subtype:'+rule['id']]+[proof for id in rule['requiresComponents'] for proof in witnesses[id]])
        publish_category(e)
    for m in members:publish_category(m['interpretation'])
    return {'scope':scope,'evidenceBinding':{'scope':scope,'sourceRevision':0},'rulesVersion':'gim-element-standard-recognition-1|'+STANDARD['version']+'|'+ALIASES['version'],'entities':sorted(entities.values(),key=lambda e:e['id']),'pending':sorted(pending.values(),key=lambda e:e['id']),'memberships':members,'relationships':[],'aliases':[],'diagnostics':diagnostics}

def publish_category(value):
    code=value['category'];value['recognitionCode']=code
    if code=='U-OBJECT' or not code:return
    specific=value.get('standardClass');definition=SEMANTIC_BY_CODE.get(code,{})
    matches=[i for i in STANDARD['items'] if i['recognitionCode']==code]
    preferred=INDEX_BY_ID.get(definition.get('catalogId'))
    categories={i['category'] for i in matches};family=definition.get('catalogFamily',{})
    fallback=next((c['code'] for c in CATALOG['categories'] if c['kind']==family.get('kind') and c['label']==family.get('label')),'U-OBJECT')
    value['category']=specific['category'] if specific else preferred['category'] if preferred else next(iter(categories)) if len(categories)==1 else fallback
    if value['category']=='U-OBJECT':
        value['classificationStatus']='unresolved';value['categoryStatus']='unresolved'
    if 'classificationState' in value:value['classificationState']='unknown' if value['category']=='U-OBJECT' else 'identified'
    if value['category']!='U-OBJECT' and specific and specific['status']=='confirmed' and not value.get('conflict'):
        value['classificationStatus']='confirmed';value['categoryStatus']='confirmed'

def scan_standard(root,scope=None,files=None,entry_count=None):
    reader=Reader(root,files=files);records=reader.scan()
    if scope is None:
        digest=hashlib.sha256()
        for path in sorted(reader.files):
            digest.update(path.encode('utf-8')+b'\0')
            if path.lower().endswith(('.cbm','.dev','.fam','.ifc')):digest.update(reader.files[path].read_bytes())
        scope=digest.hexdigest()
    snapshot=normalize(records,scope)
    reasons=(['source-cycle'] if reader.diagnostics else [])+(['source-reference-unresolved'] if any(r['status'] not in ('resolved','entry-fallback') for r in reader.references) else [])
    return {'schema':'gim-element-standard-v1','scope':scope,'engine':{'implementation':'independent-python','rulesVersion':snapshot['rulesVersion'],'standardCatalogVersion':STANDARD['version']},'snapshot':snapshot,'sources':[{k:r.get(k,'') for k in ['id','track','name','source','parent','source_type','attributeOnly','attributeContextId']} for r in records],'sourceAliases':reader.aliases,'sourceReferences':reader.references,'sourceDiagnostics':reader.diagnostics,'complete':not reasons,'incompleteReasons':reasons,'inventory':{**{ext:sum(p.lower().endswith('.'+ext) for p in reader.files) for ext in ['cbm','dev','fam','ifc']},'physicalDevRoots':sum(r['track']=='dev' and not r['parent'] and not r.get('attributeOnly') for r in records),'attributeSources':sum(bool(r.get('attributeOnly')) for r in records),'entries':entry_count if entry_count is not None else len(reader.files)}}

INDEX_BY_ID={row['id']:row for row in STANDARD['items']}
SEMANTIC_BY_CODE={row['code']:row for row in POLICY['recognitionCodes']}
PART_BY_ID={row['id']:row for row in CATALOG['components']}
PART_BY_TERM={row['term'].lower():row for row in CATALOG['components']}
def catalog_location(entity):
    code=entity.get('category','U-PENDING')
    item=INDEX_BY_ID.get((entity.get('standardClass') or {}).get('id'))
    if item and item['category']!=code:item=None
    if code.startswith('U'):item=None
    matches=[row for row in STANDARD['items'] if row['category']==code]
    if not item and len(matches)==1:item=matches[0]
    if item:return {'kind':item['kind'],'group':item['catalogGroup'],'category':item['catalogCategory'],'label':item['label'],'id':item['id'],'order':item['order']}
    row=next((c for c in CATALOG['categories'] if c['code']==code),None)
    family={'kind':row['kind'],'label':row['label']} if row else None
    if matches and len({(row['kind'],row['catalogCategory']) for row in matches})==1:family={'kind':matches[0]['kind'],'label':matches[0]['catalogCategory']}
    if family:return {'kind':family['kind'],'group':{'equipment':'设备','material':'材料','construction':'构件'}[family['kind']],'category':family['label'],'label':'类型待确认','id':code,'order':999}
    kind='unknown'
    return {'kind':kind,'group':{'equipment':'设备','material':'材料','construction':'构件','unknown':'其他'}[kind],'category':'类别待确认','label':'类型待确认','id':code,'order':999}

def ledger_from_standard(data):
    groups=('设备','材料','构件','其他');snapshot=data['snapshot'];sources={s['id']:s for s in data['sources']};members={m['sourceId']:m for m in snapshot['memberships']};rows=[];totals={g:{'dev':0,'ifc':0,'已确认':0,'候选':0,'未确认':0} for g in groups};tree=[]
    for e in [*snapshot['entities'],*snapshot['pending']]:
        pending='category' not in e;code=e.get('category','U-PENDING');ids=e['sourceIds'];track='dev' if any(sources[i]['track']=='dev' for i in ids) else 'ifc';name=e.get('name','待归整体集合')
        classification=e
        if pending:
            known=next((members[i]['interpretation'].get('standardClass') for i in ids if members[i]['interpretation'].get('standardClass')),None)
            if known:classification={'category':known['category'],'standardClass':known}
        catalog=catalog_location(classification);group=catalog['group'];label=catalog['category'];sub=e['subtypeLabel'] if e.get('subtypeStatus')=='confirmed' and any(rule['id']==e.get('subtype') for rule in COMPOSITION['hostSubtypes']) else '' if catalog['label']==label else catalog['label']
        status='未确认' if pending or code.startswith('U') else '已确认' if e.get('classificationStatus')=='confirmed' and e.get('boundaryStatus')=='confirmed' and (e.get('standardClass') or {}).get('status')!='candidate' else '候选'
        counted=int(not pending)
        parts=[]
        for i in ids:
            meaning=members[i]['interpretation'];component=(meaning.get('componentType') or {}).get('id');part_label=PART_BY_ID.get(component,{}).get('label') or (meaning.get('standardClass') or {}).get('label') or '未识别部件'
            parts.append({'sourceId':i,'name':sources[i]['name'],'type':sources[i]['source_type'],'source':sources[i]['source'],'rawParent':sources[i]['parent'],'interpretation':meaning,'componentLabel':part_label,'componentOrder':PART_BY_ID.get(component,{}).get('order',999)})
        rows.append({'group':group,'cat':label,'sub':sub,'template':name,'code':code,'stdcat':label,'std_sub':'','catalogId':catalog['id'],'catalogOrder':next((c['order'] for c in CATALOG['categories'] if c['kind']==catalog['kind'] and c['label']==label),999),'modelOrder':catalog['order'],'dev':int(track=='dev')*counted,'ifc':int(track=='ifc')*counted,'total':counted,'st':{status:1},'samples':[[track,name,'; '.join(sorted({sources[i]['source'] for i in ids})),sources[ids[0]]['source_type'] if ids else '',status,e['id']]],'files':[[sources[i]['source'],1] for i in ids],'entityId':e['id'],'standardClass':e.get('standardClass') or {}})
        totals[group][track]+=counted;totals[group][status]+=1;tree.append({'id':e['id'],'name':name,'category':code,'catalog':catalog,'pending':pending,'parts':parts})
    totals['设备'].update({'台数':sum(catalog_location(e)['kind']=='equipment' for e in snapshot['entities']),'附件并入':sum(m['interpretation']['meaning']=='neutral_set' and m['disposition']=='whole_member' for m in snapshot['memberships']),'部件上卷':sum(m['interpretation']['meaning']=='part' and m['disposition']=='whole_member' for m in snapshot['memberships'])})
    buckets={}
    for row in rows:
        template=unicodedata.normalize('NFKC',row['template']);template=re.sub(r'\d+(?:\.\d+)?\s*(?:kv|千伏|mm|cm|毫米)|\d+(?:\.\d+)?(?:[x×*]\d+(?:\.\d+)?)+|\d+','',template,flags=re.I);template=re.sub(r'[_\-—.。、,，:：/\\()（）\s]+','',template).strip('#号第') or row['template']
        key=(row['group'],row['cat'],row['sub'],template)
        if key not in buckets:row['template']=template;row['entityIds']=[row['entityId']];buckets[key]=row;continue
        old=buckets[key];old['dev']+=row['dev'];old['ifc']+=row['ifc'];old['total']+=row['total'];old['samples']+=row['samples'];old['files']+=row['files'];old['entityIds'].append(row['entityId'])
        for status,count in row['st'].items():old['st'][status]=old['st'].get(status,0)+count
    return {'rows':sorted(buckets.values(),key=lambda r:(groups.index(r['group']),r['catalogOrder'],r['modelOrder'],r['template'])),'totals':totals,'entityTree':tree,'recognition':data,'stats':{'cbm文件':data['inventory']['cbm'],'dev文件':data['inventory']['dev'],'fam文件':data['inventory']['fam'],'ifc文件':data['inventory']['ifc'],'来源对象':len(sources),'整体':len(snapshot['entities']),'待归整体':len(snapshot['pending']),'仅来源':sum(m['disposition']=='source_only' for m in snapshot['memberships'])}}
