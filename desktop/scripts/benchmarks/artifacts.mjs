import {existsSync,statSync,writeFileSync} from 'node:fs';
import {basename,join} from 'node:path';
/** Private inventory only: never copy raw traces or profiles into public output. */
export function writeArtifactInventory(out,report){
  const file=(name,requested,reason)=>{
    const present=existsSync(join(out,name)),bytes=present?statSync(join(out,name)).size:0;
    return {file:present?name:null,bytes,status:bytes?'available':requested?'unavailable':'not-requested',
      ...(!bytes?{reason:requested?'artifact-not-produced':reason??'diagnostic-not-requested'}:{})};
  };
  const detailed=report.conditions?.mode==='diagnostic',plan=report.diagnostics?.configuration;
  const captures=(report.diagnostics?.captures??[]).map(capture=>{
    const row=file(basename(capture.privateArtifact??`${capture.requested?.id}.missing`),true);
    return {...row,kind:capture.requested?.kind,status:capture.status==='available'?row.status:capture.status,
      ...(capture.reason?{reason:capture.reason}:{})};
  });
  const gpu=report.diagnostics?.gpu??{requested:false,availability:'not-requested'};
  const inventory={version:'gim-private-artifacts-v1',runId:report.runId,mode:report.conditions?.mode,
    traceDetail:detailed?'diagnostic-lifecycle':'benchmark-intervals-only',
    events:file('events.jsonl',['benchmark','diagnostic'].includes(report.conditions?.mode)),
    nativeGcHeap:{...file('native-gc-heap.private.json',report.conditions?.workerHeapPolicy==='isolated-cdp-gc-heap-v1'),
      traceComplete:report.sampling?.nativeGc?.traceComplete??false,clockVerified:report.sampling?.nativeGc?.clockVerified??false,
      proofDigest:report.sampling?.nativeGc?.proofDigest??null},
    trace:file('trace.private.json',detailed),analysis:file('analysis.private.json',detailed),
    captures,gpu:{...file('gpu.private.json',gpu.requested),status:!gpu.requested?'not-requested':gpu.available?'available':report.projectType==='transmission_line'?'unsupported':gpu.availability??'unavailable',availability:gpu.availability,availableSamples:gpu.available??0,
      reason:!gpu.requested?'gpu-not-requested':report.projectType==='transmission_line'?'line-gpu-timer-not-instrumented':
        gpu.available?'observed-gpu-queries':gpu.unsupported?'timer-extension-missing':'no-valid-gpu-query'}};
  for(const kind of ['cpu','heap','allocations'])if(!captures.some(row=>row.kind===kind))captures.push({kind,status:'not-requested',file:null,reason:'capture-not-configured'});
  writeFileSync(join(out,'artifacts.private.json'),JSON.stringify(inventory,null,2));return inventory;
}
