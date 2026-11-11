/** One producer, two independently observed boundaries. Persistence is owned
 * by the background coordinator, while entities need only the live index. */
export function createSpatialSemanticStarter(work:(ready:(available:boolean)=>void)=>Promise<boolean>){
  let resolve!:(available:boolean)=>void,completed:Promise<boolean>|undefined;
  const ready=new Promise<boolean>(r=>{resolve=r;});
  const start=()=>{
    if(!completed){completed=Promise.resolve().then(()=>work(resolve));completed.then(resolve,()=>resolve(false));}
    return completed;
  };
  return{ready:()=>{start().catch(()=>{});return ready;},complete:start};
}
