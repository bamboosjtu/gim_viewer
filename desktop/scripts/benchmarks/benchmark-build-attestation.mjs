import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';

const PROBE_CHUNK=/^benchmarkHost-[\w-]+\.js$/;

/** The frontend and the embedded executable must both carry the benchmark-only host. */
export function assertBenchmarkFrontend(dist){
  const assets=join(dist,'assets');
  const chunks=readdirSync(assets).filter(name=>PROBE_CHUNK.test(name));
  if(chunks.length!==1||!readFileSync(join(assets,chunks[0]),'utf8').includes('__gimBenchmark'))
    throw Error('benchmark-frontend-probe-missing');
  return chunks[0];
}

export function assertBenchmarkExecutable(executable,chunkName){
  if(!PROBE_CHUNK.test(chunkName)||!readFileSync(executable).includes(Buffer.from(chunkName)))
    throw Error('benchmark-executable-probe-missing');
}
