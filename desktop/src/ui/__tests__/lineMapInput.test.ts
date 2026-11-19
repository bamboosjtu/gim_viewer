import { expect, it, vi } from 'vitest';
import { bindLineMapCanvasInput } from '../lineMapCanvasInput.js';
import { createLineMapTooltip } from '../lineMapTooltip.js';
import type { TowerMarker } from '../../gim/lineMapData.js';

it('separates dragging from clicks and releases window listeners with the Canvas',()=>{
  const canvas=document.createElement('canvas');
  const input={getPan:()=>({x:12,y:8}),panTo:vi.fn(),zoomAt:vi.fn(),hover:vi.fn(),
    click:vi.fn(),leave:vi.fn(),fit:vi.fn(),hasHover:()=>true};
  const dispose=bindLineMapCanvasInput(canvas,input);
  const mouse=(name:string,x:number,y:number)=>new MouseEvent(name,{button:0,clientX:x,clientY:y});
  canvas.dispatchEvent(mouse('mousedown',2,4));
  window.dispatchEvent(mouse('mousemove',12,21));
  window.dispatchEvent(mouse('mouseup',12,21));
  expect(input.panTo).toHaveBeenCalledWith(22,25);
  expect(input.click).not.toHaveBeenCalled();
  expect(canvas.style.cursor).toBe('pointer');
  canvas.dispatchEvent(mouse('mousedown',5,9));
  window.dispatchEvent(mouse('mouseup',5,9));
  expect(input.click).toHaveBeenCalledWith(5,9);
  const wheel=new WheelEvent('wheel',{deltaY:-1,clientX:2,clientY:3,cancelable:true});
  canvas.dispatchEvent(wheel);
  expect(wheel.defaultPrevented).toBe(true);
  expect(input.zoomAt).toHaveBeenCalledWith(2,3,1.15);
  dispose();
  window.dispatchEvent(mouse('mousemove',15,25));
  window.dispatchEvent(mouse('mouseup',15,25));
  expect(input.hover).not.toHaveBeenCalled();
  expect(input.click).toHaveBeenCalledOnce();
});

it('escapes source labels, positions the tooltip inside the map and hides it on demand',()=>{
  const element=document.createElement('div');
  Object.defineProperties(element,{offsetWidth:{value:20},offsetHeight:{value:10}});
  const tooltip=createLineMapTooltip(element);
  const tower:TowerMarker={cbmPath:'tower.cbm',lat:31,lng:120,elev:3,azimuth:null,
    towerNumber:'<img src=x>',dataQuality:'partial',nodeRef:{path:'tower.cbm'} as TowerMarker['nodeRef']};
  tooltip.show(tower,95,90,100,100);
  expect(element.querySelector('img')).toBeNull();
  expect(element.textContent).toContain('<img src=x>');
  expect(element.style.display).toBe('block');
  expect(element.style.left).toBe('61px');
  expect(element.style.top).toBe('66px');
  tooltip.hide();
  expect(element.style.display).toBe('none');
});
