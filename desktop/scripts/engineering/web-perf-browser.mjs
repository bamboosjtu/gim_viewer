/** Local web performance probe: serve the browser build, open a real .gim via
 * Playwright, and export the same stable benchmark contract as Ctrl+Shift+B.
 * This is a browser/WebView-adjacent measurement, not the Tauri native SLO.
 * Usage: node scripts/engineering/web-perf-browser.mjs ../demo/substations/substation04.gim
 */
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve, dirname, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const sample=resolve(process.argv[2]??'../demo/substations/substation04.gim');
const base=process.env.GIM_WEB_BASE??'http://127.0.0.1:14358';
const out=resolve(root,'../output/engineering-web-perf');
const edge=process.env.EDGE_PATH??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
if(!isAbsolute(sample))throw Error('sample must be absolute');
mkdirSync(out,{recursive:true});
const started=Date.now();
const browser=await chromium.launch({executablePath:edge,headless:true,
  args:['--enable-unsafe-swiftshader','--use-angle=swiftshader','--disable-dev-shm-usage']});
const context=await browser.newContext({viewport:{width:1600,height:900}});
const page=await context.newPage();
const consoleLines=[];
page.on('console',message=>{
  const text=message.text();
  if(message.type()==='error'||message.type()==='pageerror'||(message.type()==='warning'&&!/GLTFExporter: Use MeshStandardMaterial/.test(text)))
    consoleLines.push({type:message.type(),text:text.slice(0,500)});
  if(consoleLines.length>100)consoleLines.shift();
});
page.on('pageerror',error=>{consoleLines.push({type:'pageerror',text:String(error).slice(0,500)});if(consoleLines.length>100)consoleLines.shift();});
try{
  await page.goto(base,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForSelector('#btn-load-gim',{timeout:60000});
  await page.evaluate(()=>{
    globalThis.__GIM_BENCHMARK_SAMPLE_ID__='web-'+location.port;
    globalThis.__GIM_BENCHMARK_COLD_WARM__='cold';
  });
  const openAt=Date.now();
  const chooserPromise=page.waitForEvent('filechooser',{timeout:30000});
  await page.click('#btn-load-gim');
  const chooser=await chooserPromise;
  await chooser.setFiles(sample);
  await page.waitForFunction(()=>document.querySelector('.substation-nav-mode')?.children.length>=3,{timeout:300000});
  const engineeringMs=Date.now()-openAt;
  // Engineering navigation can be ready before IFC/DEV geometry. Poll the same
  // product moment the native acceptance uses, with a bounded budget.
  let fullReady=false;
  for(let i=0;i<600;i++){
    fullReady=await page.evaluate(async()=>{
      const {perfBenchmarkSnapshot}=await import('/src/utils/perfTimings.ts');
      const moments=perfBenchmarkSnapshot().productMoments;
      return Boolean(moments.allIfcReady||moments.fullModelReady||moments.devGeometryReady);
    });
    if(fullReady)break;
    await page.waitForTimeout(500);
  }
  const fullReadyMs=Date.now()-openAt;
  await page.waitForTimeout(500);
  const benchmark=await page.evaluate(async()=>{
    // The keyboard shortcut is Tauri-only. In browser mode import the same
    // dev module directly so the contract remains identical to native export.
    const {perfBenchmarkSnapshot}=await import('/src/utils/perfTimings.ts');
    return perfBenchmarkSnapshot();
  });
  const status=await page.evaluate(()=>({status:document.querySelector('#status-text')?.textContent,
    badge:document.querySelector('#project-type-badge')?.textContent,
    nav:[...document.querySelectorAll('.substation-nav-mode-btn')].map(node=>node.textContent),
    treeRows:document.querySelectorAll('.tree-row').length,
    loading:document.querySelector('#loading')?.className}));
  const report={schemaVersion:1,kind:'web-playwright-engineering-probe',sample,
    base,startedAt:new Date(started).toISOString(),engineeringMs,fullReady,fullReadyMs,benchmark,status,consoleLines};
  const stamp=new Date().toISOString().replaceAll(/[:.]/g,'-');
  const file=resolve(out,`${stamp}-${sample.split(/[\\/]/).pop().replace(/\.gim$/i,'')}.json`);
  writeFileSync(file,JSON.stringify(report,null,2));
  console.log(JSON.stringify({file,engineeringMs,fullReady,fullReadyMs,status,
    moments:Object.fromEntries(Object.entries(benchmark?.productMoments??{}).map(([key,value])=>[key,value?.atMs??null])),
    longTasks:benchmark?.longTasks,heapPeak:Math.max(0,...(benchmark?.memorySamples??[]).map(sample=>sample.jsHeapUsedBytes??0))},null,2));
} finally {
  await browser.close();
}
