"""Synchronize JSON catalog derivatives and standalone data copies.

JSON is the maintained runtime contract. XLSX is reference material only and is
never read by this command, builds, tests, or runtime configuration loading.
"""
from pathlib import Path
import json,re
ROOT=Path(__file__).resolve().parents[2]
def load(path):return json.loads((ROOT/path).read_text(encoding='utf-8'))
def write(path,data):(ROOT/path).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def snake(term):return re.sub('[^a-z0-9]+','_',re.sub(r'([a-z0-9])([A-Z])',r'\1_\2',term).lower()).strip('_')
def main():
 catalog=load('packages/gim-sdk/src/engineering/catalog.json');standard=load('packages/gim-sdk/src/engineering/standardCatalog.json');policy=load('packages/gim-sdk/src/engineering/recognitionPolicy.json')
 vocab={'version':'substation-vocabulary-1','source':standard['source'],'equipment':{},'equipmentAliases':policy['equipmentAliases'],'components':{},'objectRoles':{},
  'keywordDictionary':{'version':'source-keywords-1','fields':['SYSCLASSIFYNAME','PARTNAME','类型','模型分类名称','装置名称'],'namespace':'standard-model','entries':{}},
  'componentDictionary':{'version':'source-components-1','namespace':'standard-component','entries':{}}}
 def insert(entries,word,id,evidence,field):
  entry=entries.setdefault(word.strip().lower(),{field:[],'evidence':evidence})
  if id not in entry[field]:entry[field].append(id)
  known=entry.get('evidences',[entry['evidence']])
  if evidence not in known:entry['evidences']=[*known,evidence]
  if len(entry[field])>1:entry['evidence']={**entry['evidence'],'verification':'ambiguous'}
  return entry
 entries=vocab['keywordDictionary']['entries']
 for item in standard['items']:
  eq=({'oilimmersedtransformer':'oil_immersed_transformer','gis':'gis','hgis':'hgis','acporcelaincircuitbreaker':'ac_porcelain_circuit_breaker'}.get(item['term'].lower()) or snake(item['term'])) if item['kind']=='equipment' else None
  e=item['evidence'];base={k:e[k] for k in ['sourceKind','workbookSha256','sheet','cellRange','verification','sourceLocation']}
  for word in [item['label'],*item['label'].split('/'),item['term'],*item['term'].split('/'),*item['aliases']]:
   cell=e['termCells'][0] if word in [item['term'],*item['term'].split('/')] else e['nameCell']
   entry=insert(entries,word,item['id'],{**base,'cell':cell},'catalogIds')
   if eq:entry['equipmentType']=eq
  if eq:
   for word in [item['term'],*item['term'].split('/')]:vocab['equipment'][word.lower()]=eq
 for part in catalog['components']:
  for word in [part['label'],*part['label'].split('/'),part['term'],*part['term'].split('/'),*part['aliases']]:
   e=part['evidence'];cell=e['cell'] if word in [part['term'],*part['term'].split('/')] else e['cellRange'].split(':')[0]
   entry=insert(vocab['componentDictionary']['entries'],word,part['id'],{**e,'cell':cell},'componentIds')
   if word==part['term'] and len({p['label'] for p in catalog['components'] if p['term'].lower()==word.lower()})>1:entry['evidence']={**entry['evidence'],'verification':'ambiguous'}
   if len(entry['componentIds'])==1:entry['componentType']=part['id']
   if word==part['term'] or word in part['aliases']:vocab['components'][word.lower()]=part['id']
 for word,id in policy['standardTermDefaults'].items():entries[word.lower()]['defaultCatalogId']=id
 for word,id in policy['componentTermDefaults'].items():
  entry=vocab['componentDictionary']['entries'][word.lower()];entry['defaultComponentId']=id;entry['componentType']=id;vocab['components'][word.lower()]=id
 for category in catalog['categories']:
  item=next(i for i in standard['items'] if i['id']==category['items'][0]);e=item['evidence']
  for word in [category['label'],category['code']]:
   if word.lower() not in entries:insert(entries,word,'category:'+category['code'],{'sourceKind':'workbook','workbookSha256':e['workbookSha256'],'sheet':e['sheet'],'cell':e['categoryCell'],'cellRange':e['categoryCell'],'verification':'verified','sourceLocation':e['sheet']+'!'+e['categoryCell']},'catalogIds')
 for base in ['packages/gim-sdk/src/engineering/','tools/gim_element/']:write(base+'sourceVocabulary.json',vocab)
 for name in ['catalog.json','standardCatalog.json','recognitionPolicy.json','compositionPolicy.json']:write('tools/gim_element/'+name,load('packages/gim-sdk/src/engineering/'+name))
 write('tools/gim_element/sourceCompatibilityPolicy.json',load('packages/gim-sdk/src/engineering/sourceCompatibilityPolicy.json'))
 print('Synchronized JSON model/component vocabularies and standalone policy copies; no workbook input.')
if __name__=='__main__':main()
