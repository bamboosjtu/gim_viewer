/** Controlled technical codes only. Business strings remain private. */
export const HEAP_REASON_CODES=new Set(['missing','unavailable','worker-heap-sampling-gap','runtime-timeout-or-unsupported',
  'runtime-timeout','runtime-command-rejected','runtime-request-outstanding','runtime-connection-closed','runtime-pending-limit','worker-identity-unavailable','isolate-identity-unavailable',
  'worker-target-not-observed','target-ended','previous-sample-pending','ended-before-heap-sample','never-executed','no-standalone-js-isolate']);
const messages={
  'worker-heap-sampling-gap':'堆采样覆盖间隔超限','runtime-timeout-or-unsupported':'CDP 堆采样超时或不可用',
  'runtime-timeout':'CDP 请求超时','runtime-command-rejected':'CDP 命令被拒绝','runtime-request-outstanding':'上次 CDP 请求尚未返回',
  'worker-identity-unavailable':'Worker 身份未能关联','isolate-identity-unavailable':'JS isolate 身份不可用','missing':'缺少堆样本',
  'worker-target-not-observed':'未观测到 Worker 调试目标','input-corrupt':'归档输入损坏','INPUT_CORRUPT':'归档输入损坏',
  'measurement-incomplete':'测量证据不完整','measurement-lifecycle-incomplete':'任务生命周期证据不完整',
  'product-geometry-failed':'产品几何失败','source-reference-unresolved':'来源引用未解析','ifc-manifest-incomplete':'IFC 来源覆盖不完整',
  'missing-dependency':'缺少来源依赖','source-invalid':'来源几何无效','capacity-exceeded':'表示容量超限','parse-failed':'解析/编译失败',
  'unverified-reason-omitted':'其他未验证文本已隐藏；请对照私有报告','unavailable':'采样不可用'};
export function controlledDiagnosticReason(value,alias,words){
  return [...new Set(String(value).split(';').filter(Boolean).map(token=>{
    const [scope,code,...identity]=token.split(':');
    if(scope==='worker-heap'&&HEAP_REASON_CODES.has(code)&&identity.length)
      return 'worker-heap:'+code+':'+alias(identity.join(':'));
    return token.split(':').every(word=>words.has(word)||/^\d+$/.test(word))?token:'unverified-reason-omitted';
  }))].join(';');
}
const tokens=value=>(Array.isArray(value)?value:[value]).filter(Boolean).flatMap(value=>String(value).split(';')).filter(Boolean);
const number=value=>Number.isFinite(value)?value.toFixed(1):null;
export function diagnosticLines(row,workers=[]){
  const lines=[],seen=new Set(),add=text=>{if(!seen.has(text)){seen.add(text);lines.push(text);}};
  const matching=workers.filter(worker=>worker.runId===row.runId),byId=new Map(matching.map(worker=>[worker.workerId,worker]));
  for(const token of new Set(['error','cacheFailureCode','startupFailures','failedGeometryReasons','memoryIncompleteItems',
    'measurementIncompleteItems','measurementLifecycleIssues','coverageIncompleteReasons','finalEvidenceIssue'].flatMap(key=>tokens(row[key])))){
    const [scope,code,...rest]=token.split(':');
    if(scope==='worker-heap'&&rest.length){
      const id=rest.join(':'),worker=byId.get(id),detail=[];
      if(number(worker?.maxSampleGapMs)!==null)detail.push('最大间隔 '+number(worker.maxSampleGapMs)+' ms');
      if(number(worker?.maxSampleDelayMs)!==null)detail.push('最大响应延迟 '+number(worker.maxSampleDelayMs)+' ms');
      if(Number.isFinite(worker?.failedHeapSamples))detail.push('失败样本 '+worker.failedHeapSamples);
      if(worker?.heapFailureMethod)detail.push('失败阶段 '+worker.heapFailureMethod);
      add((worker?.family??'Worker')+' / '+id+'：'+(messages[code]??code)+' ['+code+']'+(detail.length?'（'+detail.join('，')+'）':''));
    }else if(scope==='process-tree')add('进程树内存：'+[code,...rest].join(':'));
    else if(scope==='unverified-reason-omitted')add(messages[scope]);
    else add((messages[scope]?messages[scope]+' ['+scope+']':scope)+(code?':'+[code,...rest].join(':'):''));
  }
  if(row.unresolvedReferenceCount>0)add('未解析引用 '+row.unresolvedReferenceCount);
  if(row.status==='PARTIAL'&&!lines.length)add('来源/覆盖范围为 PARTIAL；需核对来源缺口'+(row.unresolvedReferenceCount?'（未解析引用 '+row.unresolvedReferenceCount+'）':''));
  if(row.memoryEvidenceComplete===false&&!tokens(row.memoryIncompleteItems).length)add('内存证据不完整；本记录未提供可定位的采样原因');
  return lines;
}
export function buildLabel(state){
  const commit=state.buildInfo?.commit,source=state.buildInfo?.sourceFingerprint??state.buildFingerprint;
  return (commit?commit.slice(0,8)+(state.buildInfo?.dirty?' + 工作区改动':''):'提交未记录')
    +' / 源码 '+(source??'指纹未记录').slice(0,12);
}
