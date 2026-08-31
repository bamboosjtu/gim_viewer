import { describe, expect, it } from 'vitest';
import { createIfcModelId, normalizeEntryPath, resolveIfcModelId } from '../modelIdentity.js';
import { resolveIfcPath, scanIfcFiles } from '../gimIndexer.js';

function files(entries: Record<string, string>): Map<string, File> {
  return new Map(Object.entries(entries).map(([path, text]) => [path, new File([text], path.split('/').pop() || path)]));
}

describe('IFC model identity', () => {
  it('同一路径跨平台写法生成同一稳定 ID，不同路径生成不同 ID', () => {
    expect(normalizeEntryPath('./DEV\\A\\foo.ifc')).toBe('dev/a/foo.ifc');
    expect(createIfcModelId('./DEV\\A\\foo.ifc')).toBe(createIfcModelId('dev/a/foo.ifc'));
    expect(createIfcModelId('DEV/A/foo.ifc')).not.toBe(createIfcModelId('DEV/B/foo.ifc'));
  });

  it('重复 basename 不静默选择第一个', () => {
    const map = files({ 'DEV/A/foo.ifc': 'a', 'DEV/B/foo.ifc': 'b' });
    expect(resolveIfcPath(map, 'foo.ifc')).toEqual({
      kind: 'ambiguous',
      candidates: ['DEV/A/foo.ifc', 'DEV/B/foo.ifc'],
    });
    const entries = scanIfcFiles(map);
    expect(entries).toHaveLength(2);
    expect(entries[0].modelId).not.toBe(entries[1].modelId);
    expect(resolveIfcModelId('foo.ifc', entries)).toBeNull();
  });

  it('保留 Windows 反斜杠 Map 键，解析结果仍可直接读取文件', () => {
    const map = files({ 'DEV\\A\\Switch.IFC': 'ifc' });
    expect(resolveIfcPath(map, 'switch.ifc')).toEqual({
      kind: 'resolved',
      path: 'DEV\\A\\Switch.IFC',
    });
    const entries = scanIfcFiles(map);
    expect(entries[0]).toMatchObject({
      name: 'Switch',
      path: 'DEV\\A\\Switch.IFC',
    });
    expect(map.get(entries[0].path)).toBeDefined();
  });
});
