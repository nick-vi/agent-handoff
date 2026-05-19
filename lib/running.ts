/**
 * Running-invocation registry — tracks live agent subprocesses.
 *
 * Shape: `<state-dir>/running/<workspaceDir>/<topic>--<agent>--<run_id>.json`
 * containing `{ pid, topic, agent, run_id, started_at, workspace_root }`.
 *
 * Lifecycle:
 *   - Writer (the handoff process invoking the agent): `markRunning` after
 *     spawn, `clearRunning` in a `finally` after the child closes.
 *   - Reader (a different terminal): `readRunning` to discover the pid
 *     and `cancelRunning` to send the requested signal (SIGINT by default).
 *
 * Why a file rather than a socket / lockfile: cross-process
 * cancellation needs to work from a fresh terminal that didn't spawn
 * the original. A flat file with the pid is the simplest primitive
 * that satisfies that. Stale files (writer crashed before
 * `clearRunning`) are detected on read by checking `kill(pid, 0)` —
 * EPERM/ESRCH means the pid is dead and the file can be cleaned.
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { AtomicFile } from './atomic-file.ts';
import { ensureStateDir } from './state-dir.ts';
import type { AgentName, Mode } from './schema/v1.ts';
import type { WorkspaceInfo } from './workspace.ts';

export type RunningV1 = {
  schema_version: 1;
  pid: number;
  topic: string;
  agent: AgentName;
  mode?: Mode;
  run_id: string;
  parent_run_id?: string;
  workspace_root: string;
  started_at: string;
};

function runningDir(ws: WorkspaceInfo): string {
  return join(ensureStateDir(), 'running', ws.dirName);
}

function runningPath(ws: WorkspaceInfo, topic: string, agent: AgentName, runId: string): string {
  return join(runningDir(ws), `${topic}--${agent}--${safeRunIdSegment(runId)}.json`);
}

function safeRunIdSegment(runId: string): string {
  return runId.replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function markRunning(
  ws: WorkspaceInfo,
  topic: string,
  agent: AgentName,
  pid: number,
  opts: { mode?: Mode; runId?: string; parentRunId?: string } = {}
): void {
  const dir = runningDir(ws);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const runId = opts.runId ?? `pid-${pid}`;
  const file = new AtomicFile(runningPath(ws, topic, agent, runId));
  file.writeJson(
    {
      schema_version: 1,
      pid,
      topic,
      agent,
      ...(opts.mode ? { mode: opts.mode } : {}),
      run_id: runId,
      ...(opts.parentRunId ? { parent_run_id: opts.parentRunId } : {}),
      workspace_root: ws.resolvedRoot,
      started_at: new Date().toISOString(),
    } satisfies RunningV1,
    2
  );
}

export function clearRunning(
  ws: WorkspaceInfo,
  topic: string,
  agent: AgentName,
  opts: { runId?: string } = {}
): void {
  if (opts.runId) {
    const path = runningPath(ws, topic, agent, opts.runId);
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      /* best-effort; another invocation may have raced us */
    }
    return;
  }

  const dir = runningDir(ws);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      const raw = new AtomicFile(path).readJson<RunningV1>();
      if (isRunningRecord(raw) && raw.topic === topic && raw.agent === agent) {
        unlinkSync(path);
      }
    } catch {
      /* best-effort; another invocation may have raced us */
    }
  }
}

export function readRunning(
  ws: WorkspaceInfo,
  topic: string,
  agent: AgentName,
  opts: { runId?: string } = {}
): RunningV1 | null {
  const matches = listRunning(ws).filter(
    (entry) => entry.topic === topic
      && entry.agent === agent
      && (!opts.runId || entry.run_id === opts.runId)
  );
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * List all running invocations for a workspace. Filters out files
 * whose pids are no longer alive (writer crashed before clearRunning),
 * and removes those stale files so subsequent calls don't see them.
 */
export function listRunning(ws: WorkspaceInfo): RunningV1[] {
  const dir = runningDir(ws);
  if (!existsSync(dir)) return [];
  const out: RunningV1[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      // Skip directories — defensive.
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    const file = new AtomicFile(path);
    const raw = file.readJson<RunningV1>();
    if (!isRunningRecord(raw)) continue;
    if (!isAlive(raw.pid)) {
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
      continue;
    }
    out.push(raw);
  }
  return out.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
}

/**
 * Send SIGINT to a running invocation. Returns true if the signal was
 * delivered (process was alive at the moment of the call), false if
 * the file is missing or the pid is already dead.
 *
 * SIGINT first because most CLIs treat it as "graceful Ctrl-C": exit
 * after current API call completes, write final transcript line. A
 * caller that wants the process gone immediately can pass `signal:
 * 'SIGTERM'` or `'SIGKILL'`. Default does NOT auto-escalate — the
 * caller decides whether to follow up.
 */
export function cancelRunning(
  ws: WorkspaceInfo,
  topic: string,
  agent: AgentName,
  signal: NodeJS.Signals = 'SIGINT',
  opts: { runId?: string } = {}
): { delivered: boolean; pid: number | null; runId: string | null } {
  const entry = readRunning(ws, topic, agent, opts);
  if (!entry) return { delivered: false, pid: null, runId: null };
  if (!isAlive(entry.pid)) {
    clearRunning(ws, topic, agent, { runId: entry.run_id });
    return { delivered: false, pid: entry.pid, runId: entry.run_id };
  }
  try {
    process.kill(entry.pid, signal);
    return { delivered: true, pid: entry.pid, runId: entry.run_id };
  } catch {
    clearRunning(ws, topic, agent, { runId: entry.run_id });
    return { delivered: false, pid: entry.pid, runId: entry.run_id };
  }
}

function isRunningRecord(raw: RunningV1 | null): raw is RunningV1 {
  return Boolean(
    raw
      && raw.schema_version === 1
      && typeof raw.pid === 'number'
      && typeof raw.topic === 'string'
      && isAgentName(raw.agent)
      && typeof raw.run_id === 'string'
      && typeof raw.workspace_root === 'string'
      && typeof raw.started_at === 'string'
  );
}

function isAgentName(value: unknown): value is AgentName {
  return value === 'claude' || value === 'codex' || value === 'cursor';
}

/** `kill(pid, 0)` is the POSIX idiom for "is this pid alive". */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process. EPERM = exists but we can't signal it,
    // which still counts as alive for our purposes.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
