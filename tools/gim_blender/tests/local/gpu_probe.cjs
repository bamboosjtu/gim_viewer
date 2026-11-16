const {chromium}=require('playwright-core'),fs=require('node:fs'),path=require('node:path');
async function main(){
 const work=path.resolve(process.argv[2]),rows=[];
 for(const [name,profile,args] of [['fresh',path.join(work,'profiles/fresh'),[]],['copied',path.join(work,'profiles/copied'),[]],['d3d11',path.join(work,'profiles/d3d11'),['--use-angle=d3d11']]]){
  const context=await chromium.launchPersistentContext(profile,{executablePath:'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',headless:false,chromiumSandbox:true,args:['--window-position=-2400,-2400',...args]});
  try{const cdp=await context.browser().newBrowserCDPSession(),info=await cdp.send('SystemInfo.getInfo');const page=context.pages()[0]||await context.newPage();await page.goto('about:blank');
   const renderer=await page.evaluate(()=>{const c=document.createElement('canvas'),g=c.getContext('webgl2');if(!g)return null;const e=g.getExtension('WEBGL_debug_renderer_info');return e?g.getParameter(e.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER)});
   rows.push({name,renderer,gpu:info.gpu,version:context.browser().version()});
  }finally{await context.close()}
 }
 fs.writeFileSync(path.join(work,'gpu-probes.json'),JSON.stringify(rows,null,2));console.log(JSON.stringify(rows.map(x=>({name:x.name,renderer:x.renderer,features:x.gpu.featureStatus}))));
}
main().catch(e=>{console.error(e);process.exitCode=1});
