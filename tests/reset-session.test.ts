/**
 * `resetSession` correctness:
 *   - Throws TopicNotFoundError on missing topic
 *   - Nulls the right (topic, agent) slot, leaves siblings alone
 *   - Idempotent — second call returns null without history line
 *   - Appends a `session_reset` event to history
 *   - Does NOT increment round_count (reset is bookkeeping, not a round)
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTopic,
  loadSnapshot,
  recordInvocation,
  resetSession,
  TopicNotFoundError,
} from '../lib/registry.ts';
import type { WorkspaceInfo } from '../lib/workspace.ts';

let stateRoot: string;
let originalStateDir: string | undefined;

function ws(): WorkspaceInfo {
  return {
    resolvedRoot: '/tmp/reset-test',
    basename: 'resettest',
    hash: 'reset0000aaaa',
    dirName: 'resettest-reset0000aaaa',
    fromGit: false,
    aliased: false,
    gitProbe: 'not-a-repo',
  };
}

describe('resetSession', () => {
  beforeAll(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'agent-handoff-reset-test-'));
    originalStateDir = process.env.AGENT_HANDOFF_STATE_DIR;
    process.env.AGENT_HANDOFF_STATE_DIR = stateRoot;
  });

  afterAll(() => {
    if (originalStateDir === undefined) delete process.env.AGENT_HANDOFF_STATE_DIR;
    else process.env.AGENT_HANDOFF_STATE_DIR = originalStateDir;
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it('throws TopicNotFoundError on missing topic', async () => {
    await expect(resetSession(ws(), 'never-existed', 'codex', 'manual')).rejects.toBeInstanceOf(
      TopicNotFoundError
    );
  });

  it('nulls the agent session, leaves siblings alone, preserves round count', async () => {
    const w = ws();
    await createTopic({
      workspace: w,
      topic: 'reset-target',
      agent: 'codex',
      mode: 'consult',
      summary: null,
      initialSessionId: '019ddead-1111-7000-aaaa-cccccccccccc',
    });
    await recordInvocation({
      workspace: w,
      topic: 'reset-target',
      agent: 'claude',
      mode: 'consult',
      sessionId: '019ddead-2222-7000-bbbb-cccccccccccc',
      verdict: 'ok',
      durationMs: 100,
    });

    const before = loadSnapshot(w, 'reset-target');
    expect(before?.sessions.codex).toBe('019ddead-1111-7000-aaaa-cccccccccccc');
    expect(before?.sessions.claude).toBe('019ddead-2222-7000-bbbb-cccccccccccc');
    expect(before?.round_count).toBe(2);

    const result = await resetSession(w, 'reset-target', 'codex', 'expired');
    expect(result.previousSessionId).toBe('019ddead-1111-7000-aaaa-cccccccccccc');

    const after = loadSnapshot(w, 'reset-target');
    expect(after?.sessions.codex ?? null).toBeNull();
    expect(after?.sessions.claude).toBe('019ddead-2222-7000-bbbb-cccccccccccc');
    expect(after?.round_count).toBe(2);

    const historyPath = join(
      stateRoot,
      'sessions',
      w.dirName,
      'reset-target.history.jsonl'
    );
    const lines = readFileSync(historyPath, 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0);
    const lastEvent = JSON.parse(lines[lines.length - 1]!);
    expect(lastEvent.kind).toBe('session_reset');
    expect(lastEvent.agent).toBe('codex');
    expect(lastEvent.reason).toBe('expired');
    expect(lastEvent.previous_session_id).toBe('019ddead-1111-7000-aaaa-cccccccccccc');
  });

  it('is idempotent — second call returns null and writes no event', async () => {
    const w = ws();
    await createTopic({
      workspace: w,
      topic: 'reset-idempotent',
      agent: 'codex',
      mode: 'consult',
      summary: null,
      initialSessionId: '019ddead-3333-7000-aaaa-cccccccccccc',
    });
    await resetSession(w, 'reset-idempotent', 'codex', 'manual');
    const historyPath = join(
      stateRoot,
      'sessions',
      w.dirName,
      'reset-idempotent.history.jsonl'
    );
    const linesBefore = readFileSync(historyPath, 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0);

    const result = await resetSession(w, 'reset-idempotent', 'codex', 'manual');
    expect(result.previousSessionId).toBeNull();

    const linesAfter = readFileSync(historyPath, 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(linesAfter.length).toBe(linesBefore.length);
  });
});
