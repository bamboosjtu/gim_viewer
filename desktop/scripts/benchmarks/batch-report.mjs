import {publicView} from './observability.mjs';
import {isPublicArtifact} from './batch-input.mjs';
import {writeFileSync,renameSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {median} from './statistics.mjs';
import {diagnosticLines,buildLabel} from './report-diagnostics.mjs';

const escapeHtml=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
function reportView(out,state,{root=repoRoot,project}={}){
  if(!isPublicArtifact(root,out)||state.artifactRole==='public-derived')return state;
  const view={...(project??(value=>publicView(value,{anonymize:state.anonymize!==false})))(state),
    version:state.version,anonymize:state.anonymize!==false,baselineEligible:false};
  for(const row of view.rows??[])row.sampleLabel??=row.sampleId??row.inputId;
  return view;
}
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
/** Small recoverable checkpoint; derived tables are generated at termination. */
export function writeBatchCheckpoint(out,state){put(out,'results.json',JSON.stringify(state));}
/** Cheap public progress, without repeatedly serializing diagnostic tables. */
export function writeBatchProgress(out,state,{ready=false,...options}={}){
  const counts={};for(const row of state.rows??[])counts[row.status]=(counts[row.status]??0)+1;
  const total=state.rows?.length??0,pending=counts.PENDING??0,running=counts.RUNNING??0;
  const progress={version:state.version,artifactRole:'public-derived',artifactKind:'batch-progress',baselineEligible:false,
    exportId:state.exportId,status:state.status,outcome:state.outcome,updatedAt:state.updatedAt,total,
    completed:total-pending-running,pending,running,counts,reportReady:ready};
  put(out,'status.json',JSON.stringify(progress,null,2));
  if(ready)return;
  // Project only the result rows and report header. Diagnostic arrays can be
  // large and must not be traversed or exported on every checkpoint.
  const {version,exportId,status,outcome,preset,repetitions,buildFingerprint,buildInfo,profileDigest,
    anonymize,environmentCalibration,baselineEligible,updatedAt,rows}=state;
  const view=reportView(out,{version,exportId,status,outcome,preset,repetitions,buildFingerprint,buildInfo,profileDigest,
    anonymize,environmentCalibration,baselineEligible,updatedAt,rows},options);
  put(out,'report.html',renderBatchHtml(view,summarize(view.rows??[]),counts,progress));
}
const metrics=['firstResponseMs','modelTreeReadyMs','geometryCommitMs','firstGeometryMs','allGeometryReadyMs','automaticLoadMs','cachePublishMs','settledMs','writeDrainMs','processPrivatePeakBytes'];
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
    const signatures=new Set(comparable.map(row=>row.status==='PASS'?'PASS':row.partialSignature??'PARTIAL:unverified'));
    result.coverageGroups=signatures.size;
    result.partialSignatures=[...signatures].filter(value=>value!=='PASS').sort().join(';');
    const mixedCoverage=signatures.size>1||signatures.has('PARTIAL:unverified');
    // Never mix full and source-degraded coverage in one median.
    for(const key of metrics){const values=comparable.map(row=>row[key]).filter(Number.isFinite);result[`${key}Median`]=!mixedCoverage&&values.length===comparable.length&&values.length?median(values):null;
      result[`${key}Count`]=values.length;result[`${key}Missing`]=comparable.length-values.length;
      result[`${key}P95`]=!mixedCoverage&&values.length===comparable.length&&values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1]:null;}
    return result;
  });
}

