import {it,expect,vi} from 'vitest';
import {parseSourceDocument,sourceScalar,sourceReferenceFields} from '../sourceDocument.js';
import {parseKeyValue,keyValueDiagnostics,keyValueListFields} from '../kvParser.js';
import {buildLineGimGraphFromTexts} from '../lineCbmParserCore.js';
it('retains original lines and refuses conflicting case-insensitive scalars',()=>{
    const doc=parseSourceDocument('p.cbm','\uFEFFOBJECTMODELPOINTER=a.dev\nobjectmodelpointer=b.dev\nNOTE=x=y');
    expect(doc.fields[0]).toMatchObject({line:1,rawLine:'\uFEFFOBJECTMODELPOINTER=a.dev'});
    expect(sourceScalar(doc,'OBJECTMODELPOINTER')).toMatchObject({status:'ambiguous',value:''});
    expect(sourceScalar(doc,'NOTE').value).toBe('x=y');
  });
it('keeps repeated list edges but diagnoses conflicting numbered slots',()=>{
    const ambiguous=vi.fn(),doc=parseSourceDocument('p.cbm','SUBSYSTEM=a.cbm\nSUBSYSTEM=b.cbm\nSUBSYSTEM0=x.cbm\nSUBSYSTEM0=y.cbm');
    expect(sourceReferenceFields(doc,/^SUBSYSTEM\d*$/,ambiguous).map(row=>row.value)).toEqual(['a.cbm','b.cbm']);
    expect(ambiguous).toHaveBeenCalledOnce();
    expect(ambiguous.mock.calls[0][1].map((row:{line:number})=>row.line)).toEqual([3,4]);
  });
it('retains conflict candidates and list lines without selecting a scalar winner',()=>{
 const props=parseKeyValue('NAME=first\nname=second\nSUBSYSTEM=a.cbm\nSUBSYSTEM=b.cbm\n__proto__=source','project.cbm');
 expect(props.NAME).toBe('');expect(props.name).toBe('');expect(props.__proto__).toBe('source');
 expect(keyValueDiagnostics(props)[0]).toMatchObject({path:'project.cbm',field:'NAME',lines:[1,2],values:['first','second']});
 expect(keyValueListFields(props).map(row=>[row.value,row.line])).toEqual([['a.cbm',3],['b.cbm',4]]);
});
it('line CBM traverses every list edge and preserves numbered-slot ambiguity',()=>{
 const graph=buildLineGimGraphFromTexts([{path:'Cbm/project.cbm',text:'ENTITYNAME=F1System\nSUBSYSTEM=a.cbm\nSUBSYSTEM=b.cbm\nSUBSYSTEMS.NUM=1\nSUBSYSTEM0=x.cbm\nSUBSYSTEM0=y.cbm'},
 {path:'a.cbm',text:'ENTITYNAME=F2System'},{path:'b.cbm',text:'ENTITYNAME=F2System'}]);
 expect(graph.root?.children.map(row=>row.path)).toEqual(['a.cbm','b.cbm']);
 expect(graph.root?.sourceDiagnostics?.[0]).toMatchObject({field:'SUBSYSTEM0',lines:[5,6],values:['x.cbm','y.cbm']});
 expect(graph.root?.refs.rawRefs.SUBSYSTEM0).toEqual(['x.cbm','y.cbm']);
});
