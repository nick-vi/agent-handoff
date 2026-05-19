/**
 * Running-invocation registry + cross-process cancel.
 *
 * Spawns a real `sleep` subprocess to exercise the full
 * mark/list/cancel/clear lifecycle, then verifies the stale-pid
 * cleanup path by writing a fake entry pointing at a pid that's
 * already dead and confirming `listRunning` removes it on read.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtomicFile } from '../lib/atomic-file.ts';
import {
  cancelRunning,
  clearRunning,
  listRunning,
  markRunning,
  readRunning,
} from '../lib/running.ts';
import type { WorkspaceInfo } from '../lib/workspace.ts';

let stateRoot: string;
let originalStateDir: string | undefined;

function ws(): WorkspaceInfo {
  return {
    resolvedRoot: '/tmp/running-test',
    basename: 'running',
    hash: 'run0000aaaaaa',
    dirName: 'running-run0000aaaaaa',
    fromGit: false,
    aliased: false,
    gitProbe: 'not-a-repo',
  };
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

describe('running registry + cross-process cancel', () => {
  beforeAll(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'agent-handoff-running-'));
    originalStateDir = process.env.AGENT_HANDOFF_STATE_DIR;
    process.env.AGENT_HANDOFF_STATE_DIR = stateRoot;
  });

  afterAll(() => {
    if (originalStateDir === undefined) delete process.env.AGENT_HANDOFF_STATE_DIR;
    else process.env.AGENT_HANDOFF_STATE_DIR = originalStateDir;
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it('mark → list → cancel signals the live child', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore', detached: false });
    expect(child.pid).toBeDefined();
    const pid = child.pid!;
    try {
      markRunning(ws(), 'cancel-me', 'codex', pid);

      const entry = readRunning(ws(), 'cancel-me', 'codex');
      expect(entry?.pid).toBe(pid);
      expect(entry?.topic).toBe('cancel-me');
      expect(entry?.agent).toBe('codex');
      expect(entry?.run_id).toBe(`pid-${pid}`);

      const listed = listRunning(ws());
      expect(listed.find((r) => r.topic === 'cancel-me')?.pid).toBe(pid);

      const result = cancelRunning(ws(), 'cancel-me', 'codex', 'SIGTERM');
      expect(result.delivered).toBe(true);
      expect(result.pid).toBe(pid);

      // Wait for the child to exit.
      await new Promise<void>((resolve) => {
        if (child.killed || child.exitCode !== null) return resolve();
        child.on('exit', () => resolve());
      });
      expect(pidIsAlive(pid)).toBe(false);
    } finally {
      try {
        if (!child.killed) child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
      clearRunning(ws(), 'cancel-me', 'codex');
    }
  });

  it('keeps parallel runs for the same topic and agent separate by run_id', () => {
    markRunning(ws(), 'parallel-topic', 'codex', process.pid, { runId: 'run-a' });
    markRunning(ws(), 'parallel-topic', 'codex', process.pid, { runId: 'run-b' });

    const entries = listRunning(ws()).filter(
      (entry) => entry.topic === 'parallel-topic' && entry.agent === 'codex'
    );
    expect(entries.map((entry) => entry.run_id).sort()).toEqual(['run-a', 'run-b']);
    expect(readRunning(ws(), 'parallel-topic', 'codex')).toBeNull();
    expect(readRunning(ws(), 'parallel-topic', 'codex', { runId: 'run-a' })?.run_id).toBe('run-a');

    clearRunning(ws(), 'parallel-topic', 'codex', { runId: 'run-a' });
    expect(readRunning(ws(), 'parallel-topic', 'codex')?.run_id).toBe('run-b');
    clearRunning(ws(), 'parallel-topic', 'codex', { runId: 'run-b' });
  });

  it('listRunning cleans up files whose pids are dead (writer crashed before clearRunning)', () => {
    // Spawn-then-wait-for-exit so we have a guaranteed-dead pid number.
    const result = spawnSync('sleep', ['0.05']);
    const deadPid = result.pid;
    expect(deadPid).toBeGreaterThan(0);
    // Give the kernel a beat to reap.
    const start = Date.now();
    while (pidIsAlive(deadPid!) && Date.now() - start < 1000) {
      // busy-wait briefly; sleep 0.05 should already be gone
    }
    expect(pidIsAlive(deadPid!)).toBe(false);

    markRunning(ws(), 'stale-pid-topic', 'claude', deadPid!);
    const dir = join(stateRoot, 'running', ws().dirName);
    expect(readdirSync(dir).some((n) => n.startsWith('stale-pid-topic--'))).toBe(true);

    const listed = listRunning(ws());
    expect(listed.find((r) => r.topic === 'stale-pid-topic')).toBeUndefined();
    expect(readdirSync(dir).some((n) => n.startsWith('stale-pid-topic--'))).toBe(false);
  });

  it('cancelRunning returns delivered=false when no entry exists', () => {
    const result = cancelRunning(ws(), 'never-ran', 'codex');
    expect(result.delivered).toBe(false);
    expect(result.pid).toBeNull();
  });

  it('rejects malformed running files (schema_version mismatch)', () => {
    const dir = join(stateRoot, 'running', ws().dirName);
    const malformed = join(dir, 'bogus--codex.json');
    new AtomicFile(malformed).writeJson({ schema_version: 999, pid: 1 }, 2);
    expect(existsSync(malformed)).toBe(true);
    const entry = readRunning(ws(), 'bogus', 'codex');
    expect(entry).toBeNull();
  });
});
