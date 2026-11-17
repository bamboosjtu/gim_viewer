/** Window-owned viewport capability, supplied by the application composition root. */
export let container:HTMLElement;
export function bind(port:{container:HTMLElement}):void {if('container' in port)container=port.container;}
