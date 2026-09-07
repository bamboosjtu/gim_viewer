import { describe, expect, it } from 'vitest';
import {
  inspectGimSourceBuffer,
  inspectGimSourceHead,
  readGimMagic,
  runtimeTypeFromMagic,
} from '../gimSourceService.js';

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

describe('GIM source descriptor', () => {
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
});

