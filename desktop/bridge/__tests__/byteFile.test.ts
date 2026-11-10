import{it,expect}from'vitest';
import{createByteFile,isByteFile,copyByteFileBytes}from'../byteFile.js';
it('keeps metadata and exact view boundaries with independent reads and transfers',async()=>{
  const packed=new Uint8Array([99,65,66,67,88]),file=createByteFile(packed.subarray(1,4),'a.cbm',{lastModified:7,type:'text/plain'});
  expect(file.name).toBe('a.cbm');expect(file.size).toBe(3);expect(file.lastModified).toBe(7);expect(file.type).toBe('text/plain');expect(isByteFile(file)).toBe(true);
  expect(await file.text()).toBe('ABC');const read=await file.arrayBuffer();new Uint8Array(read)[0]=0;expect(await file.text()).toBe('ABC');
  const transfer=copyByteFileBytes(file)!;expect(transfer.byteOffset).toBe(0);transfer[0]=0;expect(await file.text()).toBe('ABC');
  const bytes=copyByteFileBytes(file)!;structuredClone(bytes,{transfer:[bytes.buffer]});expect(bytes.byteLength).toBe(0);expect(await file.text()).toBe('ABC');
  expect(await file.slice(-2).text()).toBe('BC');expect(await file.slice(2,1).text()).toBe('');expect(await file.slice(0,99).text()).toBe('ABC');
  expect(isByteFile({})).toBe(false);expect(copyByteFileBytes({})).toBeUndefined();
  expect(isByteFile(new Proxy(file,{}))).toBe(false);
});
it('preserves empty, binary and non-UTF8 bytes without routing through text',async()=>{
  const file=createByteFile(new Uint8Array([0xff,0x00,0x81]),'a.fam');expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([255,0,129]);
  expect((await file.stream().getReader().read()).value).toEqual(new Uint8Array([255,0,129]));
  const empty=createByteFile(new Uint8Array(),'empty.dev');expect(await empty.text()).toBe('');expect((await empty.arrayBuffer()).byteLength).toBe(0);
});
