import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const documents=['README.md','AGENTS.md','docs/software-spec.md','docs/architecture/layers.md','docs/architecture/lifecycle.md','docs/architecture/engineering-runtime.md','docs/engineering/README.md','docs/engineering/composition.md','docs/engineering/inventory-template.md','docs/engineering/catalogs/README.md','docs/validation.md'];
for(const name of documents){
  const text=readFileSync(resolve(repo,name),'utf8');
  if(/两视图|材料\s*7\s*大类|25\s*子类|engineering-wholes-[1-7](?!\d)/.test(text))throw Error(`Stale engineering terms or contract versions: ${name}`);
}
const catalog=JSON.parse(readFileSync(resolve(repo,'desktop/src/engineering/catalog.json'),'utf8'));
const text=readFileSync(resolve(repo,'docs/engineering/catalogs/README.md'),'utf8');
const materials=catalog.categories.filter(c=>/^M\d+$/.test(c.code)).length,components=catalog.categories.filter(c=>/^C-/.test(c.code)).length;
if(!text.includes(`材料 ${materials} 大类`)||!text.includes(`${components} 子类`))throw Error('Catalog counts drifted');
console.log('Current engineering documentation terms and catalog counts passed.');
