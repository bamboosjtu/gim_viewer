import { describe, expect, it } from 'vitest';
import { resolveGimRuntimeType, runtimeTypeFromMagic } from '../../src/services/gimSourceService.js';

describe('source cache routing contract', () => {
  it('keeps cache domain selection source-driven', () => {
    expect(runtimeTypeFromMagic('GIMPKGT')).toBe('transmission_line');
    expect(runtimeTypeFromMagic('GIMPKGS')).toBe('substation');
  });

  it('keeps source magic authoritative and does not create a hybrid Runtime', () => {
    expect(resolveGimRuntimeType('transmission_line', 'substation')).toBe('transmission_line');
    expect(resolveGimRuntimeType('substation', 'hybrid')).toBe('substation');
    expect(resolveGimRuntimeType('unknown', 'hybrid')).toBe('substation');
    expect(resolveGimRuntimeType('unknown', 'unknown')).toBe('unknown');
  });
});
