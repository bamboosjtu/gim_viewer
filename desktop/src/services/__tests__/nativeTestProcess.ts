import { spawn, execFile } from 'node:child_process';

export class NativeTestProcessError extends Error {
  constructor(message: string, readonly childExited: boolean) { super(message); }
}

/** Bounded test-only subprocess. Reap the owned process before callers remove fixtures. */
export function runNativeTestProcess(options: {
  command: string; args: string[]; phase: string; timeoutMs: number;
  cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal;
  onStdoutLine?: (line: string) => void; killGraceMs?: number;
}): Promise<{ stdout: string; stderr: string; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    if (options.signal?.aborted) {
      reject(new NativeTestProcessError(`${options.phase}: aborted before spawn`, true)); return;
    }
    const child = spawn(options.command, options.args, {
      cwd: options.cwd, env: options.env, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', lineBuffer = '', failure = '', settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const detail = (state: string) => `${options.phase}: ${state}; elapsed=${Math.round(performance.now() - started)}ms; command=${options.command}\nstdout (tail):\n${stdout}\nstderr (tail):\n${stderr}`;
    const stop = (reason: string) => {
      if (failure || settled) return;
      failure = reason;
      if (child.pid) {
        if (process.platform === 'win32') {
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, error => {
            if (error && !settled) child.kill('SIGKILL');
          });
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      }
      grace = setTimeout(() => {
        if (settled) return;
        settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
        reject(new NativeTestProcessError(detail(`${failure}; process exit unconfirmed (pid=${child.pid})`), false));
      }, options.killGraceMs ?? 5000);
    };
    const abort = () => stop('aborted');
    const timer = setTimeout(() => stop(`timed out after ${options.timeoutMs}ms`), options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-32768);
      if (!options.onStdoutLine) return;
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/); lineBuffer = lines.pop()!;
      try { for (const line of lines) options.onStdoutLine(line); } catch (error) { stop(String(error)); }
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-32768); });
    child.on('error', error => { failure ||= `spawn failed: ${error.message}`; });
    child.on('close', (code, signal) => {
      clearTimeout(timer); if (grace) clearTimeout(grace);
      options.signal?.removeEventListener('abort', abort);
      if (settled) return;
      settled = true;
      if (!failure && options.onStdoutLine && lineBuffer) {
        try { options.onStdoutLine(lineBuffer); } catch (error) { failure = String(error); }
      }
      if (failure || code !== 0) reject(new NativeTestProcessError(detail(`${failure || 'failed'}; exit=${code}; signal=${signal}`), true));
      else resolve({ stdout, stderr, elapsedMs: performance.now() - started });
    });
  });
}
