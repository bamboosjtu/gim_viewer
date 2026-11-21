import assert from 'node:assert/strict';
import test from 'node:test';
import { checkActionVersions } from './check-action-versions.mjs';

const sha = 'a'.repeat(40);
const fixture = (androidUses, pin = sha) => ({
  policy: { actions: { 'actions/checkout': 'v7', 'owner/android': pin } },
  workflows: new Map([
    ['android-ci.yml', `  - uses: actions/checkout@v7\n  ${androidUses}`],
    ['tools-ci.yml', '  - uses: actions/checkout@v7'],
    ['windows-ci.yml', '  - uses: actions/checkout@v7'],
  ]),
});

test('accepts an approved GitHub major and a quoted third-party commit SHA', () => {
  const { policy, workflows } = fixture(`- "uses": 'owner/android@${sha}' # release v4`);
  assert.deepEqual(checkActionVersions(policy, workflows), []);
});

test('rejects third-party tags, branches and shortened commits even when listed in policy', () => {
  for (const ref of ['v4', 'stable', sha.slice(0, 12)]) {
    const { policy, workflows } = fixture(`- uses: owner/android@${ref}`, ref);
    assert.match(checkActionVersions(policy, workflows).join('\n'), /requires a full 40-character commit SHA/);
  }
});

test('rejects an unapproved third-party commit and an alternate GitHub major', () => {
  const { policy, workflows } = fixture(`- uses: owner/android@${'b'.repeat(40)}`);
  workflows.set('tools-ci.yml', '- uses: actions/checkout@v6');
  const failures = checkActionVersions(policy, workflows).join('\n');
  assert.match(failures, /owner\/android.*does not match policy/);
  assert.match(failures, /actions\/checkout@v6 does not match policy v7/);
});

test('requires action references with syntax the gate can actually check', () => {
  const { policy, workflows } = fixture('- { uses: owner/android@main }');
  assert.match(checkActionVersions(policy, workflows).join('\n'), /standalone uses: entry/);
  workflows.set('android-ci.yml', '- uses:\n    owner/android@main');
  assert.match(checkActionVersions(policy, workflows).join('\n'), /requires a literal action reference/);
});
