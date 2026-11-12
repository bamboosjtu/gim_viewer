/** Local actual-engine check. --build additionally exercises fixed WebView2. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {createServer as createHttpServer} from 'node:http';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {artifactDirectory} from '../benchmarks/batch-input.mjs';
import {runNative} from '../benchmarks/native-run.mjs';
import {sourceFingerprint} from '../benchmarks/acceptance-build.mjs';

if(process.env.CI)throw Error('IFC engine fixture is local-only; do not run in remote CI');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),desktop=join(root,'desktop');
const out=artifactDirectory(root,join(root,'tmp/local-tests','ifc-connections-'+Date.now()));
const sha=value=>createHash('sha256').update(value).digest('hex');
const at=process.argv.indexOf('--build'),buildManifest=at<0?null:resolve(process.argv[at+1]);
const report={status:'FAIL',runtime:buildManifest?'fixed-webview2-web-ifc-wasm':'node-web-ifc-wasm',nativeWebView2Verified:false,
  checkerSha256:sha(readFileSync(fileURLToPath(import.meta.url))),
  readerSha256:sha(readFileSync(join(desktop,'src/viewer/ifcConnectionBatches.ts'))),
  caseSha256:sha(readFileSync(join(desktop,'src/measurement/ifcConnectionVerification.ts')))};
let server,api;
try{
  if(buildManifest){
    const build=JSON.parse(readFileSync(buildManifest,'utf8'));
    assert.equal(sourceFingerprint(root),build.sourceFingerprint,'build must match current source/checker');
    let probe;
    const native=await runNative({root,buildManifest,doctor:true,timeoutMs:120000,
      onReady:async(cdp,identity)=>{
        const browser=await cdp.send('Browser.getVersion');
        Object.assign(report,{browser,buildManifest,buildFingerprint:build.sourceFingerprint,runtimeSha256:build.runtime.sha256,nativeRun:identity.out});
        probe=await cdp.evaluate('globalThis.__gimBenchmark.ifcConnectionProbe()',undefined,120000);
        writeFileSync(join(out,'probe.private.json'),JSON.stringify(probe,null,2));
        assert.equal(probe.status,'PASS',probe.error);assert.equal(probe.nativeWebView2Verified,true);
        assert.equal(probe.wasmSha256,sha(readFileSync(join(desktop,'public/wasm/web-ifc.wasm'))));
        Object.assign(report,probe,{browser,buildManifest,buildFingerprint:build.sourceFingerprint,runtimeSha256:build.runtime.sha256,nativeRun:identity.out});
      }});
    assert(probe,'native probe did not execute');assert(native.report.cleanupComplete);
    assert.equal(native.report.reason,null);
    report.nativeControllerReport=join(native.out,'report.json');
  }else{
    const require=createRequire(import.meta.url),{IfcAPI}=require('web-ifc');
    server=await createServer({configFile:false,root:desktop,cacheDir:join(out,'vite-cache'),
      server:{middlewareMode:true,hmr:{server:createHttpServer()},watch:{ignored:['**/*']}}});
    const {verifyIfcConnectionReader,IFC_CONNECTION_FIXTURE}=await server.ssrLoadModule('/src/measurement/ifcConnectionVerification.ts');
    writeFileSync(join(out,'connection.private.ifc'),IFC_CONNECTION_FIXTURE);
    api=new IfcAPI();await api.Init(file=>join(desktop,'node_modules/web-ifc',file));
    Object.assign(report,await verifyIfcConnectionReader(api),{nodeVersion:process.version,
      wasmSha256:sha(readFileSync(join(desktop,'node_modules/web-ifc/web-ifc-node.wasm')))});
  }
  report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error);process.exitCode=1;}
finally{api?.Dispose();await server?.close();writeFileSync(join(out,'report.private.json'),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({status:report.status,nativeWebView2Verified:report.nativeWebView2Verified,report:join(out,'report.private.json'),error:report.error}));
