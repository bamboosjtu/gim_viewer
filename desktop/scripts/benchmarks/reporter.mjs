import {publicView,analyzeRun,writeObservabilityReport,exportRunTrace} from './observability.mjs';
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeBatchReports} from './batch-report.mjs';
import {isPublicArtifact} from './batch-input.mjs';
const safe=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const fixed=(value,scale=1)=>Number.isFinite(value)?(value/scale).toFixed(2):'不可用';

export async function renderReport(input,out,{root:reportRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../..')}={}){
  const report=JSON.parse(readFileSync(input,'utf8'));mkdirSync(out,{recursive:true});
  if(report.version==='gim-batch-results-v1'){writeBatchReports(out,report,{root:reportRoot});return out;}
  if(existsSync(join(dirname(input),'events.jsonl'))){const analysis=await analyzeRun(reportRoot,input);await exportRunTrace(reportRoot,input);
    return writeObservabilityReport(out,analysis,{internal:!isPublicArtifact(reportRoot,out)});}
  if(isPublicArtifact(reportRoot,out))return writeObservabilityReport(out,{metrics:publicView(report).metrics,pipeline:[],coverage:[],paths:[],issues:['trace-unavailable']});
  const phases=Object.entries(report.measurement?.phases??{}).sort((a,b)=>b[1].totalMs-a[1].totalMs);
  const memoryFile=join(dirname(input),'process-memory.json');
  const memory=existsSync(memoryFile)?JSON.parse(readFileSync(memoryFile,'utf8')).map(row=>({atMs:row.atMs,bytes:row.bytes,availability:row.availability,delayMs:row.sampleDelayMs})):[];
  const phaseRows=phases.slice(0,30).map(([name,row])=>[name,row.count??'—',fixed(row.totalMs),row.p50?`${fixed(row.p50.lowerMs)}–${fixed(row.p50.upperMs)}`:'—',row.p95?`${fixed(row.p95.lowerMs)}–${fixed(row.p95.upperMs)}`:'—',fixed(row.maxMs)]);
  const table=phaseRows.map(row=>'| '+row.join(' | ')+' |').join('\n');
  const phaseTable='<table><thead><tr>'+['阶段','调用数','累计 ms','p50 区间 ms','p95 区间 ms','最大 ms'].map(value=>'<th>'+value+'</th>').join('')+'</tr></thead><tbody>'+phaseRows.map(row=>'<tr>'+row.map(value=>'<td>'+safe(value)+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
  let markdown=`# Benchmark ${report.outcome??'INCONCLUSIVE'}\n\n`;
  if(report.summaries)markdown+='| 样本 | 缓存 | 轮次 | 首次响应 s | 自动加载 s | Private 观测峰值 GiB |\n|---|---|---:|---:|---:|---:|\n'+report.summaries.map(row=>`| ${row.sampleId} | ${row.cacheState} | ${row.runs} | ${fixed(row.metrics.firstResponseMs,1000)} | ${fixed(row.metrics.automaticLoadMs,1000)} | ${fixed(row.metrics.processPrivatePeakBytes,2**30)} |`).join('\n')+'\n\n';
  markdown+=`阶段是 wall time，嵌套/并行阶段不能相加为总时间；分位数为直方图区间。内存峰值是观测峰值，不是 GPU 显存或所有对象的完整占用。\n\n| 阶段 | 调用数 | 总 ms | p50 ms | p95 ms | 最大 ms |\n|---|---:|---:|---:|---:|---:|\n${table}\n\n`;
  markdown+='未记录详细事件；只展示已采集的汇总和内存样本，不生成执行时间线或慢任务列表。\n';
  writeFileSync(join(out,'report.md'),markdown);
  const payload=JSON.stringify({outcome:report.outcome,memory,metrics:report.metrics??null}).replaceAll('<','\\u003c');
  const html=`<!doctype html><meta charset="utf-8"><title>GIM Benchmark</title><style>body{font:15px system-ui;margin:32px;color:#dce7f5;background:#111923}h1{font-size:24px}canvas{background:#172333;width:100%;height:260px}pre{white-space:pre-wrap}.note{color:#a3b4c8}table{border-collapse:collapse}td,th{padding:6px 12px;text-align:right;border-bottom:1px solid #30425a}td:first-child,th:first-child{text-align:left}</style><h1>GIM Benchmark · ${safe(report.outcome??'INCONCLUSIVE')}</h1><p class="note">原生进程树 Private Bytes · 观测峰值；鼠标移入查看采样点。时间轴使用原生采样器时钟。</p><canvas id="memory"></canvas><p id="hover"></p><h2>阶段汇总</h2><p class="note">未记录详细事件，阶段累计值不能相加为打开时长。</p>${phaseTable}<script>const data=${payload};const canvas=document.querySelector('#memory'),ctx=canvas.getContext('2d');canvas.width=1400;canvas.height=260;const rows=data.memory.filter(r=>r.bytes!==null&&r.availability==='available'),max=Math.max(1,...rows.map(r=>r.bytes)),end=Math.max(1,...rows.map(r=>r.atMs));ctx.strokeStyle='#69baff';ctx.beginPath();let pen=false;data.memory.forEach(r=>{if(r.bytes===null||r.availability!=='available'){pen=false;return}const x=r.atMs/end*1380+10,y=240-r.bytes/max*220;pen?ctx.lineTo(x,y):ctx.moveTo(x,y);pen=true});ctx.stroke();canvas.onmousemove=e=>{const t=(e.offsetX/canvas.clientWidth)*end;const r=rows.reduce((a,b)=>!a||Math.abs(b.atMs-t)<Math.abs(a.atMs-t)?b:a,null);document.querySelector('#hover').textContent=r?(r.atMs/1000).toFixed(1)+' s · '+(r.bytes/2**30).toFixed(3)+' GiB · 采样延迟 '+r.delayMs.toFixed(1)+' ms':'不可用'};</script>`;
  writeFileSync(join(out,'report.html'),html);return out;
}
