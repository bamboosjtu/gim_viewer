import {it,expect,vi} from 'vitest';
it('owns paginated source rendering, escapes content and refuses stale DOM callbacks',async()=>{
  vi.resetModules();document.body.innerHTML='<aside id="props-drawer"><div id="props-drawer-body"></div></aside>';
  const {sourceInspectorPresentation:view}=await import('../sourceInspectorPresentation.js');
  const choose=vi.fn(),onDocument=vi.fn();let current=true;
  await view.document({path:'unit.dev',isIfc:false,doc:{path:'unit.dev',fields:[],rawLines:Array.from({length:201},(_,i)=>`<row ${i+1}>`)},rows:[['文件','unit.dev']],
    references:[{owner:'unit.dev',field:'SUBDEVICE0',value:'child.dev',target:'child.dev',candidates:['child.dev'],status:'resolved'}],candidates:[{label:'<source>',choose}],current:()=>current,onDocument});
  expect(document.querySelector('pre')?.textContent).toContain('<row 200>');expect(document.querySelector('pre')?.textContent).not.toContain('<row 201>');
  const candidate=document.querySelector<HTMLElement>('[data-source-candidate]')!;candidate.click();expect(choose).toHaveBeenCalledOnce();
  document.querySelector<HTMLElement>('[data-engineering-document-ref]')!.click();expect(onDocument).toHaveBeenCalledWith('child.dev');
  document.querySelector<HTMLElement>('[data-source-page="1"]')!.click();expect(document.querySelector('pre')?.textContent).toBe('<row 201>');
  current=false;candidate.click();document.querySelector<HTMLElement>('[data-engineering-document-ref]')!.click();expect(choose).toHaveBeenCalledOnce();expect(onDocument).toHaveBeenCalledOnce();
});
