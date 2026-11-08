import {expect,it} from 'vitest';
import {MissingDevDependencyError,geometryFailureKind} from '../sourceGeometryError.js';

it('preserves source reference evidence and separates capacity from parser failure',()=>{
  const missing=MissingDevDependencyError.forPath('DEV/a.dev','MOD/absent.mod','MOD');
  expect(missing.sourceEvidence).toMatch(/^source-reference-missing-v1:/);
  expect(geometryFailureKind(missing)).toBe('missing-dependency');
  expect(geometryFailureKind(new Error('DEV split merge input exceeds reserved budget'))).toBe('capacity-exceeded');
  expect(geometryFailureKind(Object.assign(new Error('DEV MOD loading failed'),{cause:new Error('DEV compiled result exceeds 128 MiB quota')}))).toBe('capacity-exceeded');
  expect(geometryFailureKind(Object.assign(new Error('remote geometry failure'),{geometryKind:'capacity-exceeded'}))).toBe('capacity-exceeded');
  expect(geometryFailureKind(new Error('XML parse failed'))).toBe('parse-failed');
});
