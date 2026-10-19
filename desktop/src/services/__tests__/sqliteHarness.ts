import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { GimIndexPayload, GimIndexResult, GeometryRefsPayload, ReachableGeometry } from '@desktop/database.js';

export async function sqliteRoundTrip(requests: Array<{ index: GimIndexPayload; refs: GeometryRefsPayload; filter?: string[]; migrate?: boolean }>): Promise<Array<{
  index: GimIndexResult; reachable: ReachableGeometry[]; filtered: ReachableGeometry[]; version: string;
}>> {
  const dir = mkdtempSync(join(tmpdir(), 'gim-sqlite-'));
  const input = join(dir, 'input.json'), output = join(dir, 'output.json');
  try {
    writeFileSync(input, JSON.stringify(requests));
    // Async spawn keeps the Vitest worker responsive to onTaskUpdate while the
    // Rust/SQLite test binary runs on CI. spawnSync could exceed the worker RPC
    // timeout under load even though the test itself was progressing.
    await new Promise<void>((resolveRun, rejectRun) => {
      const child = spawn('cargo', ['test', '--manifest-path', resolve('src-tauri/Cargo.toml'), '--lib', 'substation_sqlite_exchange', '--', '--nocapture'], {
        env: { ...process.env, GIM_SQLITE_INPUT: input, GIM_SQLITE_OUTPUT: output },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill(); rejectRun(new Error('Actual Rust/SQLite exchange timed out')); }, 180_000);
      child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', (error) => { clearTimeout(timer); rejectRun(error); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 || !existsSync(output)) {
          rejectRun(new Error(`Actual Rust/SQLite exchange failed (${code})\n${stdout}\n${stderr}`));
          return;
        }
        resolveRun();
      });
    });
    return JSON.parse(readFileSync(output, 'utf8'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
