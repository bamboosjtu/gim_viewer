import {createHash,randomBytes} from 'node:crypto';
import {cpus,freemem,totalmem,platform,release,arch} from 'node:os';
import {mkdirSync,openSync,writeSync,fsyncSync,closeSync,readFileSync,unlinkSync,statfsSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {median} from './statistics.mjs';

/** Controller diagnostics only; not a multiplier for product wall times. */
export function calibrateBatch(root){
  const directory=join(root,'tmp','gim-bench','calibration');
  mkdirSync(directory,{recursive:true});
  const bytes=Buffer.alloc(8*1024*1024);
  for(let i=0;i<bytes.length;i++)bytes[i]=(i*17+(i>>>8))&255;
  const cpuStarted=performance.now();
  let checksum='';
  for(let i=0;i<32;i++)checksum=createHash('sha256').update(bytes).digest('hex');
  const cpuMs=performance.now()-cpuStarted;
  const writes=[],reads=[];
  for(let round=0;round<3;round++){
    const file=join(directory,`calibration-${randomBytes(8).toString('hex')}.private.bin`);
    try{
      const fd=openSync(file,'wx');
      try{const started=performance.now();let offset=0;
        while(offset<bytes.length)offset+=writeSync(fd,bytes,offset,bytes.length-offset);
        fsyncSync(fd);writes.push(performance.now()-started);
      }finally{closeSync(fd);}
      const started=performance.now(),read=readFileSync(file);
      reads.push(performance.now()-started);
      if(!read.equals(bytes))throw Error('Calibration readback mismatch');
    }finally{try{unlinkSync(file);}catch{/* Keep failure evidence private. */}}
  }
  const writeSyncMs=median(writes),readWarmMs=median(reads);
  const cpu=cpus()[0];
  let diskAvailableBytes=null;
  try{const stat=statfsSync(directory);diskAvailableBytes=stat.bavail*stat.bsize;}catch{/* Unsupported filesystem metric. */}
  return {version:'gim-batch-calibration-v1',method:'controller-sha256-256MiB-and-workspace-8MiB-sync-write-warm-read-median3',
    cpuMs,writeSyncMs,readWarmMs,checksum,
    machine:{cpuModel:cpu?.model??null,reportedCpuMHz:cpu?.speed??null,logicalCores:cpus().length,
      totalMemoryBytes:totalmem(),freeMemoryBytes:freemem(),diskAvailableBytes,
      platform:platform(),osRelease:release(),arch:arch(),powerMode:'unavailable'}};
}
