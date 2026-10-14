import { expect, it, vi } from 'vitest';
import { IfcAPI } from 'web-ifc';
import { installWebIfcStreamCompatibility } from '../webIfcCompatibility.js';
it('uses actual browser embind arity without changing default scaling', () => {
  installWebIfcStreamCompatibility();
  const api = new IfcAPI(),
    callback = vi.fn(),
    stream = Object.assign(vi.fn(), { argCount: 3 });
  (api as any).wasmModule = { StreamMeshes: stream };
  api.StreamMeshes(1, [2], callback);
  expect(stream).toHaveBeenCalledWith(1, [2], callback);
  expect(() => api.StreamMeshes(1, [2], callback, false)).toThrow(
    'cannot disable'
  );
});
