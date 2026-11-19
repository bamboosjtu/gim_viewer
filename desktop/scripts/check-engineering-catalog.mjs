import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const load=path=>JSON.parse(readFileSync(resolve(repo,path),'utf8'));
const catalog=load('packages/gim-sdk/src/engineering/catalog.json'),standard=load('packages/gim-sdk/src/engineering/standardCatalog.json');
const policy=load('packages/gim-sdk/src/engineering/recognitionPolicy.json');
const codes=new Set(catalog.categories.map(c=>c.code)),roles=new Set(policy.recognitionCodes.map(c=>c.code));
if(codes.size!==catalog.categories.length||new Set(standard.items.map(i=>i.id)).size!==standard.items.length||standard.items.some(i=>!codes.has(i.category)||!roles.has(policy.catalogRoles[i.id]??policy.terms[i.term.toLowerCase()])))throw Error('Catalog IDs / directory and recognition role mapping mismatch');
for(const file of ['catalog.json','standardCatalog.json','recognitionPolicy.json','compositionPolicy.json'])if(JSON.stringify(load('packages/gim-sdk/src/engineering/'+file))!==JSON.stringify(load('tools/gim_element/'+file)))throw Error('Standalone catalog copy differs: '+file);
if(JSON.stringify(load('packages/gim-sdk/src/engineering/sourceVocabulary.json'))!==JSON.stringify(load('tools/gim_element/sourceVocabulary.json')))throw Error('Standalone vocabulary copy differs');
const compatibility=load('packages/gim-sdk/src/engineering/sourceCompatibilityPolicy.json');
if(JSON.stringify(compatibility)!==JSON.stringify(load('tools/gim_element/sourceCompatibilityPolicy.json')))throw Error('Standalone compatibility policy differs');
const vocabulary=load('packages/gim-sdk/src/engineering/sourceVocabulary.json');
for(const entry of Object.values(vocabulary.keywordDictionary.entries))if('componentType' in entry)throw Error('Component meaning leaked into model vocabulary');
for(const item of standard.items)for(const word of [item.label,item.term,...item.label.split('/'),...item.term.split('/'),...item.aliases])if(!vocabulary.keywordDictionary.entries[word.trim().toLowerCase()]?.catalogIds.includes(item.id))throw Error('Model vocabulary missing '+item.id+' / '+word);
for(const part of catalog.components)for(const word of [part.label,part.term,...part.aliases])if(!vocabulary.componentDictionary.entries[word.trim().toLowerCase()]?.componentIds.includes(part.id))throw Error('Component vocabulary missing '+part.term+' / '+word);
for(const [term,id] of Object.entries(compatibility.typeDefaults))if(!standard.items.some(item=>item.id===id))throw Error('Unknown default type: '+term+' → '+id);
for(const [term,first] of Object.entries(compatibility.orderedTypeValues))if(!vocabulary.keywordDictionary.entries[first.toLowerCase()]&&!vocabulary.componentDictionary.entries[first.toLowerCase()])throw Error('Unknown first type: '+term+' → '+first);
const composition=load('packages/gim-sdk/src/engineering/compositionPolicy.json');
if(JSON.stringify(composition.hostKinds)!==JSON.stringify(['equipment']))throw Error('Every equipment type must support components');
for(const rule of composition.hostSubtypes){
  if(!rule.requiresComponents.length||rule.hostRecognitionCodes.some(code=>!roles.has(code))
    ||[...rule.requiresComponents,...rule.conflictsWith].some(id=>!catalog.components.some(part=>part.id===id)))throw Error('Invalid composition subtype: '+rule.id);
}
for(const id of Object.values(policy.componentTermDefaults))if(!catalog.components.some(part=>part.id===id))throw Error('Invalid default component: '+id);
const path='docs/engineering/catalogs/catalog-index.md';
const doc='# 实体目录参考索引\n\n维护源为独立 JSON 目录配置；[`变电三维设计建模规范_实体索引表.xlsx`](变电三维设计建模规范_实体索引表.xlsx) 仅作参考。下列单元格与摘要保留所记录的参考版本的来源位置，不要求当前工作簿参与配置、构建或检查。目录代码稳定维护，内部用途/归属角色不参与目录排序。\n\n'+['equipment','material','construction'].map(kind=>{
 const title={equipment:'设备',material:'材料',construction:'构件'}[kind];
 return '## '+title+'\n\n| 编号 | 类别 | 名称 | 英文名称 | 单元格 | 补充项 |\n|---|---|---|---|---|---|\n'+standard.items.filter(i=>i.kind===kind).map(i=>`| ${i.category} | ${i.catalogCategory} | ${i.label} | ${i.term} | ${i.evidence.sheet}!${i.evidence.cellRange} | ${i.supplemental?'是':''} |`).join('\n');
}).join('\n\n')+'\n\n## 设备部件\n\n| 名称 | 英文名称 | 单元格 |\n|---|---|---|\n'+catalog.components.map(i=>`| ${i.label} | ${i.term} | ${i.evidence.sheet}!${i.evidence.cellRange} |`).join('\n')+'\n';
if(process.argv.includes('--write'))writeFileSync(resolve(repo,path),doc);else if(readFileSync(resolve(repo,path),'utf8').replace(/\r\n/g,'\n')!==doc)throw Error('Generated catalog documentation is stale');
console.log('JSON catalogs, namespace vocabularies, composition policies, standalone copies and documentation agree. No workbook dependency.');
