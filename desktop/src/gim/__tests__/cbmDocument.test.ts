import{it,expect,vi}from'vitest';import{discoverIfcFromCBM}from'../gimIndexer.js';import{buildCbmTree}from'../cbmParser.js';import{readCbmDocument}from'../cbmDocument.js';
it('shares immutable documents between IFC discovery and tree building and invalidates replaced values',async()=>{
 const file=new File(['ENTITYNAME=F1System\nIFCGUID=old\nIFC.NUM=1\nIFC0=model.ifc'],'project.cbm'),read=vi.spyOn(file,'arrayBuffer');
 const files=new Map([['CBM/project.cbm',file],['CBM/model.ifc',new File(['IFC'],'model.ifc')]]);
 expect(await discoverIfcFromCBM(files)).toHaveLength(1);expect((await buildCbmTree(files))?.ifcGuid).toBe('old');expect(read).toHaveBeenCalledOnce();
 const next=new File(['ENTITYNAME=F1System\nIFCGUID=next'],'project.cbm');files.set('CBM/project.cbm',next);
 expect((await buildCbmTree(files))?.ifcGuid).toBe('next');expect(Object.isFrozen(await readCbmDocument(next))).toBe(true);
});
