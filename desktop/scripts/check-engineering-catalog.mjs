import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const catalog=JSON.parse(readFileSync(resolve(repo,'desktop/src/engineering/catalog.json'),'utf8'));
const labels=Object.fromEntries(catalog.categories.map(c=>[c.code,c.label]));
if(Object.keys(labels).length!==catalog.categories.length||catalog.categories.filter(c=>/^E\d+$/.test(c.code)).length!==19||catalog.categories.filter(c=>/^M\d+$/.test(c.code)).length!==9||catalog.categories.filter(c=>/^C-/.test(c.code)).length!==28)throw Error('Catalog code cardinality mismatch');
const sections=[['设备','equipment'],['装置性材料','materials'],['构件','components']];
const doc='# 机器目录索引\n\n本文件由 `desktop/scripts/check-engineering-catalog.mjs --write` 从共享目录生成。编码为项目映射，版次出处与实例身份分开。\n\n'+sections.map(([title,group])=>`## ${title}\n\n| 编码 | 名称 | 默认粒度 |\n|---|---|---|\n`+catalog.categories.filter(c=>c.group===group).map(c=>`| ${c.code} | ${c.label} | ${c.grain} |`).join('\n')).join('\n\n')+'\n';
const docPath=resolve(repo,'docs/engineering/catalogs/catalog-index.md');
if(process.argv.includes('--write'))writeFileSync(docPath,doc);
else if(readFileSync(docPath,'utf8').replace(/\r\n/g,'\n')!==doc)throw Error('Catalog documentation is stale; run check:engineering-catalog -- --write');
if(process.argv.includes('--python')){
 const py=spawnSync('python',['-c',"import json,sys;sys.path.insert(0,'tools/gim_element');import entity_std as e;print(json.dumps([*e.DEV_CODE.values(),*e.MAT_CODE.values(),*e.CON_CODE.values()],ensure_ascii=True))"],{cwd:repo,encoding:'utf8',windowsHide:true});
 if(py.status!==0)throw Error(py.stderr||String(py.error));
 const pairs=JSON.parse(py.stdout).filter(([code])=>code!=='U-OBJECT');
 for(const [code,label]of pairs)if(labels[code]!==label)throw Error(`Python catalog mismatch: ${code}`);
 for(const entry of catalog.categories.filter(c=>!c.code.includes('.')&&c.code!=='U-OBJECT'))if(!pairs.some(([code])=>code===entry.code))throw Error(`Python catalog lacks ${entry.code}`);
}
console.log('Catalog codes, labels and generated documentation agree.');
