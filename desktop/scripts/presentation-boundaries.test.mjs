import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkPresentationSource} from './presentation-boundaries.mjs';
test('new loaders, keys, aliases and DOM operations cannot bypass the presentation boundary',()=>{
  for(const source of ["loadPresentation('propsDrawer');loadPresentation('propsDrawer')","loadPresentation('tabs')","loadPresentation(key)","import {loadPresentation as view} from './presentationPort.js';view('tabs')","port.loadPresentation('tabs')","document.querySelector('#a')","body.innerHTML='x'","tip.style.display='none'"])
    assert.ok(checkPresentationSource(source,'services/a.ts').length,source);
});
test('explicit commands and local document evidence remain allowed',()=>{
  assert.deepEqual(checkPresentationSource('projectPresentation().clearSelection(); const document={target:null}; return document.target;','services/a.ts'),[]);
});
