import {it,expect} from 'vitest';
import {buildCbmTree} from '../cbmParser.js';
import {decodeGimText} from '../../shared/textDecode.js';
it('resolves CBM references relative to actual owner paths',async()=>{
 const files=new Map([['Export/Project.cbm',new File(['ENTITYNAME=F1System\nSUBSYSTEM=Nested/child.cbm'],'Project.cbm')],['Export/Nested/child.cbm',new File(['ENTITYNAME=F2System'],'child.cbm')]]);
 const tree=await buildCbmTree(files);expect(tree?.path).toBe('Export/Project.cbm');expect(tree?.children[0].path).toBe('Export/Nested/child.cbm');
});
it('does not choose an ambiguous basename',async()=>{
 const files=new Map([['root/project.cbm',new File(['ENTITYNAME=F1System\nSUBSYSTEM=child.cbm'],'project.cbm')],...['a','b'].map(folder=>[folder+'/child.cbm',new File(['ENTITYNAME=F2System'],'child.cbm')] as [string,File])]);
 expect((await buildCbmTree(files))?.children).toHaveLength(0);
});
it('decodes UTF8 and GBK without replacement characters',()=>{
 expect(decodeGimText(new TextEncoder().encode('测试')).encoding).toBe('utf-8');
 const decoded=decodeGimText(new Uint8Array([0xb2,0xe2,0xca,0xd4]));expect(decoded).toEqual({text:'测试',encoding:'gb18030'});
});
