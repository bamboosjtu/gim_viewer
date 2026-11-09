import {createHash} from 'node:crypto';

export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const sha=value=>/^[a-f0-9]{64}$/.test(value??'');
export const reviewerValid=value=>typeof value==='string'&&value.trim().length>=2&&value.trim().length<=64&&
  !/[\\/:\r\n]|\.gim\b/i.test(value);
export function candidateDigest(suite){
  const {approval,measurementAcceptance,...candidate}=suite;
  return digest(candidate);
}
