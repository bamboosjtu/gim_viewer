const zipPrefixes=new Set(['504b0304','504b0506','504b0708']);
export function bareContainerKind(bytes){
  if(bytes.subarray(0,6).equals(Buffer.from([0x37,0x7a,0xbc,0xaf,0x27,0x1c])))return '7z';
  return zipPrefixes.has(bytes.subarray(0,4).toString('hex'))?'zip':null;
}
