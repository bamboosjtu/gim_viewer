import { buildCbmTree } from '../../gim/cbmParser.js';

export async function nestedPartFixture(parentCopies=1, missing=false) {
  const refs=Array.from({length:parentCopies},(_,i) => `SUBDEVICE${i}=A.dev`).join('\n');
  const raw={
    'CBM/project.cbm':'ENTITYNAME=F3System\nSUBSYSTEMS.NUM=1\nSUBSYSTEM0=root.cbm',
    'CBM/root.cbm':'ENTITYNAME=F4System\nOBJECTMODELPOINTER=root.dev\nSUBDEVICES.NUM=1\nSUBDEVICE0=part-a.cbm',
    'CBM/part-a.cbm':'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=A.dev\nSUBDEVICES.NUM=1\nSUBDEVICE0=part-b.cbm',
    'CBM/part-b.cbm':`ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=${missing ? 'absent':'B'}.dev`,
    'DEV/root.dev':`SUBDEVICES.NUM=${parentCopies+1}\n${refs}\nSUBDEVICE${parentCopies}=B.dev`,
    'DEV/A.dev':'SUBDEVICES.NUM=1\nSUBDEVICE0=B.dev',
    'DEV/B.dev':'SOLIDMODELS.NUM=1\nSOLIDMODEL0=leaf.phm',
    'PHM/leaf.phm':'SOLIDMODELS.NUM=1\nSOLIDMODEL0=leaf.mod',
    'MOD/leaf.mod':'<Device><Entities><Entity ID="1" Visible="true"><Cuboid L="100" W="100" H="100"/></Entity></Entities></Device>',
  };
  const files=new Map(Object.entries(raw).map(([p,text]) => [p,new File([text],p)]));
  const tree=(await buildCbmTree(files))!,root=tree.children[0],a=root.children[0],b=a.children[0];
  return {files,tree,root,a,b};
}
