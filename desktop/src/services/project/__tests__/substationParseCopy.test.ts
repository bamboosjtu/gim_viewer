import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { decodeSubstationParseCopy } from '@desktop/substationParseCopy.js';
vi.stubGlobal('crypto', { subtle: { digest: (algorithm: string, data: ArrayBuffer) => webcrypto.subtle.digest(algorithm, Buffer.from(new Uint8Array(data))) } });

async function fixture(rows: { path: string; value: string }[]) {
  let offset = 0;
  const entries = rows.map(r => { const size = new TextEncoder().encode(r.value).length; const e = { path: r.path, offset, size }; offset += size; return e; });
  const json = new TextEncoder().encode(JSON.stringify(entries));
  const bytes = new Uint8Array(4 + json.length + offset);
  new DataView(bytes.buffer).setUint32(0, json.length, true); bytes.set(json, 4);
  for (let i = 0; i < rows.length; i++) bytes.set(new TextEncoder().encode(rows[i].value), 4 + json.length + entries[i].offset);
  const sha256 = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
  return { buffer: bytes.buffer, receipt: { size: bytes.length, sha256 },
    files: new Map(rows.map(r => [r.path, new File([r.value], r.path)])) };
}
describe('substation cold parse acceleration copy', () => {
  it('preserves empty files, duplicate FAM lines, CRLF and source bytes', async () => {
    const rows = [{ path: 'CBM/project.cbm', value: 'A=1\r\n' }, { path: 'DEV/a.fam', value: '[设计参数]\r\n材质=材质=铝\r\n材质=材质=制造厂家提供\r\n' }, { path: 'DEV/empty.fam', value: '' }];
    const f = await fixture(rows), result = await decodeSubstationParseCopy(f.buffer, f.receipt, f.files);
    for (const row of rows) expect(new TextDecoder().decode(result.get(row.path))).toBe(row.value);
  });
  it('rejects modified/truncated acceleration copies', async () => {
    const f = await fixture([{ path: 'DEV/a.dev', value: 'A=1' }]);
    await expect(decodeSubstationParseCopy(f.buffer.slice(0, -1), f.receipt, f.files)).rejects.toThrow('size');
    new Uint8Array(f.buffer)[f.buffer.byteLength - 1] ^= 1;
    await expect(decodeSubstationParseCopy(f.buffer, f.receipt, f.files)).rejects.toThrow('identity');
  });
  it('rejects foreign paths, file size mismatch, IFC and duplicate entries', async () => {
    const f = await fixture([{ path: 'DEV/a.dev', value: 'A' }]);
    await expect(decodeSubstationParseCopy(f.buffer, f.receipt, new Map())).rejects.toThrow('entry');
    await expect(decodeSubstationParseCopy(f.buffer, f.receipt, new Map([['DEV/a.dev', new File(['AA'], 'a')]]))).rejects.toThrow('entry');
    for (const rows of [[{ path: 'CBM/a.ifc', value: 'IFC' }], [{ path: 'DEV/a.dev', value: 'A' }, { path: 'DEV/a.dev', value: 'A' }]]) {
      const invalid = await fixture(rows);
      await expect(decodeSubstationParseCopy(invalid.buffer, invalid.receipt, invalid.files)).rejects.toThrow('entry');
    }
  });
});
