import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkPresentationSource,checkPresentationRegistry} from './presentation-boundaries.mjs';
test('the legacy registry cannot add unused or unbudgeted keys',()=>{
  const source="export interface PresentationModules {'tree':unknown;'newView':unknown}";
  assert.equal(checkPresentationRegistry(source,new Set(['tree'])).length,1);
  assert.equal(checkPresentationRegistry(source,new Set(['tree','newView'])).length,0);
});
test('new loaders, keys, aliases and DOM operations cannot bypass the presentation boundary',()=>{
  assert.equal(checkPresentationSource("loadPresentation('propsDrawer')",'services/a.ts',{propsDrawer:1}).length,0);
  for(const source of ["loadPresentation('propsDrawer');loadPresentation('propsDrawer')","loadPresentation('tabs')","loadPresentation(key)","import {loadPresentation as view} from './presentationPort.js';view('tabs')","port.loadPresentation('tabs')","document.querySelector('#a')","body.innerHTML='x'","tip.style.display='none'"])
    assert.ok(checkPresentationSource(source,'services/a.ts',{propsDrawer:1}).length,source);
});
test('explicit commands and local document evidence remain allowed',()=>{
  assert.deepEqual(checkPresentationSource('projectPresentation().clearSelection(); const document={target:null}; return document.target;','services/a.ts'),[]);
});
