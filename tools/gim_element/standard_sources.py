"""Standalone source reader. No imports or assets from the Viewer application."""
from pathlib import Path
import re,json,collections,posixpath

def identity(value):return json.dumps(value,ensure_ascii=False,separators=(',',':'))
def decode(data):
    if data.startswith((b'\xff\xfe',b'\xfe\xff')):return data.decode('utf-16')
    sample=data[:512]
    if len(sample)>=8 and len(data)%2==0:
        odd=sample[1::2].count(0)/len(sample[1::2]);even=sample[::2].count(0)/len(sample[::2])
        if odd>.3 and even<.1:return data.decode('utf-16-le')
        if even>.3 and odd<.1:return data.decode('utf-16-be')
    try:return data.decode('utf-8-sig')
    except UnicodeDecodeError:return data.decode('gb18030')
def fields(text,path,family=False):
    rows=[];section=''
    for number,raw in enumerate(text.splitlines(),1):
        line=raw.lstrip('\ufeff').strip()
        if line.startswith('[') and line.endswith(']'):section=line[1:-1];continue
        if not line or line.startswith((';','#','//')) or '=' not in line:continue
        pieces=line.split('=',2 if family else 1);keys=pieces[:-1]
        rows.append({'keys':[k.strip() for k in keys],'value':pieces[-1].strip(),'path':path,'line':number,'section':section,'rawLine':raw})
    return rows
def scalar(rows,key):return next((p['value'] for p in rows if p['keys'][0].upper()==key.upper()),'')

