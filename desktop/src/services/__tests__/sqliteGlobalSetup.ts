import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GlobalSetupContext } from 'vitest/node';
import { runNativeTestProcess } from './nativeTestProcess.js';

declare module 'vitest' {
  export interface ProvidedContext { sqliteHarnessExecutable: string }
}

export default async function setup({ provide }: GlobalSetupContext) {
  const manifest = realpathSync(resolve('src-tauri/Cargo.toml'));
  const executables = new Set<string>();
  console.log('[SQLite build] preparing Rust test harness (600s maximum)');
  const result = await runNativeTestProcess({
    command: 'cargo',
    args: ['test', '--manifest-path', manifest, '--locked', '--lib', '--no-run', '--message-format=json'],
    phase: 'SQLite harness build', timeoutMs: 600_000, env: process.env,
    onStdoutLine(line) {
      if (!line.startsWith('{')) return;
      const row = JSON.parse(line);
      if (row.reason === 'compiler-artifact' && row.manifest_path
        && realpathSync(row.manifest_path) === manifest && row.target?.name === 'gim_viewer_lib'
        && row.profile?.test === true && typeof row.executable === 'string') executables.add(row.executable);
    },
  });
  const artifactError = (message: string) => new Error(`SQLite harness build: ${message}; elapsed=${Math.round(result.elapsedMs)}ms; exit=0; signal=null; command=cargo\nstdout (tail):\n${result.stdout}\nstderr (tail):\n${result.stderr}`);
  if (executables.size !== 1) throw artifactError(`expected one executable from Cargo, found ${executables.size}`);
  const executable = [...executables][0];
  if (!existsSync(executable)) throw artifactError(`executable missing: ${executable}`);
  provide('sqliteHarnessExecutable', realpathSync(executable));
  console.log(`[SQLite build] ready in ${Math.round(result.elapsedMs)}ms: ${executable}`);
}
