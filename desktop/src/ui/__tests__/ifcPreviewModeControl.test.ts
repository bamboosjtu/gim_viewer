import {afterEach,expect,it} from 'vitest';
import {setupIfcPreviewModeControl} from '../ifcPreviewModeControl.js';
import {isIfcNearDetailEnabled,readIfcOpeningPolicy} from '../../config/features.js';
import {setProjectIdentity} from '../shell/projectBar.js';
afterEach(()=>{localStorage.clear();document.body.innerHTML='';});
it('product detail defaults to automatic regional LOD and switches immediately to far',()=>{
 document.body.innerHTML='<button id="btn-ifc-opening-policy"></button>';setupIfcPreviewModeControl();
 const button=document.querySelector('button')!;expect(readIfcOpeningPolicy()).toBe('bim-lod');expect(isIfcNearDetailEnabled()).toBe(true);
 button.click();expect(isIfcNearDetailEnabled()).toBe(false);button.click();expect(isIfcNearDetailEnabled()).toBe(true);
 setProjectIdentity('line','transmission_line');expect(button.classList.contains('hidden')).toBe(true);
});
