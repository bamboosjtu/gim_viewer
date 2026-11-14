"""Generate runtime catalogs from the developer-maintained XLSX. No PDF input.
Uses only Python's standard library; this is a repository maintenance command,
not a dependency of any standalone tool's runtime or packaging.
"""
from pathlib import Path
import json,hashlib,re,zipfile,xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parents[2]
BOOK=ROOT/'research/实体识别/变电三维设计建模规范_索引表类.xlsx'
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
 source={'kind':'workbook','path':'research/实体识别/'+BOOK.name,'sha256':digest}
 old=load(ROOT/'desktop/src/engineering/standardCatalog.json')
 mapping={i['term'].lower():i['category'] for i in old['items']}
 mapping.update({'beam':'C-A4','column':'C-A3','steelbeam':'C-A4.steel','steelcolumn':'C-A3.steel','steelstructure':'C-A14','structuralmember':'C-A15','door':'C-A7','window':'C-A8','roof':'C-A6','railing':'C-A9.railing','protectiondevice':'E16.protection'})
 previous=load(ROOT/'desktop/src/engineering/catalog.json');semantic=previous.get('semanticCodes',previous.get('categories'))
 bycode={c['code']:c for c in semantic};items=[];categories=[]
 groups=[('equipment','设备','电气设备模型索引表','equipment'),('material','材料','材料模型索引表','materials'),('construction','构件','构件模型索引表','components')]
 for kind,label,sheet,semantic_group in groups:
  current_category=''
  for row,cells in book[sheet]:
   if row==1 or not cells.get('B'):continue
   current_category=cells.get('A') or current_category;name,term=cells['B'],cells['C']
   code=mapping.get(term.lower(),{'equipment':'E-X.','material':'M-X.','construction':'C-X.'}[kind]+snake(term))
   key=kind+':'+term.lower();groupkey=kind+':'+current_category
   if not any(c['id']==groupkey for c in categories):categories.append({'id':groupkey,'kind':kind,'groupLabel':label,'label':current_category,'order':len(categories),'items':[]})
   category=next(c for c in categories if c['id']==groupkey);category['items'].append(key)
   aliases=[]
   if term=='Wall':aliases=['墙体']
   if term=='Flooring':aliases=['楼板']
   if term=='FireWall':aliases=['防火墙']
   if '/' in name:aliases.extend(part.strip() for part in name.split('/'))
   evidence={'sourceKind':'workbook','workbook':source['path'],'workbookSha256':digest,'sheet':sheet,'categoryCell':f'A{row}','nameCell':f'B{row}','termCells':[f'C{row}'],'cellRange':f'A{row}:C{row}','verification':'verified','sourceLocation':f'{sheet}!A{row}:C{row}'}
   items.append({'id':key,'kind':kind,'label':name,'term':term,'category':code,'catalogCategory':current_category,'catalogGroup':label,'order':len(items),'supplemental':bool(cells.get('_highlighted')),'aliases':aliases,'evidence':evidence})
   if code not in bycode:
    item={'code':code,'label':name,'group':semantic_group,'grain':'item','reference':source['path']}
    if '.' in code and code.split('.')[0] in bycode:item['parent']=code.split('.')[0]
    semantic.append(item);bycode[code]=item
 parts=[];old_vocab=load(ROOT/'desktop/src/gim/engineering/sourceVocabulary.json');component_ids=old_vocab['components']
 for row,cells in book['设备模型部件名称对照表']:
  if row==1 or not cells.get('A'):continue
  term=cells['B'];parts.append({'id':component_ids.get(term.lower(),snake(term)),'label':cells['A'],'term':term,'order':len(parts),'evidence':{'sourceKind':'workbook','workbook':source['path'],'workbookSha256':digest,'sheet':'设备模型部件名称对照表','cell':f'B{row}','cellRange':f'A{row}:B{row}','verification':'verified','sourceLocation':f'设备模型部件名称对照表!A{row}:B{row}'}})
 # Internal identity/purpose codes are not the user-facing catalog hierarchy.
 preferred={'E16':'equipment:secondarycabinet','E16.panel_cabinet':'equipment:secondarycabinet','E16.control_cabinet':'equipment:secondarycabinet','E16.terminal_box':'material:terminalbox','E16.battery_set':'equipment:groupbattery',
  'C-A1':'construction:wall','C-A2':'construction:flooring','C-A10':'construction:supplementarycomponents','C-C1':'construction:trench','C-C2':'construction:trench','C-C4':'construction:fences','C-B4':'construction:foundation','C-B5':'construction:structuralmember','C-B6':'construction:structuralmember','M07':'material:cableauxiliaryfacilities','M08':'material:cableauxiliaryfacilities'}
 for c in semantic:
  if c['code'] in ['E01','E03','E-T']:c['catalogFamily']={'kind':'equipment','label':'变压器'}
  elif c['code'] in ['E02','E11','E-R']:c['catalogFamily']={'kind':'equipment','label':'电抗器'}
  c['reference']='内部识别/用途码；清册目录来源：'+source['path']
  matches=[i for i in items if i['category']==c['code']]
  if c['code'] in preferred:c['catalogId']=preferred[c['code']]
  elif len(matches)==1:c['catalogId']=matches[0]['id']
  else:c.pop('catalogId',None)
 catalog={'version':'engineering-catalog-v1','source':source,'categories':categories,'components':parts,'semanticCodes':semantic}
 standard={'version':'substation-standard-index-1','source':source,'coverage':{**{kind:sum(i['kind']==kind for i in items) for kind,_,_,_ in groups},'parts':len(parts)},'items':items}
 vocab={'version':'substation-vocabulary-1','source':source,'workbook':BOOK.name,'workbookSha256':digest,'equipment':{},'equipmentAliases':old_vocab.get('equipmentAliases',{}),'components':{},'objectRoles':old_vocab.get('objectRoles',{}),
  'keywordDictionary':{'version':'source-keywords-1','fields':['SYSCLASSIFYNAME','PARTNAME'],'match':'exact-index-term-case-insensitive','entries':{}}}
 entries=vocab['keywordDictionary']['entries']
 for item in items:
  eq=({'oilimmersedtransformer':'oil_immersed_transformer','gis':'gis','hgis':'hgis','acporcelaincircuitbreaker':'ac_porcelain_circuit_breaker'}.get(item['term'].lower()) or snake(item['term'])) if item['kind']=='equipment' else None
  evidence={k:item['evidence'][k] for k in ['sourceKind','workbookSha256','sheet','cellRange','verification','sourceLocation']};evidence['cell']=item['evidence']['nameCell']
  for word in [item['label'],item['term'],*item['term'].split('/')]:
   word=word.strip().lower()
   if not word:continue
   word_evidence={**evidence,'cell':item['evidence']['termCells'][0] if word in [v.lower().strip() for v in [item['term'],*item['term'].split('/')]] else item['evidence']['nameCell']}
   entry=entries.setdefault(word,{'catalogIds':[],'evidence':word_evidence})
   if item['id'] not in entry['catalogIds']:entry['catalogIds'].append(item['id'])
   if eq:entry['equipmentType']=eq
  if eq:
   for term in [item['term'],*item['term'].split('/')]:vocab['equipment'][term.lower()]=eq
 for part in parts:
  for word in [part['label'],part['term']]:
   evidence={**part['evidence'],'cell':part['evidence']['cell'] if word==part['term'] else part['evidence']['cell'].replace('B','A')}
   entry=entries.setdefault(word.lower(),{'catalogIds':[],'evidence':evidence});entry['componentType']=part['id']
  vocab['components'][part['term'].lower()]=part['id']
 for path in [ROOT/'desktop/src/engineering/catalog.json',ROOT/'tools/gim_element/catalog.json']:write(path,catalog)
 for path in [ROOT/'desktop/src/engineering/standardCatalog.json',ROOT/'tools/gim_element/standardCatalog.json']:write(path,standard)
 for path in [ROOT/'desktop/src/gim/engineering/sourceVocabulary.json',ROOT/'tools/gim_element/sourceVocabulary.json']:write(path,vocab)
 print('Workbook catalog:',standard['coverage'],'categories',len(categories),'keyword mappings',len(entries))
if __name__=='__main__':main()
