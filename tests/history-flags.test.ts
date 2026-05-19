/**
 * `handoff history` filter flags — `--no-tools`, `--skip-system`, `--stats`.
 *
 * Drives the actual CLI binary against a fixture cursor `store.db` so
 * the test exercises argv parsing, the dispatch flow, and the filter
 * predicates end-to-end. Cursor was chosen because we have a real
 * fixture committed; claude/codex would require larger fixtures.
 */

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspace } from '../lib/workspace.ts';

const HANDOFF = join(__dirname, '..', 'bin', 'agent-handoff.ts');
const FIXTURE = join(__dirname, 'fixtures', 'cursor-store-sample.db');
const SESSION_ID = 'd62a9493-a670-42a8-8cae-d6c7c02e21ef';

function setupWorkspace(topic: string): {
  stateRoot: string;
  fakeHome: string;
  workspaceCwd: string;
  cleanup: () => void;
} {
  // Three temp dirs: one for AGENT_HANDOFF_STATE_DIR (handoff's own state),
  // one for HOME so cursor's resolver finds our fixture under
  // <fakeHome>/.cursor/chats/<ws-hash>/<session-id>/store.db, and one
  // for the handoff --workspace cwd so resolveWorkspace gives us a
  // deterministic non-git-repo dirName we can write the snapshot
  // under.
  const stateRoot = mkdtempSync(join(tmpdir(), 'agent-handoff-history-flags-state-'));
  const fakeHome = mkdtempSync(join(tmpdir(), 'agent-handoff-history-flags-home-'));
  const workspaceCwd = mkdtempSync(join(tmpdir(), 'agent-handoff-history-flags-ws-'));

  const cursorDir = join(fakeHome, '.cursor', 'chats', 'fake-workspace-hash', SESSION_ID);
  mkdirSync(cursorDir, { recursive: true });
  copyFileSync(FIXTURE, join(cursorDir, 'store.db'));

  // Ask the production resolver where it'd put state for this cwd, so
  // the snapshot lands somewhere `handoff history` will actually look.
  const ws = resolveWorkspace(workspaceCwd);
  const snap = {
    schema_version: 1,
    topic,
    summary: null,
    workspace: {
      resolvedRoot: ws.resolvedRoot,
      basename: ws.basename,
      hash: ws.hash,
      fromGit: ws.fromGit,
    },
    sessions: { cursor: SESSION_ID },
    round_count: 1,
    created_at: new Date().toISOString(),
    last_used_at: new Date().toISOString(),
  };
  const wsDir = join(stateRoot, 'sessions', ws.dirName);
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(join(wsDir, `${topic}.json`), JSON.stringify(snap, null, 2));

  return {
    stateRoot,
    fakeHome,
    workspaceCwd,
    cleanup: () => {
      rmSync(stateRoot, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(workspaceCwd, { recursive: true, force: true });
    },
  };
}

function handoff(
  argv: string[],
  env: Record<string, string>
): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bun', [HANDOFF, ...argv], {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 8000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('handoff history filter flags', () => {
  // Each test sets up its own workspace so they don't share state.
  it('--stats prints role counts (no per-turn output)', () => {
    const ws = setupWorkspace('cursor-stats');
    try {
      const r = handoff(
        ['history', 'cursor-stats', '--stats', '--workspace', ws.workspaceCwd],
        { AGENT_HANDOFF_STATE_DIR: ws.stateRoot, HOME: ws.fakeHome }
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('turns: 6');
      expect(r.stdout).toMatch(/system\s+1/);
      expect(r.stdout).toMatch(/user\s+3/);
      expect(r.stdout).toMatch(/assistant\s+2/);
      // No turn output line should leak through.
      expect(r.stdout).not.toContain('say hi briefly');
    } finally {
      ws.cleanup();
    }
  });

  it('--skip-system drops system + <user_info> envelope turns', () => {
    const ws = setupWorkspace('cursor-skip');
    try {
      const baseline = handoff(
        ['history', 'cursor-skip', '--workspace', ws.workspaceCwd],
        { AGENT_HANDOFF_STATE_DIR: ws.stateRoot, HOME: ws.fakeHome }
      );
      const filtered = handoff(
        ['history', 'cursor-skip', '--skip-system', '--workspace', ws.workspaceCwd],
        { AGENT_HANDOFF_STATE_DIR: ws.stateRoot, HOME: ws.fakeHome }
      );
      expect(baseline.code).toBe(0);
      expect(filtered.code).toBe(0);
      // baseline contains the system prompt body; filtered should not.
      expect(baseline.stdout).toContain('AI coding assistant');
      expect(filtered.stdout).not.toContain('AI coding assistant');
      // baseline contains the <user_info> envelope; filtered should not.
      expect(baseline.stdout).toContain('<user_info>');
      expect(filtered.stdout).not.toContain('<user_info>');
      // The actual queries survive.
      expect(filtered.stdout).toContain('say hi briefly');
    } finally {
      ws.cleanup();
    }
  });

  it('--no-tools is a no-op for cursor (no tool_call rows) but does not error', () => {
    const ws = setupWorkspace('cursor-notools');
    try {
      const r = handoff(
        ['history', 'cursor-notools', '--no-tools', '--workspace', ws.workspaceCwd],
        { AGENT_HANDOFF_STATE_DIR: ws.stateRoot, HOME: ws.fakeHome }
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('say hi briefly');
    } finally {
      ws.cleanup();
    }
  });

  it('fixture exists', () => {
    expect(existsSync(FIXTURE)).toBe(true);
  });
});
