/**
 * Workspace key derivation regression tests.
 *
 * Pins the load-bearing invariant codex caught: linked git worktrees of
 * the same repo MUST share the same workspace key. Earlier impl used
 * `--show-toplevel`, which diverges per worktree and fragments the
 * registry across them; current impl uses `--git-common-dir`.
 *
 * Test creates a real git repo + linked worktree on a tmp dir, calls
 * `resolveWorkspace` from each, asserts identical hashes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspace } from '../lib/workspace.ts';

let tmpRoot: string;
let mainRepo: string;
let worktreeDir: string;

function git(cwd: string, ...args: string[]): { code: number | null; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout };
}

describe('resolveWorkspace — git-common-dir derivation', () => {
  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'agent-handoff-ws-'));
    mainRepo = join(tmpRoot, 'main');
    worktreeDir = join(tmpRoot, 'wt-feature');

    spawnSync('git', ['init', '-q', mainRepo]);
    git(mainRepo, 'config', 'user.email', 'test@test');
    git(mainRepo, 'config', 'user.name', 'test');
    git(mainRepo, 'commit', '--allow-empty', '-q', '-m', 'init');
    git(mainRepo, 'worktree', 'add', '-q', '-b', 'feature', worktreeDir);
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('main repo and linked worktree share the same workspace hash', () => {
    const fromMain = resolveWorkspace(mainRepo);
    const fromWt = resolveWorkspace(worktreeDir);

    expect(fromMain.fromGit).toBe(true);
    expect(fromWt.fromGit).toBe(true);
    expect(fromMain.hash).toBe(fromWt.hash);
    expect(fromMain.dirName).toBe(fromWt.dirName);
    expect(fromMain.resolvedRoot).toBe(fromWt.resolvedRoot);
  });

  it('subdirectory of a worktree resolves to the same key as its toplevel', () => {
    const sub = join(worktreeDir);
    const fromTop = resolveWorkspace(mainRepo);
    const fromSub = resolveWorkspace(sub);
    expect(fromTop.hash).toBe(fromSub.hash);
  });

  it('outside any repo, falls back to realpath cwd', () => {
    const ws = resolveWorkspace(tmpRoot);
    // tmpRoot itself is not a git repo (only main/ and wt-feature/ are)
    expect(ws.fromGit).toBe(false);
    expect(ws.resolvedRoot.includes(tmpRoot.replace(/^\/private/, ''))).toBe(true);
  });
});