class Reader:
    def __init__(self,root,files=None):
        self.root=Path(root);self.files=files if files is not None else {p.relative_to(self.root).as_posix():p for p in self.root.rglob('*') if p.is_file()}
        self.exact=collections.defaultdict(list);self.bases=collections.defaultdict(list);self.cache={};self.family_cache={};self.records=[];self.references=[];self.aliases=[];self.diagnostics=[]
        for path in self.files:self.exact[self.norm(path)].append(path);self.bases[self.norm(path).rsplit('/',1)[-1]].append(path)
    @staticmethod
    def norm(path):return posixpath.normpath(path.replace('\\','/').strip()).lower().lstrip('/')
    def resolve(self,owner,key,value):
        value=re.sub(r'\.ifc\$$','.ifc',value,flags=re.I);hits=[]
        for candidate in [posixpath.join(posixpath.dirname(owner),value),value]:
            hits=self.exact.get(self.norm(candidate),[])
            if hits:break
        if not hits:hits=self.bases.get(self.norm(value).rsplit('/',1)[-1],[])
        target=hits[0] if len(hits)==1 else None
        self.references.append({'owner':owner,'field':key,'value':value,'target':target,'candidates':hits,'status':'resolved' if target else 'ambiguous' if hits else 'missing'})
        return target
    def document(self,path):
        if path not in self.cache:self.cache[path]=fields(decode(self.files[path].read_bytes()),path,path.lower().endswith('.fam'))
        return self.cache[path]
    def families(self,path):
        if path in self.family_cache:return self.family_cache[path]
        result=[]
        for p in self.document(path):
            if re.match(r'^(?:BASEFAMILY\d*|BASEFAM\d*|FAMILYFILE\d*)$',p['keys'][0],re.I):
                target=self.resolve(path,p['keys'][0],p['value'])
                if target:result.extend(self.document(target))
        self.family_cache[path]=result;return result
    def names(self,row):
        for labels in [('SYMBOLNAME',),('工程中名称','PROJECTNAME'),('设备名称','DEVICENAME'),('NAME','OBJECTNAME','PARTNAME')]:
            for p in row['properties']:
                if any(k.upper() in labels for k in p['keys']) and p['value'].strip() not in ('','-','/','-100','软件自动生成'):
                    row['name']=p['value'];return
        row['name']=''
    def dev(self,path,id,parent,cbm,cbm_id,ancestry,assembly=''):
        if path in ancestry:self.diagnostics.append({'kind':'cycle','source':id});return []
        doc=self.document(path)
        props=(self.families(cbm) if not parent else [])+self.families(path)+doc+(self.document(cbm) if not parent else [])
        row={'id':id,'track':'dev','source':path,'source_type':scalar(doc,'TYPE') or scalar(doc,'DEVICETYPE'),'parent':parent,'properties':props,'cbm':cbm_id,'assemblyPath':assembly}
        self.names(row);self.records.append(row);subtree=[row];counts=collections.Counter(p['keys'][0].upper() for p in doc)
        for p in doc:
            key=p['keys'][0].upper()
            if not re.fullmatch(r'SUBDEVICE\d+',key) or not p['value'].lower().endswith('.dev'):continue
            target=self.resolve(path,key,p['value']);edge=key+('@line:'+str(p['line']) if counts[key]>1 else '')
            if target:subtree+=self.dev(target,id+'/'+edge+':'+target,id,cbm,cbm_id,ancestry|{path},'/'.join(filter(None,[assembly,'sub:'+str(int(re.search(r'\d+',key)[0]))])))
        return subtree
    def cbm(self,path,id,ancestry,scopes):
        if path in ancestry:self.diagnostics.append({'kind':'cycle','source':id});return
        doc=self.document(path);self.families(path);pointer=scalar(doc,'OBJECTMODELPOINTER');next_scopes=scopes
        if pointer:
            target=self.resolve(path,'OBJECTMODELPOINTER',pointer)
            if target:
                hits=[r for r in scopes[-1][0] if r['source']==target and r['id'] not in scopes[-1][1]] if scopes else []
                if hits:
                    self.aliases.append({'sourceId':id,'status':'confirmed' if len(hits)==1 else 'ambiguous','candidates':[r['id'] for r in hits]})
                    if len(hits)==1:hits[0]['properties']+=self.families(path)+doc;self.names(hits[0])
                    ids={r['id'] for r in hits};subset=[r for r in scopes[-1][0] if r['id'] in ids or any(r['id'].startswith(i+'/') for i in ids)]
                    next_scopes=scopes+[(subset,ids)]
                elif scalar(doc,'ENTITYNAME').upper()=='PARTINDEX':
                    self.aliases.append({'sourceId':id,'status':'unresolved','candidates':[]});target_doc=self.document(target)
                    row={'id':'attribute:'+id+':'+target,'track':'dev','source':target,'source_type':scalar(target_doc,'TYPE') or scalar(target_doc,'DEVICETYPE'),'parent':'','attributeOnly':True,'attributeContextId':id,'properties':self.families(path)+self.families(target)+target_doc+doc,
                         'declaredHosts':list(scopes[-1][1]) if scopes else []}
                    self.names(row);self.records.append(row)
                else:
                    rows=self.dev(target,'dev:'+id+':'+target,'',path,id,set());next_scopes=scopes+[(rows,{r['id'] for r in rows[:1]})]
        edges=[p for p in doc if re.fullmatch(r'SUBSYSTEM\d*|SUBDEVICE\d+',p['keys'][0],re.I) and p['value'].lower().endswith('.cbm')];counts=collections.Counter(p['keys'][0].upper() for p in edges)
        for p in edges:
            key=p['keys'][0].upper();target=self.resolve(path,key,p['value']);edge=key+('@line:'+str(p['line']) if counts[key]>1 else '')
            if target:self.cbm(target,id+'/'+edge+':'+target,ancestry|{path},next_scopes)
    def scan(self):
        root=self.resolve('','project-entry','project.cbm')
        if root:self.cbm(root,'cbm:'+root,set(),[])
        else:
            self.references[-1]['status']='entry-fallback'
            cbms=[p for p in self.files if p.lower().endswith('.cbm')];referenced=set()
            for p in cbms:
                for f in self.document(p):
                    if re.fullmatch(r'SUBSYSTEM\d*|SUBDEVICE\d+',f['keys'][0],re.I) and f['value'].lower().endswith('.cbm'):
                        target=self.resolve(p,f['keys'][0],f['value'])
                        if target:referenced.add(target)
            for p in cbms:
                if p not in referenced:self.cbm(p,'cbm:'+p,set(),[])
            if not cbms:
                devs=[p for p in self.files if p.lower().endswith('.dev')];children=set()
                for p in devs:
                    for f in self.document(p):
                        if re.fullmatch(r'SUBDEVICE\d+',f['keys'][0],re.I):
                            target=self.resolve(p,f['keys'][0],f['value'])
                            if target:children.add(target)
                for p in devs:
                    if p not in children:self.dev(p,'dev:standalone:'+p,'',p,'standalone:'+p,set())
        for p in sorted(self.files):
            if p.lower().endswith('.ifc'):self.records.extend(read_ifc(decode(self.files[p].read_bytes()),p))
        return self.records

