/**
 * Three-state session merge in `recordInvocation`:
 *   - `string`     → replace
 *   - `null`       → clear
 *   - `undefined`  → preserve prior snapshot value
 *
 * Pinned because adapters that fail to extract a session id pass
 * `undefined`, and a regression to the old `?? prior ?? null` shape
 * would silently revive cleared ids or never refresh dead ones.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTopic, loadSnapshot, recordInvocation } from '../lib/registry.ts';
import type { WorkspaceInfo } from '../lib/workspace.ts';

let stateRoot: string;
let originalStateDir: string | undefined;

function ws(): WorkspaceInfo {
  return {
    resolvedRoot: '/tmp/session-merge-test',
    basename: 'sessmerge',
    hash: 'sessm0000bbbb',
    dirName: 'sessmerge-sessm0000bbbb',
    fromGit: false,
    aliased: false,
    gitProbe: 'not-a-repo',
  };
}

const ID_A = '019ddead-1111-7000-aaaa-cccccccccccc';
const ID_B = '019ddead-2222-7000-bbbb-cccccccccccc';

describe('recordInvocation session merge', () => {
  beforeAll(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'agent-handoff-session-merge-'));
    originalStateDir = process.env.AGENT_HANDOFF_STATE_DIR;
    process.env.AGENT_HANDOFF_STATE_DIR = stateRoot;
  });

  afterAll(() => {
    if (originalStateDir === undefined) delete process.env.AGENT_HANDOFF_STATE_DIR;
    else process.env.AGENT_HANDOFF_STATE_DIR = originalStateDir;
    rmSync(stateRoot, { recursive: true, force: true });
  });

  async function freshTopic(slug: string, initial: string | null) {
    await createTopic({
      workspace: ws(),
      topic: slug,
      agent: 'codex',
      mode: 'consult',
      summary: null,
      initialSessionId: initial,
    });
  }

  it('string sessionId replaces the prior value', async () => {
    await freshTopic('merge-string', ID_A);
    await recordInvocation({
      workspace: ws(),
      topic: 'merge-string',
      agent: 'codex',
      mode: 'consult',
      sessionId: ID_B,
      verdict: 'ok',
      durationMs: 1,
    });
    expect(loadSnapshot(ws(), 'merge-string')?.sessions.codex).toBe(ID_B);
  });

  it('undefined sessionId preserves the prior value (extraction-failure path)', async () => {
    await freshTopic('merge-undef', ID_A);
    await recordInvocation({
      workspace: ws(),
      topic: 'merge-undef',
      agent: 'codex',
      mode: 'consult',
      sessionId: undefined,
      verdict: 'ok',
      durationMs: 1,
    });
    expect(loadSnapshot(ws(), 'merge-undef')?.sessions.codex).toBe(ID_A);
  });

  it('invalid initial sessionId is rejected', async () => {
    await expect(freshTopic('invalid-initial-session', '../../not-a-session')).rejects.toThrow(
      'Invalid codex session id'
    );
  });

  it('invalid replacement sessionId is rejected', async () => {
    await freshTopic('invalid-replacement-session', ID_A);
    await expect(recordInvocation({
      workspace: ws(),
      topic: 'invalid-replacement-session',
      agent: 'codex',
      mode: 'consult',
      sessionId: '../../not-a-session',
      verdict: 'ok',
      durationMs: 1,
    })).rejects.toThrow('Invalid codex session id');
    expect(loadSnapshot(ws(), 'invalid-replacement-session')?.sessions.codex).toBe(ID_A);
  });

  it('null sessionId clears the prior value (adapter knows session is gone)', async () => {
    await freshTopic('merge-null', ID_A);
    await recordInvocation({
      workspace: ws(),
      topic: 'merge-null',
      agent: 'codex',
      mode: 'consult',
      sessionId: null,
      verdict: 'ok',
      durationMs: 1,
    });
    expect(loadSnapshot(ws(), 'merge-null')?.sessions.codex ?? null).toBeNull();
  });

  it('undefined on a slot that was already null stays null', async () => {
    await freshTopic('merge-undef-from-null', null);
    await recordInvocation({
      workspace: ws(),
      topic: 'merge-undef-from-null',
      agent: 'codex',
      mode: 'consult',
      sessionId: undefined,
      verdict: 'ok',
      durationMs: 1,
    });
    expect(loadSnapshot(ws(), 'merge-undef-from-null')?.sessions.codex ?? null).toBeNull();
  });

  it('merging one agent leaves siblings untouched', async () => {
    await freshTopic('merge-siblings', ID_A);
    await recordInvocation({
      workspace: ws(),
      topic: 'merge-siblings',
      agent: 'claude',
      mode: 'consult',
      sessionId: ID_B,
      verdict: 'ok',
      durationMs: 1,
    });
    const snap = loadSnapshot(ws(), 'merge-siblings');
    expect(snap?.sessions.codex).toBe(ID_A);
    expect(snap?.sessions.claude).toBe(ID_B);
  });
});
