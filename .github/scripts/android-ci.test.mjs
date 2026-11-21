import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../workflows/android-ci.yml', import.meta.url), 'utf8');

test('isolates every manual signing run and still coalesces branch CI by event and ref', () => {
  const concurrency = workflow.match(/^concurrency:\r?\n((?:[ \t]+[^\r\n]*\r?\n)+)/m)?.[1] ?? '';
  assert.equal(
    concurrency.match(/^\s*group: (.+)$/m)?.[1],
    'android-ci-${{ github.workflow }}-${{ github.event_name }}-' +
      "${{ github.event_name == 'workflow_dispatch' && github.run_id || github.ref }}",
  );
  assert.equal(
    concurrency.match(/^\s*cancel-in-progress: (.+)$/m)?.[1],
    "${{ github.event_name != 'workflow_dispatch' }}",
  );
});
