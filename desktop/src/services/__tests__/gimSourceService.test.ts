import { describe, expect, it } from 'vitest';
import {
  assertGimSourceMagicStable,
  inspectGimSourceBuffer,
  inspectGimSourceHead,
  readGimMagic,
  resolveGimRuntimeType,
  runtimeTypeFromMagic,
} from '../gimSourceService.js';

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

describe('GIM source descriptor', () => {
  it('keeps a bare equipment archive unknown until its semantic content is validated', () => {
    const source = inspectGimSourceHead('device.gim', new Uint8Array([0x37,0x7a,0xbc,0xaf,0x27,0x1c,0,4]).buffer);
    expect(source.magic).toBe('7z');
    expect(source.runtimeType).toBe('unknown');
    expect(resolveGimRuntimeType(source.runtimeType, 'equipment')).toBe('equipment');
    expect(resolveGimRuntimeType(source.runtimeType, 'unknown')).toBe('unknown');
  });
  it('routes GIMPKGT from the source magic', () => {
    const descriptor = inspectGimSourceHead('line.gim', bytes('GIMPKGT'));
    expect(descriptor.magic).toBe('GIMPKGT');
    expect(descriptor.runtimeType).toBe('transmission_line');
  });

  it('routes GIMPKGS from the source magic', () => {
    const descriptor = inspectGimSourceHead('substation.gim', bytes('GIMPKGS'));
    expect(descriptor.magic).toBe('GIMPKGS');
    expect(descriptor.runtimeType).toBe('substation');
  });

  it('keeps unknown magic as a diagnostic/fallback state', () => {
    expect(runtimeTypeFromMagic('GIMPKG')).toBe('unknown');
    expect(readGimMagic(new TextEncoder().encode('not-gim'))).toBe('not-gi');
  });

  it('preserves source identity separately from header metadata', () => {
    const descriptor = inspectGimSourceBuffer(
      'line.gim',
      bytes('GIMPKGT\0source-id\0A line project\0\0\0\0\0'),
      { path: 'C:/data/line.gim', size: 123, sha256: 'sha' },
    );
    expect(descriptor.path).toBe('C:/data/line.gim');
    expect(descriptor.sha256).toBe('sha');
    expect(descriptor.runtimeType).toBe('transmission_line');
  });

  it('fails closed when extraction observes a different source magic', () => {
    expect(() => assertGimSourceMagicStable('GIMPKGT', 'GIMPKGS')).toThrow(
      'SOURCE_CHANGED_DURING_OPEN',
    );
    expect(() => assertGimSourceMagicStable('GIMPKGT', 'GIMPKGT')).not.toThrow();
  });

  it('keeps cache/runtime routing source-driven', () => {
    expect(resolveGimRuntimeType('transmission_line', 'substation')).toBe('transmission_line');
    expect(resolveGimRuntimeType('substation', 'hybrid')).toBe('substation');
    expect(resolveGimRuntimeType('unknown', 'hybrid')).toBe('substation');
    expect(resolveGimRuntimeType('unknown', 'unknown')).toBe('unknown');
  });
});
