import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const policy = JSON.parse(readFileSync(join(root, '.github/action-versions.json'), 'utf8'));
const requiredWorkflows = new Set(['android-ci.yml', 'tools-ci.yml', 'windows-ci.yml']);
const workflows = readdirSync(join(root, '.github/workflows'))
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort();

const failures = [];
for (const workflow of workflows) {
  if (!requiredWorkflows.has(workflow)) {
    failures.push(`unexpected workflow (CI keeps only android-ci/tools-ci/windows-ci): ${workflow}`);
  }
}
for (const workflow of requiredWorkflows) {
  if (!workflows.includes(workflow)) failures.push(`required workflow is missing: ${workflow}`);
}
const seen = new Set();
for (const workflow of workflows) {
  const path = join(root, '.github/workflows', workflow);
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/);
    if (!match) continue;
    const reference = match[1];
    if (reference.startsWith('./') || reference.startsWith('docker://')) continue;
    const at = reference.lastIndexOf('@');
    if (at <= 0 || at === reference.length - 1) {
      failures.push(`${workflow}:${index + 1}: action reference must include a version: ${reference}`);
      continue;
    }
    const action = reference.slice(0, at);
    const version = reference.slice(at + 1);
    const expected = policy.actions[action];
    if (!expected) {
      failures.push(`${workflow}:${index + 1}: action is not in .github/action-versions.json: ${action}`);
      continue;
    }
    if (version !== expected) {
      failures.push(`${workflow}:${index + 1}: ${action}@${version} does not match policy ${expected}`);
      continue;
    }
    seen.add(action);
  }
}

for (const action of Object.keys(policy.actions)) {
  if (!seen.has(action)) failures.push(`policy action is never used: ${action}`);
}

if (failures.length) {
  console.error('GitHub Action pin check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`GitHub Action pins match policy across ${workflows.length} workflows.`);
