/** Warm runs require an actual published cache, independent of cold measurement completeness. */
export function warmPreparation(cold){
  if(!cold)return {ready:false,reason:'warm-preparation-incomplete'};
  if(cold.cacheFailureCode==='CACHE_NOT_PERSISTABLE')
    return {ready:false,reason:'WARM_UNSUPPORTED:CACHE_NOT_PERSISTABLE'};
  if(cold.inputIntegrity==='corrupt')return {ready:false,reason:'WARM_UNSUPPORTED:INPUT_CORRUPT'};
  if(cold.environmentSuspend?.code==='INFRA_SUSPEND')
    return {ready:false,reason:'cold-infrastructure-suspended'};
  if(!['passed','partial'].includes(cold.correctness)||cold.reason||cold.crashed||
    cold.cacheFailureCount>0||cold.cachePublished!==true)
    return {ready:false,reason:'warm-preparation-incomplete'};
  return {ready:true,reason:null};
}
