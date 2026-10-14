import { expect, it, vi } from 'vitest';
import { IfcAPI } from 'web-ifc';
import { withSharedIfcImport } from '../ifcSharedImport.js';

it('borrows one parsed model for both importer phases without releasing its owner, then restores the API', async () => {
  const owner = new IfcAPI(),
    bytes = new Uint8Array([1]),
    settings = { COORDINATE_TO_ORIGIN: true };
  const init = vi.spyOn(IfcAPI.prototype, 'Init').mockResolvedValue();
  const open = vi.spyOn(IfcAPI.prototype, 'OpenModel').mockReturnValue(0);
  const dispose = vi
    .spyOn(IfcAPI.prototype, 'Dispose')
    .mockImplementation(() => {});
  const observed = vi.fn();
  try {
    await withSharedIfcImport(owner, 0, bytes, settings, observed, async () => {
      for (let i = 0; i < 2; i++) {
        const api = new IfcAPI();
        await api.Init();
        expect(api.OpenModel(bytes, settings)).toBe(0);
        api.Dispose();
      }
      expect(init).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(dispose).not.toHaveBeenCalled();
    });
    owner.Dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(IfcAPI.prototype.OpenModel).toBe(open);
  } finally {
    vi.restoreAllMocks();
  }
});
it('rejects a different source or coordinate settings and restores methods after failure', async () => {
  const owner = new IfcAPI(),
    bytes = new Uint8Array([1]),
    open = IfcAPI.prototype.OpenModel;
  await expect(
    withSharedIfcImport(
      owner,
      0,
      bytes,
      { COORDINATE_TO_ORIGIN: true },
      () => {},
      async () => {
        const api = new IfcAPI();
        await api.Init();
        api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
      }
    )
  ).rejects.toThrow('mismatch');
  expect(IfcAPI.prototype.OpenModel).toBe(open);
  await expect(
    withSharedIfcImport(
      owner,
      0,
      bytes,
      {},
      () => {},
      async () => {
        const api = new IfcAPI();
        await api.Init();
        api.OpenModel(bytes.slice(), {});
      }
    )
  ).rejects.toThrow('mismatch');
});
