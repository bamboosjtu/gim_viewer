import { expect,it } from 'vitest';
import { buildSubstationAliasIndex,deviceOccurrenceScope } from '../substationEvidence.js';
import { collectCbmDeviceInstances } from '../../services/modAutoLoadService.js';
import { resolveGeometryLoadNode } from '../../services/nodeInteractionService.js';
import { nestedPartFixture } from '../../services/__tests__/nestedPartIndexFixture.js';

it.each([1,2])('nested alias is limited to %i parent candidates and excludes unrelated B.dev',async (copies) => {
  const {tree,root,a,b}=await nestedPartFixture(copies);
  const aliases=buildSubstationAliasIndex(tree);
  expect(aliases.partToRoot.get(b.path)).toBe(root);
  expect(resolveGeometryLoadNode(tree,b)).toBe(root);
  expect(deviceOccurrenceScope(tree,b)).toEqual({rootOccurrence:root.path,assemblyPaths:Array.from({length:copies},(_,i)=>`sub:${i}/sub:0`)});
  const seeds=new Set(collectCbmDeviceInstances(tree).map(n=>n.path));
  for(const [path,candidates] of aliases.partToOccurrences){
    if(!candidates.length)continue;
    const owner=aliases.partToRoot.get(path)!;
    expect(seeds.has(owner.path)).toBe(true);
    const physical=new Set<string>();
    const walk=(n:typeof root) => {if(n.entityName!=='DEV_SUBDEVICE')return;physical.add(n.path);n.children.forEach(walk);};
    owner.children.forEach(walk);
    expect(candidates.every(n=>physical.has(n.path))).toBe(true);
  }
  const parentCandidates=aliases.partToOccurrences.get(a.path)!;
  expect(aliases.partToOccurrences.get(b.path)!.every(n=>parentCandidates.some(p=>n.path===p.path||n.path.startsWith(`${p.path}#dev:`)))).toBe(true);
});

it('a missing nested identity stays unlinked despite other geometry under its root',async()=>{
  const {tree,root,b}=await nestedPartFixture(2,true);
  expect(deviceOccurrenceScope(tree,b)).toEqual({rootOccurrence:root.path,assemblyPaths:[]});
});