def split_args(text):
    parts=[];start=0;depth=0;quoted=False;i=0
    while i<len(text):
        c=text[i]
        if c=="'":
            if quoted and i+1<len(text) and text[i+1]=="'":i+=2;continue
            quoted=not quoted
        elif not quoted:
            if c=='(':depth+=1
            elif c==')':depth-=1
            elif c==',' and depth==0:parts.append(text[start:i].strip());start=i+1
        i+=1
    parts.append(text[start:].strip());return parts
def ifc_string(value):
    value=value.strip()
    if value in ('$','*'):return ''
    if value.startswith("'") and value.endswith("'"):value=value[1:-1].replace("''","'")
    def unicode_block(m):
        try:return bytes.fromhex(m[2]).decode('utf-16-be' if m[1]=='2' else 'utf-32-be')
        except (ValueError,UnicodeError):return m[0]
    return re.sub(r'\\X([24])\\([0-9a-fA-F]+)\\X0\\',unicode_block,value)
def read_ifc(text,path):
    # Statements can span lines; quoted semicolons are retained by the scanner.
    entities={};start=None;quoted=False;i=0
    while i<len(text):
        c=text[i]
        if c=="'":
            if quoted and i+1<len(text) and text[i+1]=="'":i+=2;continue
            quoted=not quoted
        elif not quoted:
            if c=='#' and start is None:start=i
            elif c==';' and start is not None:
                match=re.match(r'#(\d+)\s*=\s*(IFC\w+)\s*\((.*)\)\s*;',text[start:i+1],re.S|re.I)
                if match:entities[int(match[1])]=(match[2].upper(),split_args(match[3]))
                start=None
        i+=1
    def refs(value):return [int(n) for n in re.findall(r'#(\d+)',value)]
    def prop(id,seen=None):
        seen=set() if seen is None else seen
        if id in seen or id not in entities:return []
        seen=seen|{id};kind,args=entities[id]
        if kind in ('IFCPROPERTYSET','IFCELEMENTQUANTITY'):
            section=ifc_string(args[2]) if len(args)>2 else ''
            return [dict(p,section=section,containerId=f'{path}#{id}') for child in refs(args[-1]) for p in prop(child,seen)]
        if kind=='IFCPROPERTYSINGLEVALUE' and len(args)>2:
            raw=args[2];typed=re.fullmatch(r'IFC\w+\((.*)\)',raw,re.S|re.I)
            return [{'keys':[ifc_string(args[0])],'value':ifc_string(typed[1] if typed else raw),'path':path,'line':id,'rawLine':raw}]
        return []
    parents={};hosts={};properties=collections.defaultdict(list)
    for id,(kind,args) in entities.items():
        if kind in ('IFCRELAGGREGATES','IFCRELNESTS') and len(args)>5:
            parent=refs(args[4]);
            if parent:
                for child in refs(args[5]):parents[child]=parent[0]
        if kind=='IFCRELVOIDSELEMENT' and len(args)>5:
            host=refs(args[4]);child=refs(args[5])
            if host and child:hosts[child[0]]=host[0]
        if kind=='IFCRELCONNECTSPORTTOELEMENT' and len(args)>5:
            child=refs(args[4]);host=refs(args[5])
            if host and child:hosts[child[0]]=host[0]
        if kind=='IFCRELDEFINESBYPROPERTIES' and len(args)>5:
            values=[p for pid in refs(args[5]) for p in prop(pid)]
            for child in refs(args[4]):properties[child].extend(values)
        if kind=='IFCRELDEFINESBYTYPE' and len(args)>5:
            types=refs(args[5]);definition=entities.get(types[0]) if len(types)==1 else None
            if definition:
                type_args=definition[1];values=[dict(p,applicability='type') for arg in type_args for pid in refs(arg) for p in prop(pid)]
                if type_args[-1].startswith('.') and type_args[-1] not in ('.NOTDEFINED.','.USERDEFINED.'):
                    values.append({'keys':['IFC.PredefinedType'],'value':type_args[-1].strip('.'),'path':path,'line':types[0],'applicability':'type'})
                for child in refs(args[4]):properties[child].extend(values)
    model_hash=0xcbf29ce484222325
    raw=Reader.norm(path).encode('utf-16-le')
    for at in range(0,len(raw),2):model_hash=((model_hash^int.from_bytes(raw[at:at+2],'little'))*0x100000001b3)&0xffffffffffffffff
    model='ifc_'+format(model_hash,'016x');out=[]
    resources=re.compile(r'^IFC(?:REL|MATERIAL|PROPERTY|QUANTITY|SHAPE|REPRESENTATION|BOOLEAN|CARTESIAN|DIRECTION|LOCALPLACEMENT|AXIS|PROFILE|EXTRUDED|GEOMETRIC|OWNER|PERSON|ORGANIZATION|APPLICATION|SIUNIT|UNITASSIGNMENT|PRESENTATION|SURFACE|COLOUR|STYLE|INDEXED|POLY|EDGE|FACE|VERTEX|SHELL|FACETED|CLOSED|OPEN|TEXTURE|TRIANGULATED|ADVANCED|CIRCLE|ELLIPSE|VECTOR|LINE|BSPLINE|SWEPT|MAPPED|COMPOSITE|ARBITRARY|RECTANGLE|CARTESIANTRANSFORMATION|PLANE|AXIS2|AXIS1)')
    for id,(kind,args) in entities.items():
        feature=bool(re.match(r'^IFC(?:OPENING|VOIDING|FEATUREELEMENT|PROJECTIONELEMENT|DISTRIBUTIONPORT|PORT)',kind))
        product_hint=len(args)>=7 and (args[5].startswith('#') or args[6].startswith('#'))
        definition=kind in ('IFCELEMENTQUANTITY','IFCPOSTALADDRESS','IFCTELECOMADDRESS','IFCCLASSIFICATION') or kind.startswith(('IFCTEXTSTYLE','IFCTEXTLITERAL'))
        if len(args)<4 or not (args[0].startswith("'") and len(ifc_string(args[0]))==22 or args[0]=='$' and product_hint) or resources.match(kind) and not feature or definition or kind.endswith(('TYPE','STYLE','PROPERTIES','PROFILEDEF','SYSTEM')) or kind in ('IFCPROJECT','IFCSITE','IFCBUILDING','IFCBUILDINGSTOREY','IFCSPACE','IFCZONE','IFCGROUP'):continue
        sid='ifc:'+identity([model,id]);props=list(properties[id])
        if args[-1].startswith('.') and args[-1].endswith('.') and args[-1] not in ('.NOTDEFINED.','.USERDEFINED.'):
            props=[p for p in props if p['keys']!=['IFC.PredefinedType']];props.append({'keys':['IFC.PredefinedType'],'value':args[-1].strip('.'),'path':path,'line':id})
        parent=parents.get(id,hosts.get(id) if feature else None)
        out.append({'id':sid,'track':'ifc','source':path+'#'+str(id),'source_type':kind,'name':ifc_string(args[2]),'parent':'ifc:'+identity([model,parent]) if parent else '', 'properties':props})
    outward={r['id'] for r in out}
    for row in out:
        if row['parent'] not in outward:row['parent']=''
    return out
