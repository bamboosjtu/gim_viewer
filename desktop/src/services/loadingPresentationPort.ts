export interface LoadingPresentation {
  showLoading(text:string):void;
  hideLoading():void;
  resetLoadingClock():void;
  scheduleHideLoading(current:()=>boolean,delay:number):ReturnType<typeof setTimeout>;
}
let port:LoadingPresentation;
export function bindLoadingPresentation(value:LoadingPresentation):void {port=value;}
export function showLoading(text:string):void {port.showLoading(text);}
export function hideLoading():void {port.hideLoading();}
export function resetLoadingClock():void {port.resetLoadingClock();}
export function scheduleHideLoading(current:()=>boolean,delay:number):ReturnType<typeof setTimeout> {return port.scheduleHideLoading(current,delay);}
