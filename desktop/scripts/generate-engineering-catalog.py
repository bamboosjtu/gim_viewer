"""Generate runtime catalogs from the developer-maintained XLSX. No PDF input.
Uses only Python's standard library; this is a repository maintenance command,
not a dependency of any standalone tool's runtime or packaging.
"""
from pathlib import Path
import json,hashlib,re,zipfile,argparse,xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parents[2]
BOOK=ROOT/'docs/engineering/catalogs/变电三维设计建模规范_实体索引表.xlsx'
NS={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
def load(path):return json.loads(path.read_text(encoding='utf-8'))
def write(path,data):path.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def sheets():
 with zipfile.ZipFile(BOOK) as z:
  shared=[]
  if 'xl/sharedStrings.xml' in z.namelist():shared=[''.join(i.itertext()) for i in ET.fromstring(z.read('xl/sharedStrings.xml'))]
  rels={i.attrib['Id']:i.attrib['Target'].lstrip('/') for i in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
  styles=ET.fromstring(z.read('xl/styles.xml'));fills=styles.find('s:fills',NS);yellow=set()
  for i,fill in enumerate(fills):
   color=fill.find('s:patternFill/s:fgColor',NS)
   if color is not None and color.attrib.get('rgb','').upper().endswith('FFFF00'):yellow.add(i)
  yellow_styles={i for i,xf in enumerate(styles.find('s:cellXfs',NS)) if int(xf.attrib.get('fillId','0')) in yellow}
  result={}
  for sheet in ET.fromstring(z.read('xl/workbook.xml')).find('s:sheets',NS):
   target=rels[sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]
   if not target.startswith('xl/'):target='xl/'+target
   rows=[]
   for row in ET.fromstring(z.read(target)).find('s:sheetData',NS):
    cells={}
    for cell in row:
     if int(cell.attrib.get('s','0')) in yellow_styles:cells['_highlighted']=True
     address=cell.attrib['r'];value=cell.find('s:v',NS);value=value.text if value is not None else ''
     if cell.attrib.get('t')=='s':value=shared[int(value)]
     elif cell.attrib.get('t')=='inlineStr':value=''.join(cell.find('s:is',NS).itertext())
     cells[re.sub(r'\d','',address)]=value
    rows.append((int(row.attrib['r']),cells))
   result[sheet.attrib['name']]=rows
  return result

def snake(term):return re.sub('[^a-z0-9]+','_',re.sub(r'([a-z0-9])([A-Z])',r'\1_\2',term).lower()).strip('_')
def main():
 book=sheets();digest=hashlib.sha256(BOOK.read_bytes()).hexdigest()
 source={'kind':'workbook','path':BOOK.relative_to(ROOT).as_posix() if BOOK.is_relative_to(ROOT) else BOOK.name,'sha256':digest}
 policy=load(ROOT/'desktop/src/engineering/recognitionPolicy.json')
 mapping=policy['terms'];semantic=policy['recognitionCodes']
 bycode={c['code']:c for c in semantic};items=[];categories=[]
 groups=[('equipment','设备','电气设备模型索引表','equipment'),('material','材料','材料模型索引表','materials'),('construction','构件','构件模型索引表','components')]
 for kind,label,sheet,semantic_group in groups:
  current_category=''
  for row,cells in book[sheet]:
   if row==1 or not cells.get('B'):continue
   current_category=cells.get('A') or current_category;name,term=cells['B'],cells['C']
   recognition=mapping.get(term.lower(),{'equipment':'E-X.','material':'M-X.','construction':'C-X.'}[kind]+snake(term))
   key=kind+':'+term.lower();groupkey=kind+':'+current_category
   if not any(c['id']==groupkey for c in categories):
    number=1+sum(c['kind']==kind for c in categories)
    categories.append({'id':groupkey,'code':{'equipment':'E','material':'M','construction':'C'}[kind]+f'{number:02}','kind':kind,'groupLabel':label,'label':current_category,'order':len(categories),'items':[]})
   category=next(c for c in categories if c['id']==groupkey);category['items'].append(key)
   code=category['code'];aliases=[v.strip() for v in cells.get('D','').split('/') if v.strip()]
   if term=='Wall':aliases=['墙体']
   if term=='Flooring':aliases=['楼板']
   if term=='FireWall':aliases=['防火墙']
   if '/' in name:aliases.extend(part.strip() for part in name.split('/'))
   end='D' if cells.get('D') else 'C'
   evidence={'sourceKind':'workbook','workbook':source['path'],'workbookSha256':digest,'sheet':sheet,'categoryCell':f'A{row}','nameCell':f'B{row}','termCells':[f'C{row}'],'cellRange':f'A{row}:{end}{row}','verification':'verified','sourceLocation':f'{sheet}!A{row}:{end}{row}'}
   items.append({'id':key,'kind':kind,'label':name,'term':term,'category':code,'recognitionCode':recognition,'catalogCategory':current_category,'catalogGroup':label,'order':len(items),'supplemental':bool(cells.get('_highlighted')),'aliases':aliases,'evidence':evidence})
   if recognition not in bycode:
    item={'code':recognition,'label':name,'group':semantic_group,'grain':'item','reference':source['path']}
    semantic.append(item);bycode[recognition]=item
 parts=[];component_ids=policy['componentIds']
 for row,cells in book['设备模型部件名称对照表']:
  if row==1 or not cells.get('A'):continue
  term=cells['B'];aliases=[name.strip() for name in cells.get('C','').split('/') if name.strip()]
  parts.append({'id':component_ids.get(term.lower(),snake(term)),'label':cells['A'],'term':term,'aliases':aliases,'hostCategory':cells.get('D',''),'order':len(parts),'evidence':{'sourceKind':'workbook','workbook':source['path'],'workbookSha256':digest,'sheet':'设备模型部件名称对照表','cell':f'B{row}','cellRange':f'A{row}:'+('D' if cells.get('D') else 'C' if aliases else 'B')+str(row),'verification':'verified','sourceLocation':f'设备模型部件名称对照表!A{row}:'+('D' if cells.get('D') else 'C' if aliases else 'B')+str(row)}})
 # Internal identity/purpose codes are not the user-facing catalog hierarchy.
 for c in semantic:
  c['reference']='内部识别/用途码；清册目录来源：'+source['path']
  matches=[i for i in items if i['recognitionCode']==c['code']]
  if len(matches)==1:c.setdefault('catalogId',matches[0]['id'])
 catalog={'version':'engineering-catalog-v1','source':source,'categories':categories,'components':parts,'recognitionCodes':semantic}
 standard={'version':'substation-standard-index-1','source':source,'coverage':{**{kind:sum(i['kind']==kind for i in items) for kind,_,_,_ in groups},'parts':len(parts)},'items':items}
 vocab={'version':'substation-vocabulary-1','source':source,'workbook':BOOK.name,'workbookSha256':digest,'recognitionPolicySha256':hashlib.sha256(json.dumps(policy,sort_keys=True,ensure_ascii=False).encode()).hexdigest(),'equipment':{},'equipmentAliases':policy['equipmentAliases'],'components':{},'objectRoles':policy['objectRoles'],
  'keywordDictionary':{'version':'source-keywords-1','fields':['SYSCLASSIFYNAME','PARTNAME'],'match':'exact-index-term-case-insensitive','entries':{}}}
 entries=vocab['keywordDictionary']['entries']
 for item in items:
  eq=({'oilimmersedtransformer':'oil_immersed_transformer','gis':'gis','hgis':'hgis','acporcelaincircuitbreaker':'ac_porcelain_circuit_breaker'}.get(item['term'].lower()) or snake(item['term'])) if item['kind']=='equipment' else None
  evidence={k:item['evidence'][k] for k in ['sourceKind','workbookSha256','sheet','cellRange','verification','sourceLocation']};evidence['cell']=item['evidence']['nameCell']
  for word in [item['label'],item['term'],*item['term'].split('/'),*item['aliases']]:
   word=word.strip().lower()
   if not word:continue
   word_evidence={**evidence,'cell':item['evidence']['termCells'][0] if word in [v.lower().strip() for v in [item['term'],*item['term'].split('/')]] else 'D'+item['evidence']['nameCell'][1:] if word in [v.lower() for v in item['aliases']] else item['evidence']['nameCell']}
   entry=entries.setdefault(word,{'catalogIds':[],'evidence':word_evidence})
   if item['id'] not in entry['catalogIds']:entry['catalogIds'].append(item['id'])
   if eq:entry['equipmentType']=eq
  if eq:
   for term in [item['term'],*item['term'].split('/')]:vocab['equipment'][term.lower()]=eq
 for part in parts:
  for word in [part['label'],part['term'],*part['aliases']]:
   evidence={**part['evidence'],'cell':part['evidence']['cell'].replace('B','C' if word in part['aliases'] else 'B' if word==part['term'] else 'A')}
   entry=entries.setdefault(word.lower(),{'catalogIds':[],'evidence':evidence});entry['componentType']=part['id']
   if word==part['term'] or word in part['aliases']:vocab['components'][word.lower()]=part['id']
 for category in categories:
  item=next(i for i in items if i['id']==category['items'][0]);e=item['evidence']
  for word in [category['label'],category['code']]:
   entries.setdefault(word.lower(),{'catalogIds':['category:'+category['code']],'evidence':{'sourceKind':'workbook','workbookSha256':digest,'sheet':e['sheet'],'cell':e['categoryCell'],'cellRange':e['categoryCell'],'verification':'verified','sourceLocation':e['sheet']+'!'+e['categoryCell']}})
 for path in [ROOT/'desktop/src/engineering/catalog.json',ROOT/'tools/gim_element/catalog.json']:write(path,catalog)
 for path in [ROOT/'desktop/src/engineering/standardCatalog.json',ROOT/'tools/gim_element/standardCatalog.json']:write(path,standard)
 for path in [ROOT/'desktop/src/gim/engineering/sourceVocabulary.json',ROOT/'tools/gim_element/sourceVocabulary.json']:write(path,vocab)
 print('Workbook catalog:',standard['coverage'],'categories',len(categories),'keyword mappings',len(entries))
if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--workbook',type=Path,default=BOOK)
 BOOK=parser.parse_args().workbook.resolve();main()
