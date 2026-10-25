import { expect, it, vi } from 'vitest';
import { packDevArtifact, prepareDevArtifact, writeDevArtifactDetailed, readDevArtifactBatch, unpackDevArtifact } from '../devLodCache.js';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@desktop/invokeTimed.js', () => ({ invokeTimed: invoke }));

function envelope(items: { path: string; bytes: Uint8Array | null }[]): ArrayBuffer {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const header = new Uint8Array(9);
  header.set(encoder.encode('GIMR'), 0); header[4] = 1;
  new DataView(header.buffer).setUint32(5, items.length, true);
  chunks.push(header);
  for (const item of items) {
    const path = encoder.encode(item.path);
    const prefix = new Uint8Array(4 + path.length + 1 + 8);
    const view = new DataView(prefix.buffer);
    view.setUint32(0, path.length, true); prefix.set(path, 4);
    prefix[4 + path.length] = item.bytes ? 1 : 0;
    view.setBigUint64(5 + path.length, BigInt(item.bytes?.length ?? 0), true);
    chunks.push(prefix);
    if (item.bytes) chunks.push(item.bytes);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out.buffer;
}

it('isolates a corrupt row from a valid row and retries a failed batch by splitting', async () => {
  (window as any).__TAURI_INTERNALS__ = {};
  const badKey = 'templates/bad';
  const good = new Uint8Array(packDevArtifact('good', { result: { status: 'complete', bytes: new Uint8Array([7, 8, 9]) } }));
  invoke.mockImplementation(async (_command: string, args: { entryPaths: string[] }) => {
    if (args.entryPaths.length > 1) throw Error('transport failed');
    const path = args.entryPaths[0];
    if (path === badKey) return envelope([{ path, bytes: new Uint8Array([1, 2, 3]) }]);
    return envelope([{ path, bytes: good }]);
  });
  const result = await readDevArtifactBatch<any>('templates', ['good', 'bad'], {
    projectId: 1, sourceSha256: 'a'.repeat(64),
  });
  expect(result.get('good')).toMatchObject({ status: 'hit' });
  expect(result.get('good')!.value.result.bytes).toEqual(new Uint8Array([7, 8, 9]));
  expect(result.get('bad')).toMatchObject({ status: 'invalid' });
  expect(invoke.mock.calls.map((call) => call[1].entryPaths.length)).toEqual([2, 1, 1]);
  delete (window as any).__TAURI_INTERNALS__;
});

it('retains binary template bytes and rejects mismatched or truncated cache records', () => {
  const source = new Uint8Array([1, 2, 3, 4]);
  const packed = packDevArtifact('key', { sha: 'test', result: { status: 'complete', bytes: source } });
  const restored = unpackDevArtifact<any>('key', packed);
  expect(restored.result.bytes).toEqual(source); restored.result.bytes[0] = 99;
  expect(source[0]).toBe(1);
  expect(() => unpackDevArtifact('other', packed)).toThrow('key mismatch');
  expect(() => unpackDevArtifact('key', packed.subarray(0, 5))).toThrow('metadata invalid');
  expect(unpackDevArtifact('missing', new Uint8Array())).toBeNull();
});

it('native batch decoding gives each GLB independent ownership without retaining the response or adjacent records', async () => {
  (window as any).__TAURI_INTERNALS__ = {};
  const response = envelope(['a', 'b'].map((key, i) => ({ path: `templates/${key}`,
    bytes: packDevArtifact(key, { result: { bytes: new Uint8Array([i + 1, 7, 9]) } }),
  })));
  invoke.mockReset(); invoke.mockResolvedValue(response);
  try {
    const values = await readDevArtifactBatch<any>('templates', ['a', 'b'], {
      projectId: 1, sourceSha256: 'a'.repeat(64),
    });
    const a = values.get('a')!.value.result.bytes as Uint8Array;
    const b = values.get('b')!.value.result.bytes as Uint8Array;
    expect(a.buffer).not.toBe(response); expect(b.buffer).not.toBe(response);
    expect(a.buffer).not.toBe(b.buffer);
    expect(a.byteOffset).toBe(0); expect(a.buffer.byteLength).toBe(a.byteLength);
    new Uint8Array(response).fill(0);
    expect(a).toEqual(new Uint8Array([1, 7, 9]));
    a[0] = 99; expect(b).toEqual(new Uint8Array([2, 7, 9]));
  } finally { delete (window as any).__TAURI_INTERNALS__; }
});

it('prepares metadata once, retains the original binary buffer and refuses a different write key', async () => {
  let reads=0;const data=new Uint8Array([4,5,6]);
  const value={get label(){reads++;return 'source';},result:{status:'complete',bytes:data}};
  const prepared=prepareDevArtifact('key',value);
  expect(prepared.data).toBe(data);expect(reads).toBe(1);
  expect(prepared.retainedBytes).toBe(prepared.metadata.byteLength+data.byteLength);
  expect(JSON.parse(new TextDecoder().decode(prepared.metadata))).toMatchObject({key:'key',value:{label:'source',result:{bytes:null}}});
  (window as any).__TAURI_INTERNALS__={};invoke.mockReset();invoke.mockResolvedValue(undefined);
  try {
    expect(await writeDevArtifactDetailed('templates','key',value,{projectId:1,sourceSha256:'a'.repeat(64)},prepared)).toEqual({ok:true});
    expect(reads).toBe(1);expect(invoke).toHaveBeenCalledOnce();
    expect(await writeDevArtifactDetailed('templates','other',value,undefined,prepared)).toMatchObject({ok:false});
    expect(invoke).toHaveBeenCalledOnce();
  } finally {delete (window as any).__TAURI_INTERNALS__;}
});

it('rejects oversized metadata before it can enter the writer queue', () => {
  expect(()=>prepareDevArtifact('key',{detail:'x'.repeat(1024*1024)})).toThrow('metadata exceeds');
});

it('does not reopen unavailable IndexedDB for every device read and write', async () => {
  vi.resetModules();
  const open = vi.fn(() => {
    const request: any = { error: Error('storage unavailable') };
    queueMicrotask(() => request.onerror()); return request;
  });
  vi.stubGlobal('indexedDB', { open });
  try {
    const module = await import('../devLodCache.js');
    expect(await module.readDevArtifact('catalog', 'one')).toBeNull();
    expect(await module.readDevArtifact('catalog', 'two')).toBeNull();
    expect(await module.writeDevArtifact('templates', 'three', {})).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});

it('an aborted delete transaction settles so a corrupt template can be rebuilt', async () => {
  vi.resetModules();
  const tx: any = { objectStore: () => ({ delete: () => queueMicrotask(() => tx.onabort()) }), error: Error('aborted') };
  vi.stubGlobal('indexedDB', { open: () => { const request: any = { result: { transaction: () => tx } }; queueMicrotask(() => request.onsuccess()); return request; } });
  try { const { deleteDevArtifact } = await import('../devLodCache.js'); await expect(deleteDevArtifact('templates', 'bad')).resolves.toBeUndefined(); }
  finally { vi.unstubAllGlobals(); }
});
