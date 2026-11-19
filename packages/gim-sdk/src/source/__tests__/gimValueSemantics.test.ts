import { describe, expect, it } from 'vitest';
import {
  getCaseInsensitiveKv,
  getFirstNonEmptyKv,
  isGimEmptyValue,
  resolveBaseFamilyReference,
} from '../gimValueSemantics.js';

describe('GIM value semantics', () => {
  it('uses the shared sentinel contract without treating falsey numbers as empty', () => {
    for (const value of ['', ' ', '/', ' - ', 'null', ' NULL ']) {
      expect(isGimEmptyValue(value)).toBe(true);
    }
    expect(isGimEmptyValue(null)).toBe(true);
    expect(isGimEmptyValue(undefined)).toBe(true);
    expect(isGimEmptyValue(0)).toBe(false);
    expect(isGimEmptyValue(0.0)).toBe(false);
    expect(isGimEmptyValue(false)).toBe(false);
  });

  it('reads records and Maps case-insensitively while preserving non-empty values', () => {
    const record = { basefamilypointer: ' / ', BASEFAMILY: ' family.fam ' };
    expect(getCaseInsensitiveKv(record, 'BASEFAMILY')).toBe(' family.fam ');
    expect(getFirstNonEmptyKv(record, ['BASEFAMILY', 'BASEFAMILYPOINTER'])).toBe('family.fam');
    expect(resolveBaseFamilyReference(record)).toBe('family.fam');

    const map = new Map<string, unknown>([['BaseFamilyPointer', 'mapped.fam']]);
    expect(resolveBaseFamilyReference(map)).toBe('mapped.fam');
  });

  it('does not let an empty primary family value mask BASEFAMILYPOINTER', () => {
    expect(resolveBaseFamilyReference({ BASEFAMILY: '-', BASEFAMILYPOINTER: 'pointer.fam' }))
      .toBe('pointer.fam');
  });
});
