import { describe, it, expect } from 'vitest';
import { normalizeEntityName } from '../entityName.js';

describe('normalizeEntityName（大小写三态实证，docs/schema/04）', () => {
  it('变电层级：F4SYSTEM / f4system → F4System', () => {
    expect(normalizeEntityName('F4SYSTEM')).toBe('F4System');
    expect(normalizeEntityName('f4system')).toBe('F4System');
    expect(normalizeEntityName('F4System')).toBe('F4System');
  });

  it('部件层：PartIndex / partindex → PARTINDEX', () => {
    expect(normalizeEntityName('PartIndex')).toBe('PARTINDEX');
    expect(normalizeEntityName('partindex')).toBe('PARTINDEX');
  });

  it('线路实体：WIRE_DEVICE → Wire_Device、TOWER_DEVICE → Tower_Device', () => {
    expect(normalizeEntityName('WIRE_DEVICE')).toBe('Wire_Device');
    expect(normalizeEntityName('tower_device')).toBe('Tower_Device');
    expect(normalizeEntityName('Wire_Device')).toBe('Wire_Device');
  });

  it('WIRE / CROSS 大小写无关归一化', () => {
    expect(normalizeEntityName('wire')).toBe('WIRE');
    expect(normalizeEntityName('Cross')).toBe('CROSS');
  });

  it('未知实体原样返回（向前兼容）', () => {
    expect(normalizeEntityName('SomeNewType')).toBe('SomeNewType');
    expect(normalizeEntityName('')).toBe('');
  });
});
