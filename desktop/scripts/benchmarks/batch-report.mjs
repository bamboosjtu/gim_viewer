import {writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {median} from './compare.mjs';

const escapeHtml=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function csv(rows,columns){
  const cell=value=>{let text=value==null?'':String(value);if(/^[=+\-@\t\r]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
  return '\uFEFF'+[columns,...rows.map(row=>columns.map(key=>row[key]))].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}
const put=(out,name,value)=>{
  const temporary=join(out,`${name}.next`);writeFileSync(temporary,value);
  // Windows readers/virus scanners can briefly deny replacement. Keep the old
  // complete report until a bounded retry succeeds; never truncate it in place.
  for(let attempt=0;;attempt++)try{renameSync(temporary,join(out,name));return;}
  catch(error){if(!['EPERM','EBUSY','EACCES'].includes(error.code)||attempt===9)throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);}
};
const metrics=['firstResponseMs','firstGeometryMs','automaticLoadMs','cachePublishMs','processPrivatePeakBytes'];
export function summarize(rows){
  const groups=new Map();
  for(const row of rows){const key=`${row.inputId}:${row.cacheState}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  return [...groups.values()].map(group=>{
    const result={inputId:group[0].inputId,sampleId:group[0].sampleId,sampleLabel:group[0].sampleLabel,
      sampleTier:group[0].sampleTier,group:group[0].group,cacheState:group[0].cacheState,planned:group.length,
      passed:group.filter(r=>r.status==='PASS').length,partial:group.filter(r=>r.status==='PARTIAL').length,
      failed:group.filter(r=>['FAIL','INPUT_ERROR','ERROR'].includes(r.status)).length,
      inconclusive:group.filter(r=>r.status==='INCONCLUSIVE').length,skipped:group.filter(r=>['SKIPPED','DUPLICATE','CANCELLED'].includes(r.status)).length};
    const comparable=group.filter(row=>['PASS','PARTIAL'].includes(row.status));
    result.validRepetitions=comparable.length;
    result.startupRetries=group.reduce((sum,row)=>sum+Math.max(0,(row.attempts??1)-1),0);
    const mixedCoverage=new Set(comparable.map(row=>row.status)).size>1;
    // Never mix full and source-degraded coverage in one median.
    for(const key of metrics){const values=comparable.map(row=>row[key]).filter(Number.isFinite);result[`${key}Median`]=!mixedCoverage&&values.length===comparable.length&&values.length?median(values):null;}
    return result;
  });
}

export function writeBatchReports(out,state){
  const summaries=summarize(state.rows),counts={};for(const row of state.rows)counts[row.status]=(counts[row.status]??0)+1;
  const publicState={...state,counts,summaries};
  put(out,'results.json',JSON.stringify(publicState,null,2));
  const columns=['inputId','sampleLabel','sourcePath','sampleId','sourceSha256','sampleTier','group','repetition','cacheState','status','error','runId',...metrics,
    'attempts','startupFailures','expectedRole','projectType','correctness','partialEvidenceStatus','partialEvidenceDigest','inputVariantCode','inputVariant','cacheFailureCode','cachePublished','coverageComplete','engineeringCacheStatus','partialOccurrences','sourceReferenceStatuses','measurementDetailDropped','measurementAggregatedDetail','cacheVerified','measurementComplete','processSamples','processSamplesAvailable','missingWorkerHeaps','failedGeometry','failedGeometryReasons','geometryStatuses','failedSourceCount','failedSourceSetDigest','pendingTasks','backgroundSettled','cachePublication','linePackAssessment','duplicateOf'];
  put(out,'results.csv',csv(state.rows,columns));
  put(out,'summary.csv',csv(summaries,['inputId','sampleLabel','sampleId','sampleTier','group','cacheState','planned','validRepetitions','startupRetries','passed','partial','failed','inconclusive','skipped',...metrics.map(key=>`${key}Median`)]));
  put(out,'errors.csv',csv(state.rows.filter(row=>!['PASS','PENDING','RUNNING','DUPLICATE'].includes(row.status)),columns));
  put(out,'stages.csv',csv(state.stages,['runId','sampleLabel','sourceSha256','sampleId','repetition','cacheState','stage','count','totalMs','maxMs','p50LowerMs','p50UpperMs','p95LowerMs','p95UpperMs','p99LowerMs','p99UpperMs']));
  put(out,'workers.csv',csv(state.workers,['runId','sampleLabel','sourceSha256','sampleId','repetition','cacheState','workerId','family','heapAvailability','heapSamples','observedHeapPeakBytes','maxSampleDelayMs']));
  const rows=state.rows.map(row=>`<tr data-status="${escapeHtml(row.status)}"><td>${escapeHtml(row.inputId)}</td><td>${escapeHtml(row.sampleLabel??row.sourceSha256??row.inputId)}</td><td>${escapeHtml(row.sampleTier??'—')}</td><td>${escapeHtml(row.group??'—')}</td><td>${row.repetition??'—'}</td><td>${escapeHtml(row.cacheState)}</td><td class="${escapeHtml(row.status)}">${escapeHtml(row.status)}</td><td>${row.attempts??'—'}</td>${metrics.map(key=>`<td>${Number.isFinite(row[key])?(row[key]/(key.endsWith('Bytes')?2**30:1000)).toFixed(3):'—'}</td>`).join('')}<td>${escapeHtml(row.expectedRole??'—')}</td><td>${escapeHtml(row.projectType??'—')}</td><td>${escapeHtml(row.inputVariant??'—')}</td><td>${row.cachePublished===true?'已发布':row.cachePublished===false?'未发布':'—'}</td><td>${row.coverageComplete===true?'完整':row.coverageComplete===false?'部分':'—'}</td><td>${row.measurementDetailDropped??'—'}</td><td>${escapeHtml(row.cachePublication??'—')}</td><td>${escapeHtml(row.linePackAssessment??'—')}</td><td>${escapeHtml([row.error,row.cacheFailureCode,...(row.startupFailures??[]),row.failedGeometryReasons].filter(Boolean).join('; ')||'—')}</td></tr>`).join('');
  const summaryRows=summaries.map(row=>`<tr><td>${escapeHtml(row.sampleLabel)}</td><td>${escapeHtml(row.cacheState)}</td><td>${row.validRepetitions}/${row.planned}</td><td>${row.startupRetries}</td><td>${row.passed}</td><td>${row.partial}</td><td>${row.inconclusive}</td><td>${row.skipped}</td></tr>`).join('');
  const statusOptions=Object.keys(counts).sort().map(key=>`<option>${key}</option>`).join('');
  const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GIM Benchmark 批量报告</title>
<style>body{font:14px system-ui,sans-serif;background:#101923;color:#e3edf7;margin:28px}h1{font-size:26px}a{color:#80bdff}header{display:flex;gap:24px;align-items:baseline;flex-wrap:wrap}.cards{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}.card{padding:12px 18px;background:#1d2d3e;border-radius:8px}.card b{font-size:22px;margin-left:12px}.note{color:#aebfd0;line-height:1.6}.scroll{overflow:auto;border:1px solid #32455b}table{border-collapse:collapse;min-width:1350px;width:100%;font-size:13px}th,td{padding:10px;text-align:left;border-bottom:1px solid #304055}th{background:#203347;cursor:pointer;white-space:nowrap}td{max-width:360px;overflow-wrap:anywhere}tr:nth-child(even){background:#162332}.PASS{color:#77e6b5}.PARTIAL{color:#ffd587}.FAIL,.ERROR,.INPUT_ERROR{color:#ff9e9e}.INCONCLUSIVE,.SKIPPED,.CANCELLED{color:#ffd587}input,select{font:inherit;padding:9px;background:#1d2d3e;color:#fff;border:1px solid #536b84;border-radius:4px;margin:8px}footer{margin-top:24px}</style>
<header><h1>GIM Benchmark</h1><strong>${escapeHtml(state.status)} · ${escapeHtml(state.outcome)}</strong></header>
<p class="note">${state.anonymize?'匿名：完整 SHA256':'实名：文件名'} · ${escapeHtml(state.preset)} · ${state.repetitions} 轮 · ${escapeHtml(state.updatedAt)}<br>构建 ${escapeHtml(state.buildFingerprint)} · Profile ${escapeHtml(state.profileDigest)}</p>
<div class="cards">${Object.entries(counts).map(([key,value])=>`<div class="card ${key}">${key}<b>${value}</b></div>`).join('')}</div>
<p class="note">每行是一个输入的一次运行。失败、缺失、重复及未完成项全部保留；单个失败不会终止其他输入。首次响应、首次几何、自动加载和缓存就绪单位为秒；Private Bytes 为原生进程树观测峰值 GiB。空值表示未取得。阶段 wall time 不是 CPU time；Worker 堆不是 OS 内存。汇总中位数只使用相同覆盖状态的 PASS 或 PARTIAL 轮次，必须结合各状态轮数阅读。</p>
<h2>样本覆盖</h2><div class="scroll"><table><thead><tr>${['样本','缓存','有效 / 计划','基础设施重试','PASS','PARTIAL','INCONCLUSIVE','跳过'].map(v=>`<th scope="col">${v}</th>`).join('')}</tr></thead><tbody>${summaryRows}</tbody></table></div>
<p><a href="results.csv">全部结果 CSV</a> · <a href="errors.csv">错误 CSV</a> · <a href="summary.csv">汇总 CSV</a> · <a href="stages.csv">阶段 CSV</a> · <a href="workers.csv">Worker CSV</a> · <a href="results.json">JSON</a></p>
<label>筛选 <input id="search" placeholder="文件名 / SHA256 / 错误码"></label><label>状态 <select id="status"><option value="">全部</option>${statusOptions}</select></label><span id="visible"></span>
<div class="scroll"><table id="results"><thead><tr>${['输入',state.anonymize?'文件 SHA256':'文件名','层级','组','轮次','缓存','结果','尝试','首次响应 s','首次几何 s','自动加载 s','缓存就绪 s','Private 峰值 GiB','期望类型','实际类型','输入变体','缓存发布','来源覆盖','明细丢失','发布状态','pack 状态','错误 / 不完整原因'].map(v=>`<th scope="col">${v}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
<footer class="note">${state.baselineEligible?'冷暖证据已齐备；PARTIAL 仅在显式接受来源缺陷后才能成为部分基线。':'此报告尚不是认可基线；一轮摸底、未执行项、失败或不完整测量不能作为基线通过。'}<br>${state.anonymize?'此报告已隐藏源路径与文件名。':'此报告包含源文件名及工作区相对路径，分享前请确认资料权属。'}原始日志、授权清单、profile 和堆快照仅保存在工作区私有运行目录。运行期间刷新本页可查看已落盘结果。</footer>
<script>const table=document.querySelector('#results'),body=table.tBodies[0],search=document.querySelector('#search'),status=document.querySelector('#status');function filter(){let n=0;for(const row of body.rows){const show=(!status.value||row.dataset.status===status.value)&&row.textContent.toLowerCase().includes(search.value.toLowerCase());row.hidden=!show;if(show)n++}document.querySelector('#visible').textContent=n+' 行'}search.oninput=status.onchange=filter;table.querySelectorAll('th').forEach((th,index)=>{let ascending=true;th.onclick=()=>{const rows=[...body.rows];rows.sort((a,b)=>{const x=a.cells[index].textContent,y=b.cells[index].textContent;return (ascending?1:-1)*(x!==''&&y!==''&&Number.isFinite(+x)&&Number.isFinite(+y)?+x-+y:x.localeCompare(y))});rows.forEach(row=>body.append(row));ascending=!ascending}});filter();</script></html>`;
  put(out,'report.html',html);
}
