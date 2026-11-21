import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkPresentationSource} from './presentation-boundaries.mjs';
test('new loaders, keys, aliases and DOM operations cannot bypass the presentation boundary',()=>{
  for(const source of ["loadPresentation('propsDrawer');loadPresentation('propsDrawer')","loadPresentation('tabs')","loadPresentation(key)","import {loadPresentation as view} from './presentationPort.js';view('tabs')","port.loadPresentation('tabs')","document.querySelector('#a')","body.innerHTML='x'","tip.style.display='none'"])
    assert.ok(checkPresentationSource(source,'services/a.ts').length,source);
});

test('rejects assigned aliases and bracket notation for the old loader',()=>{
  for(const source of ["const alias = port['loadPresentation']; alias(key)", "const alias = (loadPresentation as Loader); const use = alias; use(key)", "port['loadPresentation'](key)"])
    assert.match(checkPresentationSource(source,'services/demo.ts').join('\n'),/generic presentation module loaders/);
});
test('explicit commands and local document evidence remain allowed',()=>{
  assert.deepEqual(checkPresentationSource('projectPresentation().clearSelection(); const document={target:null}; return document.target;','services/a.ts'),[]);
});
