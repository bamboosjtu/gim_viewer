import {describe,it,expect,vi} from 'vitest';
import {buildCbmTree} from '../../../../../desktop/src/gim/cbmParser.js';
import {extractEngineeringSourceGraph} from '../sourceGraph.js';
import {SourceDocuments} from '../sourceDocuments.js';
import {extractPhysicalOccurrences} from '../../geometry/physicalOccurrences.js';
import {createEntryIndex} from '../entryResolver.js';

describe('source spelling shared by navigation, semantics and physical placement',()=>{
  it('does not flag block-local matrices as conflicting scalars at a DEV-only entry',async()=>{
    const matrix=(x:number)=>`1,0,0,0,0,1,0,0,0,0,1,0,${x},0,0,1`;
    const root=`SOLIDMODELS.NUM=1\nSOLIDMODEL0=body.phm\nTRANSFORMMATRIX0=${matrix(1)}\nSUBDEVICES.NUM=1\nSUBDEVICE0=child.dev\nTRANSFORMMATRIX0=${matrix(2)}`;
    const files=new Map([['root.dev',new File([root],'root.dev')],['child.dev',new File(['SUBDEVICES.NUM=0\nSOLIDMODELS.NUM=0'],'child.dev')]]);
    const tree=await buildCbmTree(files,undefined,'root.dev');
    expect(tree?.sourceDiagnostics).toBeUndefined();expect(tree?.children[0].transformMatrix).toBe(matrix(2));
  });




  it('does not choose different OMP candidates in the three consumers',async()=>{
    const raw={'project.cbm':'ENTITYNAME=F1System\nOBJECTMODELPOINTER=a.dev\nOBJECTMODELPOINTER=b.dev','a.dev':'SYMBOLNAME=A','b.dev':'SYMBOLNAME=B'};
    const files=new Map(Object.entries(raw).map(([path,text])=>[path,new File([text],path)]));
    const documents=new SourceDocuments(async path=>raw[path as keyof typeof raw]),entryIndex=createEntryIndex(Object.keys(raw));
    const tree=await buildCbmTree(files);
    const graph=await extractEngineeringSourceGraph({paths:Object.keys(raw),entryIndex,readDocument:path=>documents.read(path),readText:async path=>raw[path as keyof typeof raw]});
    const physical=await extractPhysicalOccurrences({entryIndex,readDocument:path=>documents.read(path)});
    expect(tree?.devPath).toBe('');
    expect(tree?.sourceDiagnostics?.[0]).toMatchObject({kind:'ambiguous-field',field:'OBJECTMODELPOINTER',lines:[2,3],values:['a.dev','b.dev']});
    expect(graph.records).toEqual([]);expect(physical.occurrences).toEqual([]);
    expect(graph.references.find(row=>row.field==='OBJECTMODELPOINTER')).toMatchObject({status:'ambiguous',target:null,candidates:['a.dev','b.dev'],lines:[2,3]});
    expect(physical.diagnostics[0]).toMatchObject({reason:'ambiguous-source-reference',candidates:['a.dev','b.dev'],lines:[2,3]});
  });

  it('uses every repeated SUBSYSTEM value for navigation and both occurrence chains',async()=>{
    const raw:Record<string,string>={'project.cbm':'ENTITYNAME=F1System\nSUBSYSTEM=a.cbm\nSUBSYSTEM=b.cbm','a.cbm':'OBJECTMODELPOINTER=a.dev','b.cbm':'OBJECTMODELPOINTER=b.dev','a.dev':'SYMBOLNAME=A','b.dev':'SYMBOLNAME=B'};
    const documents=new SourceDocuments(async path=>raw[path]),entryIndex=createEntryIndex(Object.keys(raw));
    const tree=await buildCbmTree(new Map(Object.entries(raw).map(([path,text])=>[path,new File([text],path)])));
    const graph=await extractEngineeringSourceGraph({paths:Object.keys(raw),entryIndex,readDocument:path=>documents.read(path),readText:async path=>raw[path]});
    const physical=await extractPhysicalOccurrences({entryIndex,readDocument:path=>documents.read(path)});
    expect(tree?.children.map(row=>row.devPath)).toEqual(['a.dev','b.dev']);
    expect(graph.records.map(row=>row.source)).toEqual(['a.dev','b.dev']);
    expect(physical.occurrences.map(row=>row.devPath)).toEqual(['a.dev','b.dev']);
  });

  it('keeps a failed CBM placeholder and continues its sibling without retrying the failed read',async()=>{
    const bad=new File(['unreadable'],'bad.cbm'),read=vi.spyOn(bad,'arrayBuffer').mockRejectedValue(Error('read failure'));
    const files=new Map([['project.cbm',new File(['SUBSYSTEMS.NUM=2\nSUBSYSTEM0=bad.cbm\nSUBSYSTEM1=good.cbm'],'project.cbm')],['bad.cbm',bad],['good.cbm',new File(['PARTNAME=Good'],'good.cbm')]]);
    const tree=await buildCbmTree(files);
    expect(tree?.children.map(row=>row.path)).toEqual(['bad.cbm','good.cbm']);
    expect(tree?.children[0].sourceDiagnostics).toContainEqual({kind:'read-failed',path:'bad.cbm',field:'',lines:[],values:[]});
    expect(tree?.children[1].name).toBe('Good');expect(read).toHaveBeenCalledOnce();
  });
});