export function writeBatchReports(out,state,options={}){
  state=reportView(out,state,options);
  const summaries=summarize(state.rows),counts={};for(const row of state.rows)counts[row.status]=(counts[row.status]??0)+1;
  const publicState={...state,counts,summaries};
  put(out,'results.json',JSON.stringify(publicState,null,2));
  const exportRows=state.rows.map(row=>({...row,buildCommit:state.buildInfo?.commit,buildFingerprint:state.buildFingerprint,partialFailedOccurrences:row.partialCounts?.failedOccurrences,
    partialFailedSources:row.partialCounts?.failedSourceCount,partialUnresolvedReferences:row.partialCounts?.unresolvedReferences}));
  const columns=['inputId','buildCommit','buildFingerprint','sampleLabel','sourcePath','sampleId','sourceSha256','sampleTier','group','repetition','cacheState','status','error','runId','partialKind','partialFailedOccurrences','partialFailedSources','partialUnresolvedReferences',...metrics,'cacheWriteBytes','cacheWriteMsPerMiB',
    'attempts','startupFailures','projectType','correctness','semanticDigestScope','pendingCount','pendingSourceCount','pendingDigest','geometryTimingPolicy','workerHeapPolicy','geometryStructuralFingerprint','devContentDigest','devContentCovered','devContentComplete','partialEvidenceStatus','partialEvidenceDigest','partialSignature','inputIntegrity','environmentSuspend','inputVariantCode','inputVariant','cacheFailureCode','cachePublished','coverageComplete','engineeringCacheStatus','devCatalogMisses','sourceFailureCatalogMisses','unexplainedCatalogMisses','catalogProofComplete','devPartialOccurrences','partialGeometryReasons','geometryDiagnosticScope','sourceReferenceStatuses','coverageIncompleteReasons','unresolvedReferenceCount','measurementDetailDropped','measurementDetailStatus','measurementAggregatedDetail','measurementLifecycleComplete','measurementLifecycleIssues','measurementIncompleteItems','memoryEvidenceComplete','memoryIncompleteItems','templateDiagnosticsStatus','cancelledBeforeStart','lateBackgroundTasks','finalEvidenceIssue','finalEvidenceAttempts','finalEvidenceDrifts','cacheVerified','measurementComplete','processSamples','processSamplesAvailable','missingWorkerHeaps','unavailableWorkerHeaps','shortLivedWorkerHeaps','notApplicableWorkerHeaps','failedGeometry','failedGeometryReasons','geometryStatuses','failedSourceCount','failedSourceSetDigest','pendingTasks','interruptedAtMs','interruptedWritePending','interruptedCacheSettled','backgroundSettled','cachePublication','linePackAssessment','duplicateOf'];
  put(out,'results.csv',csv(exportRows,columns));
  put(out,'summary.csv',csv(summaries,['inputId','sampleLabel','sampleId','sampleTier','group','cacheState','planned','validRepetitions','coverageGroups','partialSignatures','startupRetries','passed','partial','failed','inconclusive','skipped',...metrics.flatMap(key=>[`${key}Median`,`${key}P95`,`${key}Count`,`${key}Missing`])]));
  put(out,'errors.csv',csv(exportRows.filter(row=>!['PASS','PENDING','RUNNING','DUPLICATE'].includes(row.status)),columns));
  put(out,'stages.csv',csv(state.stages,['runId','sampleLabel','sourceSha256','sampleId','repetition','cacheState','stage','count','totalMs','maxMs','workloadBytes','msPerMiB','p50LowerMs','p50UpperMs','p95LowerMs','p95UpperMs','p99LowerMs','p99UpperMs']));
  put(out,'slow-tasks.csv',csv(state.slowTasks??[],['runId','sampleLabel','sourceSha256','sampleId','repetition','cacheState','family','workerId','sourceId','status','durationMs']));
  put(out,'slow-phases.csv',csv(state.slowPhases??[],['runId','sampleLabel','sourceSha256','sampleId','repetition','cacheState','family','stage','workerId','sourceId','durationMs']));
  put(out,'slow-templates.csv',csv(state.templateDiagnostics??[],['runId','sampleLabel','sourceSha256','sampleId','repetition','cacheState','kind','sourceId','taskId','lod','priority','admittedPriority','slotCapacityAtEnqueue','slotCapacity','slotsBusyAtEnqueue','queueDepthAtEnqueue','slotsBusyAtAdmit','status','queueWaitMs','slotOccupancyMs','cacheReadMs','workerAwaitMs','workerQueueWaitTotalMs','workerDispatches','inputBudgetWaitMs','outputBytes','cacheStatus','memoryPressure']));
  put(out,'workers.csv',csv(state.workers,['runId','sampleLabel','sourceSha256','sampleId','repetition','cacheState','workerId','family','heapAvailability','heapReason','heapSamples','failedHeapSamples','observedHeapPeakBytes','maxSampleDelayMs','maxSampleGapMs']));
  put(out,'report.html',renderBatchHtml(state,summaries,counts));
}

