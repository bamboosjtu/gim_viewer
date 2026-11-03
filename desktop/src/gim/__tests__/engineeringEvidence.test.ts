import { describe, expect, it } from 'vitest';
import { extractEngineeringSourceGraph } from '../engineering/sourceGraph.js';
import { engineeringObjectEvidence } from '../engineering/objectEvidence.js';
import { normalizeEngineeringModel } from '../../engineering/normalize.js';
import { collectSourceGeometryOccurrences } from '../engineering/geometryOccurrences.js';

const extract = (entries: Record<string,string>) => extractEngineeringSourceGraph({paths:Object.keys(entries),readText:async p=>entries[p]});
const model = (graph: Awaited<ReturnType<typeof extract>>) => normalizeEngineeringModel('p',engineeringObjectEvidence(graph,graph.records),graph.aliases);

describe('object evidence independent of organization and geometry',()=>{
  it('ancestor names cannot declare main identity, reserve status or a neutral host',async()=>{
    const input={
      'project.cbm':'SUBSYSTEM0=unit.cbm\nSYSTEMNAME1=2号备用主变系统',
      'unit.cbm':'OBJECTMODELPOINTER=body.dev\nSUBSYSTEM0=neutral.cbm',
      'body.dev':'SYMBOLNAME=变压器\nTYPE=Transformer',
      'neutral.cbm':'OBJECTMODELPOINTER=neutral.dev',
      'neutral.dev':'SYMBOLNAME=中性点成套装置',
    };
    const graph=await extract(input),before=model(graph);
    const evidence=engineeringObjectEvidence(graph,graph.records);
    expect(evidence[0].inheritedContextDesignations?.map(e=>e.value)).toContain('2号备用主变系统');
    expect(evidence.every(e=>!e.designations.length)).toBe(true);
    expect(before.entities.map(e=>e.category)).toEqual(['E-T']);
    expect(before.pending[0].reason).toBe('neutral_set_main_unresolved');
    const renamed=await extract({...input,'project.cbm':'SUBSYSTEM0=unit.cbm\nSYSTEMNAME1=9号主变系统'});
    expect(model(renamed)).toEqual(before);
    expect(collectSourceGeometryOccurrences(renamed)).toEqual(collectSourceGeometryOccurrences(graph));
  });

  it('preserves explicit object designations without lending them to child DEV occurrences',async()=>{
    const graph=await extract({
      'project.cbm':'OBJECTMODELPOINTER=body.dev\nBASEFAMILYPOINTER=main.fam',
      'body.dev':'SYMBOLNAME=变压器\nTYPE=Transformer\nSUBDEVICE0=box.dev',
      'box.dev':'SYMBOLNAME=端子箱',
      'main.fam':'[设备]\n工程中名称=PROJECTNAME=2号备用主变\n设备编码=CODE=main-2',
    });
    const [body,box]=engineeringObjectEvidence(graph,graph.records);
    expect(body.designations[0]).toMatchObject({value:'2号备用主变'});
    expect(body.designations[0].evidenceId).toContain('main.fam');
    expect(box.designations).toEqual([]);expect(box.identityCodes).toEqual([]);
    expect(model(graph).entities[0]).toMatchObject({category:'E01',name:'2号备用主变',sourceIds:graph.records.map(r=>r.id).sort()});
  });

  it('uses current CBM names only on the matched occurrence and retains every own name channel',async()=>{
    const graph=await extract({
      'project.cbm':'OBJECTMODELPOINTER=root.dev\nNAME=主变压器\nSUBSYSTEM0=part.cbm',
      'root.dev':'SUBDEVICE0=part.dev\nSUBDEVICE1=other.dev',
      'part.cbm':'OBJECTMODELPOINTER=part.dev\nNAME=端子箱\nBASEFAMILYPOINTER=part.fam',
      'part.fam':'[设备]\n工程中名称=PROJECTNAME=端子箱01',
      'part.dev':'', 'other.dev':'SYMBOLNAME=散热器',
    });
    const [root,part,other]=graph.records;
    expect(root.name).toBe('主变压器');expect(part.name).toBe('端子箱01');expect(other.name).toBe('散热器');
    expect(part.nameEvidence?.map(n=>n.kind)).toEqual(['engineering','source']);
    expect(other.nameEvidence).toHaveLength(1);
    expect(other.properties.some(p=>p.value==='主变压器'||p.value==='端子箱01')).toBe(false);
    expect(graph.records).toHaveLength(3);expect(graph.aliases[0].status).toBe('confirmed');
  });

  it('preserves equivalent whole boundaries after inserting a source wrapper that changes occurrence paths',async()=>{
    const input={'project.cbm':'SUBSYSTEM0=unit.cbm','unit.cbm':'OBJECTMODELPOINTER=body.dev',
      'body.dev':'SYMBOLNAME=主变压器\nSUBDEVICE0=box.dev','box.dev':'SYMBOLNAME=端子箱'};
    const a=await extract(input),b=await extract({...input,'project.cbm':'SUBSYSTEM0=wrapper.cbm','wrapper.cbm':'NAME=3号备用主变系统\nSUBSYSTEM0=unit.cbm'});
    const boundary=(g:typeof a)=>{const sources=new Map(g.records.map(r=>[r.id,r.source]));return model(g).entities.map(e=>({category:e.category,name:e.name,sources:e.sourceIds.map(s=>sources.get(s)).sort()}));};
    expect(boundary(a)).toEqual(boundary(b));
    expect(a.records[0].id).not.toBe(b.records[0].id);
    expect(collectSourceGeometryOccurrences(a).occurrences.map(o=>[o.devPath,o.placementMatrix])).toEqual(collectSourceGeometryOccurrences(b).occurrences.map(o=>[o.devPath,o.placementMatrix]));
  });
});
