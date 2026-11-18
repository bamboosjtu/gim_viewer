import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupChunkViolations } from './startup-chunks.mjs';

function chunk(fileName, moduleIds, imports = [], isEntry = false) {
  return { type: 'chunk', fileName, moduleIds, imports, isEntry };
}

test('rejects heavy packages reached through renamed transitive static chunks', () => {
  const bundle = {
    'index.js': chunk('index.js', ['/src/main.ts'], ['common.js'], true),
    'common.js': chunk('common.js', [], ['geometry.js']),
    'geometry.js': chunk('geometry.js', [String.raw`C:\desktop\node_modules\three\build\three.module.js`], ['common.js']),
  };
  assert.deepEqual(startupChunkViolations(bundle), ['index.js → common.js → geometry.js (three)']);
});

test('allows geometry and maps reachable only through dynamic imports', () => {
  const bundle = {
    'index.js': { ...chunk('index.js', ['/src/main.ts'], [], true), dynamicImports: ['view.js'] },
    'view.js': chunk('view.js', ['/node_modules/web-ifc/web-ifc-api.js', '/node_modules/maplibre-gl/dist/maplibre-gl.js']),
  };
  assert.deepEqual(startupChunkViolations(bundle), []);
});
