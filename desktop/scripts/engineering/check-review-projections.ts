/** Replay source/geometry review evidence produced with GIM_REVIEW_EVIDENCE=1.
 * Run: npx vite-node scripts/engineering/check-review-projections.ts <output-dir>
 * This checks real-sample composition, not native rendering or picking. */
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {projectSpatialComposition} from '../../src/services/projections/compositionSpatial.js';
import {finalizeEngineeringComposition,projectEngineeringComposition} from '../../src/engineering/composition.js';
import type {EngineeringSnapshot} from '../../src/engineering/types.js';
import type {ProjectionInput} from '../../src/services/compositionProjectionWorker.js';

const root=resolve(process.argv[2]??'../output/engineering-review');
function check(value:unknown,message:string):asserts value {if(!value)throw Error(message);}
for(const sample of ['s01','s02','s03','s04']){
  const checks=JSON.parse(readFileSync(join(root,`${sample}-checks.json`),'utf8'));
  const data=JSON.parse(readFileSync(join(root,`${sample}-evidence.json`),'utf8')) as ProjectionInput & {entities:EngineeringSnapshot['entities']};
  const snapshot:EngineeringSnapshot={scope:sample,rulesVersion:'review',entities:data.entities,memberships:[],pending:[],aliases:[],relationships:[],diagnostics:[]};
  const original=JSON.stringify(snapshot);
  const assignments=projectSpatialComposition(snapshot,data.facts,data.bounds,undefined,data.declarations);
  check(JSON.stringify(snapshot)===original,`${sample}: projection mutated engineering identity`);
  const tree=finalizeEngineeringComposition(projectEngineeringComposition(snapshot,assignments,'review',data.declarations));
  const area=[...tree.nodes.values()].find(n=>n.title==='主变区域');
  check(sample==='s02'||area&&area.entityCount>0,`${sample}: main civil area has no members`);
  check(!area||area.children.every(k=>['构架','支架','基础','防火墙'].includes(tree.nodes.get(k)!.title)),`${sample}: invalid outdoor structure group`);
  const byId=new Map(assignments.map(a=>[a.entityId,a]));
  if(sample==='s01'){
    check(![...tree.nodes.values()].some(n=>n.title==='建筑物6（用途待确认）'), 's01: main yard became an anonymous building');
    const civil=tree.nodes.get(tree.rootKey)!.children.map(k=>tree.nodes.get(k)!).find(n=>n.title==='建筑工程')!;
    const names=civil.children.map(k=>tree.nodes.get(k)!.title);
    check(names.indexOf('220千伏配电装置楼')>=0&&names.indexOf('220千伏配电装置楼')<names.indexOf('110千伏配电装置楼'),'s01: missing/unsorted voltage buildings');
    check(area!.entityCount>=118,'s01: known main-yard footprint members lost');
    check(assignments.filter(row=>row.paths.some(path=>path.some(group=>group.title==='防火墙'))).length>=10,'s01: named fire walls did not enter their outdoor structure group');
  }
  if(sample==='s03'){
    const room=[...tree.nodes.values()].find(n=>n.title==='配电室01');
    check(room&&room.entityCount>=200,'s03: distribution room is still an empty declaration');
    check(checks.proxyAudit.unmappedNonGeneric<=754,'s03: newly introduced non-generic proxy categories lack a safe mapping');
    check(data.entities.some(e=>e.category==='C-A6'&&e.name==='屋面'),'s03: proxy roof category was not adapted');
    check(![...tree.nodes.values()].some(n=>n.title==='主控通信楼01'),'s03: empty control-building declaration leaked into final tree');
  }
  if(sample==='s02'){
    check(['配电楼','消防泵房','警传室'].every(title=>[...tree.nodes.values()].some(n=>n.title===title&&n.entityCount>0)),'s02: named buildings lost');
    const house=checks.diagnostics.footprints.find((row:{chosen:string})=>row.chosen==='配电楼')?.bounds as number[]|undefined;
    check(house,'s02: no physical distribution-building footprint');
    const boxes=new Map(data.bounds.map(row=>[row.entityId,row.bounds]));
    for(const row of assignments){
      const b=boxes.get(row.entityId);
      if(!b||!row.paths.some(p=>p.some(g=>g.kind==='area')))continue;
      check(!(b[0]>=house[0]&&b[3]<=house[3]&&b[1]>=house[1]&&b[4]<=house[4]),'s02: indoor civil member leaked into an outdoor area');
    }
  }
  if(sample==='s04'){
    const truss=data.facts.filter(f=>f.sourceHints?.some(p=>p.includes('主变区域构架')));
    check(truss.length===18,'s04: pinned truss source coverage changed');
    check(truss.every(f=>byId.get(f.entityId)?.paths.some(p=>p.some(g=>g.title==='主变区域'))),'s04: main truss assigned outside main area');
    const stacks=checks.diagnostics.firewallStacks as Array<{members:number}>;
    check(stacks.length===2&&stacks.every(row=>row.members===7),'s04: expected two evidence-backed fire-wall stacks');
    const wallIds=new Set(assignments.filter(row=>row.paths.some(path=>path.some(g=>g.title==='防火墙'))).map(row=>row.entityId));
    check(wallIds.size===14,'s04: mixed foundation/wall file was over- or under-classified');
    check(data.entities.filter(e=>/防火墙钢梯/.test(e.name)).every(e=>!wallIds.has(e.id)),'s04: wall ladder became a fire wall');
  }
  console.log(`${sample}: source-bound composition checks passed; main area ${area?.entityCount??0} members`);
}
