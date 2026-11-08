export function nativeExitCode(command,outcome){
  if(command==='run')return ['PASS','PARTIAL'].includes(outcome)?0:outcome==='FAIL'?1:2;
  return outcome==='PASS'?0:2;
}
