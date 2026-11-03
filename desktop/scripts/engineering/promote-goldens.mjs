import {readFileSync,writeFileSync,mkdirSync,createReadStream,createWriteStream,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createGunzip,createBrotliCompress,constants} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import {engineeringFingerprint} from './fingerprint.mjs';

if(!process.argv.includes('--accept'))throw Error('Inspect candidate snapshots and explicit source-case results before using --accept');
const root=resolve('../output/engineering-stage3'),candidates=join(root,'candidates'),staging=join(root,'promoted'),target=resolve('acceptance/engineering/goldens');
const corpus=JSON.parse(readFileSync('acceptance/engineering/corpus.json','utf8')),fingerprint=engineeringFingerprint();
mkdirSync(staging,{recursive:true});mkdirSync(target,{recursive:true});
const metadata=[];
for(const sample of corpus.samples){
 const meta=JSON.parse(readFileSync(join(candidates,`${sample.id}.json`),'utf8'));
 const result=JSON.parse(readFileSync(join(root,`${sample.id}-result.json`),'utf8'));
 if(!result.passed||meta.sourceSha256!==sample.sha256||meta.implementationSha256!==fingerprint.implementationSha256)throw Error(`Stale/unverified candidate ${sample.id}`);
 const digest=createHash('sha256'),reader=createReadStream(join(candidates,`${sample.id}.jsonl.gz`)).pipe(createGunzip());reader.on('data',chunk=>digest.update(chunk));
 await pipeline(reader,createBrotliCompress({params:{[constants.BROTLI_PARAM_QUALITY]:6}}),createWriteStream(join(staging,`${sample.id}.jsonl.br`)));
 if(digest.digest('hex')!==meta.sha256)throw Error(`Candidate body checksum mismatch ${sample.id}`);
 metadata.push({id:sample.id,...meta});console.log(`${sample.id}: candidate integrity and source-case checks verified`);
}
for(const meta of metadata){copyFileSync(join(staging,`${meta.id}.jsonl.br`),join(target,`${meta.id}.jsonl.br`));writeFileSync(join(target,`${meta.id}.json`),JSON.stringify(meta,null,2)+'\n');}
writeFileSync(join(target,'manifest.json'),JSON.stringify({format:'engineering-jsonl-brotli-v1',...fingerprint,samples:metadata.map(m=>({id:m.id,sourceSha256:m.sourceSha256,sha256:m.sha256,counts:m.counts})),reviewBasis:'Pinned raw archives; complete source/partition/address checks; agreed fixed source cases and contract test matrix. Not a claim of independent manual per-instance truth.'},null,2)+'\n');
