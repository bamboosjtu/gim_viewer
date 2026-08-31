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
  it('磁盘优先 manifest 不创建内联 blob，条目按需读取', () => {
    const enc = new TextEncoder();
    const manifest = enc.encode(JSON.stringify({
      magic: 'GIMPKGS',
      project_id: 'header-project',
      entries: [{ path: 'DEV/model.ifc', offset: 0, size: 123, cache_path: 'C:/cache/model.ifc' }],
    }));
    const out = new Uint8Array(4 + manifest.length);
    new DataView(out.buffer).setUint32(0, manifest.length, true);
    out.set(manifest, 4);

    const result = parseExtractionPayload(out.buffer, { cacheProjectId: 7 });
    const file = result.files.get('DEV/model.ifc')!;
    expect(result.cacheProjectId).toBe(7);
    expect(file.size).toBe(123);
    expect(result.cachePaths.get('DEV/model.ifc')).toBe('C:/cache/model.ifc');
  });

  it('延迟 File 的 slice 遵循 Blob 边界语义', async () => {
    const enc = new TextEncoder();
    const manifest = enc.encode(JSON.stringify({
      magic: 'GIMPKGT',
      entries: [{ path: 'CBM/entry.txt', offset: 0, size: 8, cache_path: 'C:/cache/entry.txt' }],
    }));
    const out = new Uint8Array(4 + manifest.length);
    new DataView(out.buffer).setUint32(0, manifest.length, true);
    out.set(manifest, 4);

    const file = parseExtractionPayload(out.buffer, { cacheProjectId: 7 }).files.get('CBM/entry.txt')!;
    const reverse = file.slice(6, 2);
    expect(reverse.size).toBe(0);
    await expect(reverse.text()).resolves.toBe('');
  });

  it('无 project_id 的零字节兼容 payload 仍返回普通空 File', async () => {
    const enc = new TextEncoder();
    const manifest = enc.encode(JSON.stringify({
      magic: 'GIMPKGT',
      entries: [{ path: 'CBM/empty.cbm', offset: 0, size: 0 }],
    }));
    const out = new Uint8Array(4 + manifest.length);
    new DataView(out.buffer).setUint32(0, manifest.length, true);
    out.set(manifest, 4);

    const file = parseExtractionPayload(out.buffer).files.get('CBM/empty.cbm')!;
    expect(file.size).toBe(0);
    await expect(file.text()).resolves.toBe('');
  });

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
