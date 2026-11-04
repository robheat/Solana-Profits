// Single-instance lock for trading loops: two loops trading the same wallet would race
// each other's balances. The lock file holds the owner's PID; a stale lock (dead PID)
// is taken over.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireLock(path: string, label: string): () => void {
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8').trim().split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) {
      throw new Error(`another trading loop is already running (pid ${pid}, lock ${path}); stop it first`);
    }
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${process.pid} ${label} ${new Date().toISOString()}\n`, { mode: 0o600 });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (existsSync(path) && Number(readFileSync(path, 'utf8').trim().split(/\s+/)[0]) === process.pid) rmSync(path);
    } catch {
      // best effort
    }
  };
}
