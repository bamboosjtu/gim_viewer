// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { DevLodSceneCommits } from '../devLodSceneCommits.js';

it('preserves FIFO among unpromoted placements and rejects work after session replacement', async () => {
  vi.useFakeTimers();
  try {
    let current = true;
    const queue = new DevLodSceneCommits(() => current, () => 0);
    const order: string[] = [];
    const jobs = ['first', 'selected', 'last'].map((root) =>
      queue.submit(2, () => order.push(root), root),
    );
    queue.promote('selected');
    await vi.advanceTimersByTimeAsync(24);
    await Promise.all(jobs);
    expect(order).toEqual(['selected', 'first', 'last']);

    const stale = expect(queue.submit(2, () => order.push('stale'))).rejects
      .toMatchObject({ name: 'AbortError' });
    current = false;
    await vi.advanceTimersByTimeAsync(24);
    await stale;
    expect(queue.size).toBe(0);
    expect(order).toEqual(['selected', 'first', 'last']);
  } finally {
    vi.useRealTimers();
  }
});
