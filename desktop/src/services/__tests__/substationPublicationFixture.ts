import { buildCbmTree } from '../../gim/cbmParser.js';

export async function publicationFixture() {
  const files = new Map(Object.entries({
    'CBM/project.cbm': 'ENTITYNAME=PROJECT\nSYSTEMNAME=fixture\nSUBSYSTEMS.NUM=1\nSUBSYSTEM0=root.cbm',
    'CBM/root.cbm': 'ENTITYNAME=F4System\nOBJECTMODELPOINTER=root.dev\nBASEFAMILY=props.fam',
    'CBM/props.fam': '[设计参数]\nkey=value\nkey=value\nkey=other',
    'DEV/root.dev': 'BASEFAMILYPOINTER=empty.fam\nSOLIDMODELS.NUM=1\nSOLIDMODEL0=root.phm',
    'DEV/empty.fam': '',
    'PHM/root.phm': 'SOLIDMODELS.NUM=0',
    'CBM/model.ifc': 'not-read-by-publication',
  }).map(([path, text]) => [path, new File([text], path)]));
  const tree = await buildCbmTree(files);
  return {
    projectId: 1,
    sourceSha256: 'fixture-sha',
    files,
    cachePaths: new Map([...files.keys()].map((p) => [p, `cache/${p}`])),
    tree,
    ifcs: [{ path: 'CBM/model.ifc', name: 'model', modelId: 'model' }],
    relations: [],
  };
}
