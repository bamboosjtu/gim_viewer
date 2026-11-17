import {expect,it} from 'vitest';
import {extractEngineeringSourceGraph} from '../sourceGraph.js';
import {buildTestEngineeringSources} from './fixtures.js';
import {projectEngineeringNavigation} from '../navigation.js';
it('lists one transformer with embedded sources, a separate secondary cabinet, and readable source names without changing F hierarchy',async()=>{
 const raw:Record<string,string>={'project.cbm':'SUBSYSTEM0=unit.cbm','unit.cbm':'ENTITYNAME=F4System\nNAME=1号主变本体系统\nOBJECTMODELPOINTER=main.dev','main.dev':'TYPE=OilImmersedTransformer\nSYMBOLNAME=变压器\nSUBDEVICE0=terminal.dev\nSUBDEVICE1=control.dev','terminal.dev':'TYPE=TerminalBox\nOBJECTROLE=part\nSYMBOLNAME=端子箱','control.dev':'TYPE=SecondaryCabinet\nOBJECTROLE=independent\nSYMBOLNAME=1号主变测控柜'};
 const graph=await extractEngineeringSourceGraph({paths:Object.keys(raw),readText:async p=>raw[p]}),built=buildTestEngineeringSources('p',graph,[],[]),view=projectEngineeringNavigation(built.sources,built.snapshot),inventory=view.inventory!;
 expect(built.snapshot.entities).toHaveLength(2);
 // The source wrapper's NAME declares project context, not transformer purpose.
 const main=built.snapshot.entities.find(e=>e.category==='E01')!,cabinet=built.snapshot.entities.find(e=>e.category==='E17')!;
 expect(main.sourceIds).toHaveLength(2);expect(cabinet.sourceIds).toHaveLength(1);
 expect(inventory.nodes.get(inventory.rootKey)?.entityCount).toBe(2);
 expect(inventory.rowsBySource.size).toBe(3);
 const terminal=graph.records.find(r=>r.name==='端子箱')!,row=inventory.nodes.get(inventory.rowsBySource.get(terminal.id)!)!;
 expect(row.key).toBe(inventory.rowsByEntity.get(main.id)![0]);expect(row.children).toEqual([]);
 expect([...inventory.nodes.values()].some(node=>node.title==='本体端子箱')).toBe(false);
 expect([...view.sourceNodes.values()].some(node=>node.sourceId===terminal.id)).toBe(true);
 const source=[...view.sourceNodes.values()].find(n=>n.kind==='cbm'&&n.documentPath==='unit.cbm')!;
 expect(source).toMatchObject({title:'F4 1号主变本体系统',fLevel:'F4',parent:'source:cbm:cbm:project.cbm'});
});
