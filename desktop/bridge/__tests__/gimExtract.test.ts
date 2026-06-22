/**
 * parseExtractionPayload 单测（acc-plan P0-2）。
 *
 * 构造与 Rust extract_gim_archive 输出同构的二进制 payload，
 * 验证 manifest 解析、blob 切分、越界校验。
 */

import { describe, expect, it } from 'vitest';
import { parseExtractionPayload } from '../gimExtract.js';

function buildPayload(
  entries: Array<{ path: string; data: string }>,
  magic = 'GIMPKGT',
  projectName?: string,
): ArrayBuffer {
  const enc = new TextEncoder();
  const blobs: Uint8Array[] = [];
  const metas: Array<{ path: string; offset: number; size: number }> = [];
  let offset = 0;
  for (const e of entries) {
    const bytes = enc.encode(e.data);
    blobs.push(bytes);
    metas.push({ path: e.path, offset, size: bytes.length });
    offset += bytes.length;
  }
  const blobLen = blobs.reduce((a, b) => a + b.length, 0);
  const manifest = {
    magic,
    project_name: projectName,
    entries: metas,
  };
  const manifestBytes = enc.encode(JSON.stringify(manifest));

  const out = new Uint8Array(4 + manifestBytes.length + blobLen);
  new DataView(out.buffer).setUint32(0, manifestBytes.length, true);
  out.set(manifestBytes, 4);
  let pos = 4 + manifestBytes.length;
  for (const b of blobs) {
    out.set(b, pos);
    pos += b.length;
  }
  return out.buffer;
}

describe('parseExtractionPayload', () => {
  it('解析 manifest 与条目数据', () => {
    const buf = buildPayload(
      [
        { path: 'CBM/project.cbm', data: 'TYPE=TS\n' },
        { path: 'Dev/x.ifc', data: 'ISO-10303-21;' },
      ],
      'GIMPKGS',
      '变电站01',
    );
    const result = parseExtractionPayload(buf);
    expect(result.magic).toBe('GIMPKGS');
    expect(result.projectName).toBe('变电站01');
    expect(result.files.size).toBe(2);

    const cbm = result.files.get('CBM/project.cbm')!;
    expect(cbm.size).toBe(8);
  });

  it('条目内容字节完整（含二进制安全边界）', async () => {
    const buf = buildPayload([{ path: 'Mod/a.mod', data: '你好GIM' }]);
    const { files } = parseExtractionPayload(buf);
    const text = await files.get('Mod/a.mod')!.text();
    expect(text).toBe('你好GIM');
  });

  it('manifest 长度越界时抛错', () => {
    const buf = buildPayload([{ path: 'a.txt', data: 'x' }]);
    const dv = new DataView(buf);
    dv.setUint32(0, 999999, true); // 篡改长度
    expect(() => parseExtractionPayload(buf)).toThrow(/越界|过短/);
  });

  it('payload 过短时抛错', () => {
    expect(() => parseExtractionPayload(new ArrayBuffer(4))).toThrow();
  });

  it('拒绝 manifest 中的非法 GIM 魔数', () => {
    const buf = buildPayload([{ path: 'CBM/project.cbm', data: 'x' }], 'NOT-GIM');
    expect(() => parseExtractionPayload(buf)).toThrow(/魔数无效/);
  });

  it('拒绝 manifest 中的点路径组件', () => {
    const buf = buildPayload([{ path: 'CBM/./project.cbm', data: 'x' }]);
    expect(() => parseExtractionPayload(buf)).toThrow(/路径不安全/);
  });

  it('按 UTF-8 字节数限制 manifest 路径长度', () => {
    const longName = '中'.repeat(2048);
    const buf = buildPayload([{ path: `MOD/${longName}.mod`, data: 'x' }]);
    expect(() => parseExtractionPayload(buf)).toThrow(/路径不安全/);
  });
});
