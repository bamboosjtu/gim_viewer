// @vitest-environment node
import { it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { runNativeTestProcess } from './nativeTestProcess.js';
import { executeSqliteRoundTrip } from './sqliteHarness.js';

it('reports build failures with bounded output and a reaped process', async () => {
  const error = await runNativeTestProcess({ command: process.execPath,
    args: ['-e', "process.stdout.write('x'.repeat(70000));process.stderr.write('build-broken');process.exitCode=9"],
    phase: 'SQLite harness build', timeoutMs: 5000 }).catch(e => e);
  expect(error.childExited).toBe(true);
  expect(error.message).toContain('exit=9'); expect(error.message).toContain('build-broken');
  expect(error.message.length).toBeLessThan(34000);
});

it('fails a missing command without waiting for the execution deadline', async () => {
  await expect(runNativeTestProcess({ command: resolve('.tmp-vitest/missing-native-command'), args: [],
    phase: 'SQLite harness build', timeoutMs: 5000 })).rejects.toMatchObject({ childExited: true });
});

it('times out and reaps a hung process', async () => {
  await expect(runNativeTestProcess({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'],
    phase: 'SQLite execution', timeoutMs: 300 })).rejects.toMatchObject({ childExited: true, message: expect.stringContaining('timed out') });
});

it('cancellation waits for process exit before resolving cleanup', async () => {
  const controller = new AbortController(); let pid = 0;
  await expect(runNativeTestProcess({ command: process.execPath,
    args: ['-e', "console.log(process.pid);setInterval(()=>{},1000)"], phase: 'SQLite execution',
    timeoutMs: 5000, signal: controller.signal,
    onStdoutLine: line => { pid = Number(line); controller.abort(); },
  })).rejects.toMatchObject({ childExited: true, message: expect.stringContaining('aborted') });
  expect(pid).toBeGreaterThan(0); expect(() => process.kill(pid, 0)).toThrow();
});

it('rejects missing harness, missing output, invalid JSON and mismatched results without leaking fixtures', async () => {
  await expect(executeSqliteRoundTrip([], resolve('.tmp-vitest/missing-harness'))).rejects.toThrow('executable missing');
  const root = resolve('.tmp-vitest'); mkdirSync(root, { recursive: true });
  const tempRoot = mkdtempSync(join(root, 'harness-errors-'));
  try {
    for (const [script, message] of [
      ["process.stderr.write('execution-broken');process.exit(7)", 'exit=7'],
      ['process.exit(0)', 'missing output.json'],
      ["require('fs').writeFileSync(process.env.GIM_SQLITE_OUTPUT,'broken')", 'invalid JSON'],
      ["require('fs').writeFileSync(process.env.GIM_SQLITE_OUTPUT,'[{}]')", 'invalid result shape'],
    ]) {
      await expect(executeSqliteRoundTrip([], process.execPath, { args: ['-e', script], tempRoot })).rejects.toThrow(message);
      expect(readdirSync(tempRoot)).toEqual([]);
    }
    await expect(executeSqliteRoundTrip([], process.execPath, {
      args: ['-e', 'setInterval(()=>{},1000)'], tempRoot, timeoutMs: 300,
    })).rejects.toMatchObject({ childExited: true, message: expect.stringContaining('timed out') });
    expect(readdirSync(tempRoot)).toEqual([]);
  } finally { rmSync(tempRoot, { recursive: true, force: true }); }
});
