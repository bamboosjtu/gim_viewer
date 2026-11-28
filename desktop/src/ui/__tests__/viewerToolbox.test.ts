import {expect,it,vi} from 'vitest';
import {ViewerCommands} from '../../shared/viewerCommands.js';
import {mountViewerToolbox} from '../viewerToolbox.js';
it('enables the measuring command only for an available model and releases it with the toolbox',()=>{
 const port=new ViewerCommands(),dispatch=vi.spyOn(port,'dispatch');let available=false;port.execute=async()=>{};
 const bar=document.createElement('div'),view=document.createElement('div');view.append(bar);
 const box=mountViewerToolbox(port,()=>({hasModel:available,lineProject:false,canIsolate:false,onlySelected:false,canGoBack:false}),bar,view,[]);
 const measure=bar.querySelector<HTMLButtonElement>('button[data-icon="distance"]')!;
 expect(measure.disabled).toBe(true);available=true;port.notify();expect(measure.disabled).toBe(false);
 measure.click();expect(dispatch).toHaveBeenCalledWith({kind:'tool',tool:'distance'});box.dispose();
});
