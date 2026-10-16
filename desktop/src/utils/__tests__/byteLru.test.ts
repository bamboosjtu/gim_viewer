import { expect, it, vi } from 'vitest';
import { ByteLru, RevisionSet } from '../byteLru.js';
it('repeated trims do not rescan unchanged protected entries, but unpin and budget changes still evict', () => {
  const disposed=vi.fn(); const cache=new ByteLru<number>(1,disposed); const pins=new RevisionSet<string>();
  pins.add('a'); pins.add('b'); cache.set('a',1,2,pins);cache.set('b',2,2,pins);
  const has=vi.spyOn(pins,'has');
  for(let i=0;i<100;i++) cache.trim(pins);
  expect(has).not.toHaveBeenCalled();expect(disposed).not.toHaveBeenCalled();
  pins.delete('a');cache.trim(pins);expect(disposed).toHaveBeenCalledWith(1);expect(cache.get('b')).toBe(2);
  pins.delete('b');cache.trim(pins);expect(cache.size).toBe(0);expect(cache.bytes).toBe(0);
  cache.budget=10;cache.set('c',3,8,pins);cache.budget=1;cache.trim(pins);expect(cache.size).toBe(0);
});
