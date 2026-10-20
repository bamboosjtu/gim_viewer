import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inject, onTestFinished } from 'vitest';
import type { GimIndexPayload, GimIndexResult, GeometryRefsPayload, ReachableGeometry } from '@desktop/database.js';
import { NativeTestProcessError, runNativeTestProcess } from './nativeTestProcess.js';
import type {} from './sqliteGlobalSetup.js';

type Request = { index: GimIndexPayload; refs: GeometryRefsPayload; filter?: string[]; migrate?: boolean };
type Result = { index: GimIndexResult; reachable: ReachableGeometry[]; filtered: ReachableGeometry[]; version: string };
const TEST_NAME = 'db::substation_sqlite_tests::substation_sqlite_exchange';

export async function executeSqliteRoundTrip(requests: Request[], executable: string, options: {
  args?: string[]; signal?: AbortSignal; timeoutMs?: number; tempRoot?: string;
} = {}): Promise<Result[]> {
  if (!executable || !existsSync(executable)) throw new Error(`SQLite execution: harness executable missing: ${executable}`);
  const tempRoot = options.tempRoot ?? resolve('.tmp-vitest/sqlite');
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(join(tempRoot, 'gim-sqlite-'));
  const input = join(dir, 'input.json'), output = join(dir, 'output.json');
  let canClean = true;
  try {
    writeFileSync(input, JSON.stringify(requests));
    const result = await runNativeTestProcess({
      command: executable,
      args: options.args ?? ['--exact', TEST_NAME, '--nocapture', '--test-threads=1'],
      phase: 'SQLite execution', timeoutMs: options.timeoutMs ?? 30_000, signal: options.signal,
      env: { ...process.env, GIM_SQLITE_INPUT: input, GIM_SQLITE_OUTPUT: output },
    });
    console.log(`[SQLite execution] ${requests.length} request(s) in ${Math.round(result.elapsedMs)}ms`);
    const outputError = (message: string) => new Error(`SQLite output: ${message}; elapsed=${Math.round(result.elapsedMs)}ms; exit=0; signal=null; command=${executable}\nstdout (tail):\n${result.stdout}\nstderr (tail):\n${result.stderr}`);
    if (!existsSync(output)) throw outputError('missing output.json after successful process exit');
    let value: unknown;
    try { value = JSON.parse(readFileSync(output, 'utf8')); }
    catch (error) { throw outputError(`invalid JSON: ${String(error)}`); }
    if (!Array.isArray(value) || value.length !== requests.length || value.some(row =>
      !row || !row.index || !Array.isArray(row.reachable) || !Array.isArray(row.filtered) || typeof row.version !== 'string')) {
      throw outputError(`invalid result shape or request count (expected ${requests.length})`);
    }
    return value as Result[];
  } catch (error) {
    if (error instanceof NativeTestProcessError && !error.childExited) {
      canClean = false;
      throw new Error(`${error.message}\nSQLite fixture retained: ${dir}`);
    }
    throw error;
  } finally {
    if (canClean) rmSync(dir, { recursive: true, force: true });
  }
}

export function sqliteRoundTrip(requests: Request[]): Promise<Result[]> {
  const controller = new AbortController();
  const work = executeSqliteRoundTrip(requests, inject('sqliteHarnessExecutable'), { signal: controller.signal });
  // Includes Vitest timeout/failure: stop and reap before the next test starts.
  onTestFinished(async () => { controller.abort(); await work.catch(() => {}); });
  return work;
}
