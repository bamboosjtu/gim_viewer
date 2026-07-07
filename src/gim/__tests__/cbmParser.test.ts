import { describe, expect, it } from 'vitest';
import { buildCbmTree } from '../cbmParser.js';

function textFile(text: string, name: string): File {
  return new File([text], name, { type: 'text/plain' });
}

describe('buildCbmTree DEV SUBDEVICES expansion', () => {
  it('gives repeated child DEV instances unique virtual paths and preserves each local matrix', async () => {
    const files = new Map<string, File>([
      ['CBM/project.cbm', textFile(`ENTITYNAME=F1System
SUBSYSTEM=root.cbm`, 'project.cbm')],
      ['CBM/root.cbm', textFile(`ENTITYNAME=F4System
OBJECTMODELPOINTER=parent.dev`, 'root.cbm')],
      ['DEV/parent.dev', textFile(`SYMBOLNAME=Parent
TYPE=ParentType
SUBDEVICES.NUM=2
SUBDEVICE0=child.dev
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,100,0,0,1
SUBDEVICE1=child.dev
TRANSFORMMATRIX1=1,0,0,0,0,1,0,0,0,0,1,0,200,0,0,1
SOLIDMODELS.NUM=0`, 'parent.dev')],
      ['DEV/child.dev', textFile(`SYMBOLNAME=Child
TYPE=ChildType
SUBDEVICES.NUM=0
SOLIDMODELS.NUM=0`, 'child.dev')],
    ]);

    const tree = await buildCbmTree(files, '变电工程');
    const rootDevice = tree?.children[0];
    expect(rootDevice?.children).toHaveLength(2);

    const [first, second] = rootDevice!.children;
    expect(first.path).toContain('#dev:0:child.dev');
    expect(second.path).toContain('#dev:1:child.dev');
    expect(first.path).not.toBe(second.path);
    expect(first.transformMatrix.split(',').map(Number)[12]).toBe(100);
    expect(second.transformMatrix.split(',').map(Number)[12]).toBe(200);
  });
});
