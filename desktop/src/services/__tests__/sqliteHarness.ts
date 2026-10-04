import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { GimIndexPayload, GimIndexResult, GeometryRefsPayload, ReachableGeometry } from '@desktop/database.js';

export function sqliteRoundTrip(requests: Array<{ index: GimIndexPayload; refs: GeometryRefsPayload; filter?: string[]; migrate?: boolean }>): Array<{
  index: GimIndexResult; reachable: ReachableGeometry[]; filtered: ReachableGeometry[]; version: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'gim-sqlite-'));
  const input = join(dir, 'input.json'), output = join(dir, 'output.json');
  try {
    writeFileSync(input, JSON.stringify(requests));
    const run = spawnSync('cargo', ['test', '--manifest-path', resolve('src-tauri/Cargo.toml'), '--lib', 'substation_sqlite_exchange', '--', '--nocapture'], {
      encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIM_SQLITE_INPUT: input, GIM_SQLITE_OUTPUT: output },
    });
    if (run.status !== 0 || !existsSync(output)) throw new Error(`Actual Rust/SQLite exchange failed: ${run.error ?? ''}\n${run.stdout}\n${run.stderr}`);
    return JSON.parse(readFileSync(output, 'utf8'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