function renderBatchHtml(state,summaries,counts,progress){
  const renderIssues=row=>{const lines=diagnosticLines(row,state.workers??[]);return lines.length?'<ul class="diagnostics">'+lines.map(text=>'<li>'+escapeHtml(text)+'</li>').join('')+'</ul>':'—';};
  const rows=state.rows.map(row=>`<tr data-status="${escapeHtml(row.status)}"><td>${escapeHtml(row.inputId)}</td><td>${escapeHtml(buildLabel(state))}</td><td>${escapeHtml(row.runId??'—')}</td><td>${escapeHtml(row.sampleLabel??row.sourceSha256??row.inputId)}</td><td>${escapeHtml(row.sampleTier??'—')}</td><td>${escapeHtml(row.group??'—')}</td><td>${row.repetition??'—'}</td><td>${escapeHtml(row.cacheState)}</td><td class="${escapeHtml(row.status)}">${escapeHtml(row.status)}</td><td>${row.attempts??'—'}</td>${metrics.map(key=>`<td>${Number.isFinite(row[key])?(row[key]/(key.endsWith('Bytes')?2**30:1000)).toFixed(3):'—'}</td>`).join('')}<td>${Number.isFinite(row.cacheWriteBytes)?(row.cacheWriteBytes/2**20).toFixed(2):'—'}</td><td>${Number.isFinite(row.cacheWriteMsPerMiB)?row.cacheWriteMsPerMiB.toFixed(2):'—'}</td><td>${row.memoryEvidenceComplete===true?'完整':row.memoryEvidenceComplete===false?'不完整':'—'}</td><td>${escapeHtml(row.projectType??'—')}</td><td>${escapeHtml(row.inputVariant??'—')}</td><td>${row.cachePublished===true?'已发布':row.cachePublished===false?'未发布':'—'}</td><td>${row.coverageComplete===true?'完整':row.coverageComplete===false?'部分':'—'}</td><td>${row.devContentComplete===true?`完整 ${row.devContentCovered??0}`:row.devContentComplete===false?'不完整':'—'}</td><td>${row.measurementDetailDropped??'—'}</td><td>${row.measurementLifecycleComplete===true?'完整':row.measurementLifecycleComplete===false?'不完整':'—'}</td><td>${escapeHtml(row.cachePublication??'—')}</td><td>${escapeHtml(row.linePackAssessment??'—')}</td><td>${renderIssues(row)}</td></tr>`).join('');
  const seconds=value=>Number.isFinite(value)?(value/1000).toFixed(1):'—';
  const summaryRows=summaries.map(row=>`<tr><td>${escapeHtml(row.sampleLabel)}</td><td>${escapeHtml(row.cacheState)}</td><td>${row.validRepetitions}/${row.planned}</td><td>${row.coverageGroups}</td><td>${escapeHtml(row.partialSignatures||'—')}</td><td>${row.startupRetries}</td><td>${row.passed}</td><td>${row.partial}</td><td>${row.inconclusive}</td><td>${row.skipped}</td><td>${seconds(row.modelTreeReadyMsMedian)}</td><td>${seconds(row.allGeometryReadyMsMedian)}</td><td>${seconds(row.automaticLoadMsMedian)}</td><td>${seconds(row.cachePublishMsMedian)}</td><td>${seconds(row.settledMsMedian)}</td></tr>`).join('');
  const calibration=state.environmentCalibration;
  const gib=bytes=>Number.isFinite(bytes)?(bytes/2**30).toFixed(1):'不可用';
  const calibrationNote=Number.isFinite(calibration?.cpuMs)
    ?`控制器校准：CPU SHA256 ${calibration.cpuMs.toFixed(1)} ms · 工作区同步写 ${calibration.writeSyncMs?.toFixed(1)??'—'} ms · 暖读 ${calibration.readWarmMs?.toFixed(1)??'—'} ms · CPU ${calibration.machine?.cpuModel??'未知'} / ${calibration.machine?.reportedCpuMHz??'未知'} MHz · 空闲内存 ${gib(calibration.machine?.freeMemoryBytes)} GiB · 工作区可用 ${gib(calibration.machine?.diskAvailableBytes)} GiB · 电源模式 ${calibration.machine?.powerMode??'不可用'}`
    :'控制器校准：不可用；正式跨轮比较需要完整校准证据。';
  const statusOptions=Object.keys(counts).sort().map(key=>`<option>${key}</option>`).join('');
  const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GIM Benchmark 批量报告</title>
<style>body{font:14px system-ui,sans-serif;background:#101923;color:#e3edf7;margin:28px}h1{font-size:26px}a{color:#80bdff}header{display:flex;gap:24px;align-items:baseline;flex-wrap:wrap}.cards{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}.card{padding:12px 18px;background:#1d2d3e;border-radius:8px}.note{color:#aebfd0;line-height:1.6}.scroll{overflow:auto;border:1px solid #32455b}table{border-collapse:collapse;min-width:1350px;width:100%;font-size:13px}th,td{padding:10px;text-align:left;border-bottom:1px solid #304055}th{background:#203347;cursor:pointer;white-space:nowrap}td{max-width:360px;overflow-wrap:anywhere}tr:nth-child(even){background:#162332}.PASS{color:#77e6b5}.PARTIAL{color:#ffd587}.FAIL,.ERROR,.INPUT_ERROR{color:#ff9e9e}.INCONCLUSIVE,.SKIPPED,.CANCELLED{color:#ffd587}input,select{font:inherit;padding:9px;background:#1d2d3e;color:#fff;border:1px solid #536b84;border-radius:4px;margin:8px}.tabs{display:flex;gap:8px;margin:22px 0 12px;border-bottom:1px solid #405268}.tabs button{font:inherit;color:#b8c9da;background:transparent;border:0;border-bottom:3px solid transparent;padding:10px 16px;cursor:pointer}.tabs button[aria-selected="true"]{color:#fff;border-bottom-color:#4a9dff}.tabs button:focus-visible{outline:2px solid #80bdff;outline-offset:2px}[hidden]{display:none!important}footer{margin-top:24px}</style>
<header><h1>GIM Benchmark</h1><strong>${escapeHtml(state.status)} · ${escapeHtml(state.outcome)}</strong></header>
${progress?`<p class="note" id="progress">已结束 ${progress.completed} / ${progress.total} 项，运行中 ${progress.running} 项，待执行 ${progress.pending} 项。下表保留已完成结果，刷新查看最近检查点。检查点不是控制器仍存活的证明。<br>CSV 和诊断表在结束或恢复后统一导出；如果控制器已退出，在 desktop/ 中执行 <code>npm run bench -- recover-batch --output &lt;本报告目录&gt;</code>。未完成项不会计为通过。<br><a href="status.json">进度 JSON</a> · <a href="profile.json">冻结计划</a></p>`:''}
<p class="note">${state.anonymize?'匿名：本次导出别名':'实名：文件名'} · ${escapeHtml(state.preset)} · ${state.repetitions} 轮 · ${escapeHtml(state.updatedAt)}<br>构建 ${escapeHtml(buildLabel(state))}<br>源码指纹 ${escapeHtml(state.buildFingerprint)} · 可执行文件 ${escapeHtml(state.buildInfo?.executableSha256??'未记录')} · 固定运行时 ${escapeHtml(state.buildInfo?.runtimeSha256??'未记录')} · Profile ${escapeHtml(state.profileDigest)}</p>
<p class="note">${escapeHtml(calibrationNote)}</p>
<div class="cards">${Object.entries(counts).map(([key,value])=>`<div class="card ${key}">${key}<b>${value}</b></div>`).join('')}</div>
<p class="note">每行是一个输入的一次运行。失败、缺失、重复及未完成项全部保留；单个失败不会终止其他输入。自动表示是产品表示终态，缓存发布是实际提交时刻，完全结算是任务/缓存/后台均结束且静默窗口完成；写排水只量最后一笔 DEV 产物写晚于自动表示的部分，不代表全部写入耗时。时间单位为秒，Private Bytes 为原生进程树观测峰值 GiB。空值表示未取得。阶段 wall time 不是 CPU time；Worker 堆不是 OS 内存。汇总中位数只使用相同覆盖状态的 PASS 或 PARTIAL 轮次，必须结合各状态轮数阅读。</p>
<div class="tabs" role="tablist" aria-label="报告视图"><button id="tab-results" type="button" role="tab" aria-controls="panel-results" aria-selected="true" tabindex="0">测量结果</button><button id="tab-coverage" type="button" role="tab" aria-controls="panel-coverage" aria-selected="false" tabindex="-1">样本覆盖</button></div>
<section id="panel-coverage" role="tabpanel" aria-labelledby="tab-coverage" hidden><div class="scroll"><table><thead><tr>${['样本','缓存','有效 / 计划','覆盖组','PARTIAL 签名','基础设施重试','PASS','PARTIAL','INCONCLUSIVE','跳过','模型树中位 s','基础几何中位 s','自动表示中位 s','缓存发布中位 s','完全结算中位 s'].map(v=>`<th scope="col">${v}</th>`).join('')}</tr></thead><tbody>${summaryRows}</tbody></table></div></section>
<section id="panel-results" role="tabpanel" aria-labelledby="tab-results">
${progress?'':`<p><a href="results.csv">全部结果 CSV</a> · <a href="errors.csv">错误 CSV</a> · <a href="summary.csv">汇总 CSV</a> · <a href="stages.csv">阶段 CSV</a> · <a href="slow-tasks.csv">慢任务 CSV</a> · <a href="slow-phases.csv">慢阶段 CSV</a> · <a href="slow-templates.csv">慢模板 CSV</a> · <a href="workers.csv">Worker CSV</a> · <a href="results.json">JSON</a></p>`}
<label>筛选 <input id="search" placeholder="文件名 / SHA256 / 错误码"></label><label>状态 <select id="status"><option value="">全部</option>${statusOptions}</select></label><span id="visible"></span>
<div class="scroll"><table id="results"><thead><tr>${['输入','构建 / 源码','运行标识',state.anonymize?'样本别名':'文件名','层级','组','轮次','缓存','结果','尝试','导航响应 s','模型树就绪 s','几何提交 s','首次几何 s（按计时口径）','基础几何齐备 s','自动表示 s','缓存发布 s','完全结算 s','DEV 写排水 s','Private 峰值 GiB','DEV 写入 MiB','DEV 写服务 ms/MiB','内存证据','实际类型','输入变体','缓存发布','来源覆盖','DEV 内容覆盖','明细丢失','任务生命周期','发布状态','pack 状态','错误 / 不完整原因'].map(v=>`<th scope="col">${v}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></section>
<footer class="note">${state.baselineEligible?'冷暖证据已齐备；PARTIAL 仅在显式接受来源缺陷后才能成为部分基线。':'此报告尚不是认可基线；一轮摸底、未执行项、失败或不完整测量不能作为基线通过。'}<br>${state.anonymize?'此报告已隐藏源路径与文件名。':'此报告包含源文件名，分享前请确认资料权属。'}原始日志、授权清单、profile 和堆快照仅保存在工作区私有运行目录。运行期间更新结果表与覆盖汇总；完整 CSV、诊断表及结果 JSON 在结束或恢复后生成。</footer>
<script>const tabs=[...document.querySelectorAll('[role="tab"]')];function selectTab(tab){for(const item of tabs){const active=item===tab;item.setAttribute('aria-selected',String(active));item.tabIndex=active?0:-1;document.getElementById(item.getAttribute('aria-controls')).hidden=!active}}for(const tab of tabs){tab.onclick=()=>selectTab(tab);tab.onkeydown=event=>{if(event.key!=='ArrowLeft'&&event.key!=='ArrowRight')return;event.preventDefault();const next=tabs[(tabs.indexOf(tab)+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length];selectTab(next);next.focus()}}const table=document.querySelector('#results'),body=table.tBodies[0],search=document.querySelector('#search'),status=document.querySelector('#status');function filter(){let n=0;for(const row of body.rows){const show=(!status.value||row.dataset.status===status.value)&&row.textContent.toLowerCase().includes(search.value.toLowerCase());row.hidden=!show;if(show)n++}document.querySelector('#visible').textContent=n+' 行'}search.oninput=status.onchange=filter;table.querySelectorAll('th').forEach((th,index)=>{let ascending=true;th.onclick=()=>{const rows=[...body.rows];rows.sort((a,b)=>{const x=a.cells[index].textContent,y=b.cells[index].textContent;return (ascending?1:-1)*(x!==''&&y!==''&&Number.isFinite(+x)&&Number.isFinite(+y)?+x-+y:x.localeCompare(y))});rows.forEach(row=>body.append(row));ascending=!ascending}});filter();</script></html>`;
  return html;
}
