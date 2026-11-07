const startupReasons=new Set([
  'native-cdp-unavailable','native-startup-failed','webview-gpu-process-launch-failed','benchmark-api-unavailable',
]);

export function isStartupInfrastructureFailure(report){
  return report?.openAttempted===false&&startupReasons.has(report.reason)&&report.evidence==null;
}

export const STARTUP_ATTEMPTS=3;
export const startupRetryDelayMs=attempt=>Math.min(500*2**(attempt-1),2000);
