import { describe, expect, it } from 'vitest';
import {
  diagnosticForFailure,
  diagnosticFromManifest,
  diagnosticFromSerialization,
  getGeometryDiagnostic,
  setGeometryDiagnostic,
} from '../geometryDiagnostics.js';

describe('DEV geometry degradation contract', () => {
  it('normalizes case/separators without changing the displayed source spelling', () => {
    const store: { geometryDiagnosticsByDevPath?: Map<string, ReturnType<typeof diagnosticFromManifest>> } = {};
    const diagnostic = diagnosticFromManifest('dev\\VendorDevice.DEV', { status: 'partial' });
    setGeometryDiagnostic(store, diagnostic);

    expect(getGeometryDiagnostic(store, 'DEV/VENDORDEVICE.dev')).toMatchObject({
      devPath: 'dev/VendorDevice.DEV',
      status: 'partial',
      source: 'warm',
    });
  });

  it('keeps partial and unsupported distinct from deterministic empty', () => {
    const store: { geometryDiagnosticsByDevPath?: Map<string, ReturnType<typeof diagnosticFromSerialization>> } = {};
    setGeometryDiagnostic(store, diagnosticFromSerialization('DEV/a.dev', {
      status: 'partial',
      discoveredModCount: 3,
      renderableModCount: 2,
      emptySourceCount: 1,
      unsupportedPrimitiveTypeCounts: { VendorPrimitive: 1 },
    }));
    setGeometryDiagnostic(store, diagnosticFromSerialization('DEV/b.dev', {
      status: 'unsupported',
      unsupportedSourceCount: 1,
    }));
    setGeometryDiagnostic(store, diagnosticFromSerialization('DEV/c.dev', {
      status: 'empty',
    }));

    expect(getGeometryDiagnostic(store, 'a.dev')?.status).toBe('partial');
    expect(getGeometryDiagnostic(store, 'b.dev')?.status).toBe('unsupported');
    expect(getGeometryDiagnostic(store, 'c.dev')?.status).toBe('empty');
    expect(getGeometryDiagnostic(store, 'a.dev')?.unsupportedPrimitiveTypeCounts)
      .toEqual({ VendorPrimitive: 1 });
  });

  it('represents isolated failure without converting it into empty', () => {
    const diagnostic = diagnosticForFailure('DEV/broken.dev', 'missing-dependency', 'warm');
    expect(diagnostic).toMatchObject({
      status: 'failed',
      reason: 'missing-dependency',
      source: 'warm',
    });
  });
});
