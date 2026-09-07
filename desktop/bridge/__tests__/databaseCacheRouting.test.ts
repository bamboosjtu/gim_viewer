import { describe, expect, it, vi } from 'vitest';

const invokeTimed = vi.hoisted(() => vi.fn().mockResolvedValue({ valid: false }));

vi.mock('../invokeTimed.js', () => ({ invokeTimed }));

import { validateGimCache } from '../database.js';

describe('cache validation routing contract', () => {
  it('passes the inspected source domain explicitly to SQLite validation', async () => {
    await validateGimCache(42, 'transmission_line');
    expect(invokeTimed).toHaveBeenCalledWith('validate_gim_cache', {
      projectId: 42,
      expectedProjectType: 'transmission_line',
    });
  });
});
