/** Require both runtime suspend evidence and a prolonged controller observation gap. */
export function confirmedEnvironmentSuspend(reason,log,gapMs){
  return reason==='renderer-process-exited'&&gapMs>=60000&&
    typeof log==='string'&&log.includes('OnScreenLocked')&&log.includes('OnSuspend');
}
