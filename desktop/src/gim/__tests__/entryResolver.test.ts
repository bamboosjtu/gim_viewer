import { expect, it } from 'vitest';
import { createEntryResolver } from '../entryResolver.js';

it('resolves actual relative/global paths and refuses ambiguous or case-colliding entries', () => {
  const resolve = createEntryResolver(['assets/unit.dev', 'shared/item.phm', 'left/item.mod', 'right/item.mod', 'A.dev', 'a.dev']);
  expect(resolve('../shared/item.phm', 'assets/unit.dev')).toBe('shared/item.phm');
  expect(resolve('UNIT.DEV')).toBe('assets/unit.dev');
  expect(resolve('item.mod')).toBeNull(); expect(resolve('item.mod', 'right/part.phm')).toBe('right/item.mod');
  expect(resolve('A.dev')).toBeNull(); expect(resolve('missing.mod')).toBeNull();
});
