import {expect,it} from 'vitest';
import {extractEngineeringSourceGraph} from '../engineering/sourceGraph.js';
import {buildEngineeringSources} from '../engineering/buildSources.js';
import {projectEngineeringNavigation} from '../engineering/navigation.js';
it('lists one transformer with embedded sources, a separate secondary cabinet, and readable source names without changing F hierarchy',async()=>{
 const raw:Record<string,string>={'project.cbm':'SUBSYSTEM0=unit.cbm','unit.cbm':'ENTITYNAME=F4System\nNAME=1号主变本体系统\nOBJECTMODELPOINTER=main.dev','main.dev':'TYPE=OilImmersedTransformer\nSYMBOLNAME=变压器\nSUBDEVICE0=terminal.dev\nSUBDEVICE1=control.dev','terminal.dev':'SYMBOLNAME=端子箱','control.dev':'TYPE=SecondaryCabinet\nSYMBOLNAME=1号主变测控柜'};
 const graph=await extractEngineeringSourceGraph({paths:Object.keys(raw),readText:async p=>raw[p]}),built=buildEngineeringSources('p',graph,[],[]),view=projectEngineeringNavigation(built.sources,built.snapshot),inventory=view.inventory!;
 expect(built.snapshot.entities).toHaveLength(2);
 const main=built.snapshot.entities.find(e=>e.category==='E01')!,cabinet=built.snapshot.entities.find(e=>e.category==='E16.control_cabinet')!;
 expect(main.sourceIds).toHaveLength(2);expect(cabinet.sourceIds).toHaveLength(1);
 expect(inventory.nodes.get(inventory.rootKey)?.entityCount).toBe(2);
 expect(inventory.rowsBySource.size).toBe(3);
 const terminal=graph.records.find(r=>r.name==='端子箱')!,row=inventory.nodes.get(inventory.rowsBySource.get(terminal.id)!)!;
 expect(row.title).toBe('端子箱 [DEV轨道]');expect(row.parent).toBe(inventory.rowsBySource.get(terminal.parent));
 const source=[...view.sourceNodes.values()].find(n=>n.kind==='cbm'&&n.documentPath==='unit.cbm')!;
 expect(source).toMatchObject({title:'F4 1号主变本体系统',fLevel:'F4',parent:'source:cbm:cbm:project.cbm'});
});
