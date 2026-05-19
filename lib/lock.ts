/**
 * Topic-scoped cooperative locking.
 *
 * `mkdir(2)` on a non-existing path is the only widely-portable atomic
 * primitive available without OS-specific syscalls. We exploit it: the
 * lock for a topic is the existence of `<topic>.lock/`. Inside the dir
 * we drop an `info.json` recording who holds it, so stale-detection can
 * distinguish "another agent is busy" from "previous holder crashed".
 *
 * Stale threshold defaults to 30 seconds — a successful registry
 * operation completes in well under a second, so any lock older than 30s
 * almost certainly belongs to a crashed process. The fallback is to read
 * the lock's pid and check whether the OS still recognizes it (`kill -0`),
 * which catches the rare slow-write case where a live operation legitimately
 * exceeded the threshold.
 *
 * The lock guards registry mutations only — reading the snapshot or
 * appending to the event log doesn't take it. Writes serialize via the
 * lock so concurrent invocations can't lose round numbers or session-id
 * updates.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

export type LockInfo = {
  pid: number;
  hostname: string;
  agent: string;
  topic: string;
  acquiredAt: string; // ISO-8601 UTC
};

export class LockTimeoutError extends Error {
  constructor(
    readonly topic: string,
    readonly heldBy: LockInfo | null
  ) {
    const holder = heldBy ? `pid ${heldBy.pid} on ${heldBy.hostname} (${heldBy.agent})` : 'unknown';
    super(`Could not acquire lock for topic "${topic}"; held by ${holder}`);
    this.name = 'LockTimeoutError';
  }
}

const STALE_THRESHOLD_MS = 30_000;
/**
 * Retry budget for lock acquisition. With a base of 50ms and ±50% jitter,
 * 600 retries gives a worst-case wait of ~30s. Real-world contention is
 * usually 2-3 callers; the high ceiling is to survive bursty parallel
 * handoff invocations against the same topic without spurious failures.
 */
const ACQUIRE_RETRIES = 600;
const RETRY_DELAY_BASE_MS = 50;
const RETRY_DELAY_JITTER_MS = 50;

/**
 * Run `fn` while holding the topic lock. Releases on return or throw.
 * Retries up to ~30 seconds (600 attempts × ~50ms with ±50% jitter)
 * before giving up with `LockTimeoutError`.
 */
export async function withLock<T>(
  workspaceDir: string,
  topic: string,
  agent: string,
  fn: () => Promise<T>
): Promise<T> {
  const lockDir = join(workspaceDir, `${topic}.lock`);
  await acquire(lockDir, topic, agent);
  try {
    return await fn();
  } finally {
    release(lockDir);
  }
}

async function acquire(lockDir: string, topic: string, agent: string): Promise<void> {
  // Ensure parent (the workspace dir) exists — but NOT the lock dir
  // itself. `recursive: true` would defeat the atomicity of the
  // lock-dir mkdir, so we create parents separately.
  const parent = dirname(lockDir);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < ACQUIRE_RETRIES; attempt++) {
    try {
      mkdirSync(lockDir, { recursive: false, mode: 0o700 });
      writeInfoFile(lockDir, topic, agent);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (isStaleAndCleared(lockDir)) {
        // Stale lock removed; loop to retry the mkdir on the next iteration.
        continue;
      }
      // Jittered delay: base + uniform[0..jitter) prevents the thundering-
      // herd pattern where N parallel callers all sleep 100ms and wake at
      // the same instant, perpetually colliding on retry.
      const delay = RETRY_DELAY_BASE_MS + Math.floor(Math.random() * RETRY_DELAY_JITTER_MS);
      await sleep(delay);
    }
  }
  throw new LockTimeoutError(topic, readInfoFile(lockDir));
}

function release(lockDir: string): void {
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    /* best-effort; if the dir was already removed (e.g. by a stale-clearing
       sibling on another invocation), there's nothing to do */
  }
}

/**
 * Inspect a lock dir and remove it if stale. Returns true iff the lock was
 * removed and the caller should retry. False means "lock held by a live
 * process; back off and retry".
 */
function isStaleAndCleared(lockDir: string): boolean {
  let info: LockInfo | null = null;
  try {
    info = readInfoFile(lockDir);
  } catch {
    info = null;
  }

  // No info file (partial create or external interference) → trust the
  // mtime of the dir itself.
  let ageMs = 0;
  try {
    const st = statSync(lockDir);
    ageMs = Date.now() - st.mtimeMs;
  } catch {
    // Dir disappeared between the EEXIST and our stat → caller will mkdir cleanly.
    return true;
  }

  if (info && info.hostname === hostname()) {
    // Same host: prefer the live PID check over time-based heuristic.
    if (isPidAlive(info.pid)) return false;
  }

  if (ageMs < STALE_THRESHOLD_MS) return false;

  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    /* swallow; whoever cleared first wins */
  }
  return true;
}

function writeInfoFile(lockDir: string, topic: string, agent: string): void {
  const info: LockInfo = {
    pid: process.pid,
    hostname: hostname(),
    agent,
    topic,
    acquiredAt: new Date().toISOString(),
  };
  writeFileSync(join(lockDir, 'info.json'), JSON.stringify(info, null, 2), 'utf-8');
}

function readInfoFile(lockDir: string): LockInfo | null {
  const path = join(lockDir, 'info.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as LockInfo;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    // signal 0 doesn't deliver a signal; just probes whether the process
    // exists and we have permission to signal it.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH = no such process. EPERM = process exists but we can't signal
    // (different uid). Treat both as "alive" defensively for EPERM; only
    // ESRCH proves death.
    if (code === 'ESRCH') return false;
    return true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
