/**
 * `trimActiveHistories` retention — opt-in trim of long history.jsonl.
 *
 * The default behavior of `handoff prune` does NOT trim active histories;
 * users opt in via `handoff prune --history-keep N`. This pin covers
 * the keep-last-N semantics, the no-op short-circuit when a file is
 * already small enough, and the multi-topic case.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTopic, recordInvocation, trimActiveHistories } from '../lib/registry.ts';
import type { WorkspaceInfo } from '../lib/workspace.ts';

let stateRoot: string;
let originalStateDir: string | undefined;

function ws(): WorkspaceInfo {
  return {
    resolvedRoot: '/tmp/trim-test',
    basename: 'trim',
    hash: 'trimtest0aaaa',
    dirName: 'trim-trimtest0aaaa',
    fromGit: false,
    aliased: false,
    gitProbe: 'not-a-repo',
  };
}

async function rounds(topic: string, n: number) {
  await createTopic({
    workspace: ws(),
    topic,
    agent: 'codex',
    mode: 'consult',
    summary: null,
    initialSessionId: null,
  });
  for (let i = 0; i < n - 1; i++) {
    await recordInvocation({
      workspace: ws(),
      topic,
      agent: 'codex',
      mode: 'consult',
      sessionId: undefined,
      verdict: 'ok',
      durationMs: 1,
    });
  }
}

describe('trimActiveHistories', () => {
  beforeAll(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'agent-handoff-trim-'));
    originalStateDir = process.env.AGENT_HANDOFF_STATE_DIR;
    process.env.AGENT_HANDOFF_STATE_DIR = stateRoot;
  });

  afterAll(() => {
    if (originalStateDir === undefined) delete process.env.AGENT_HANDOFF_STATE_DIR;
    else process.env.AGENT_HANDOFF_STATE_DIR = originalStateDir;
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it('keeps only the last N events for each topic', async () => {
    await rounds('chatty-topic', 12);
    const { trimmed } = await trimActiveHistories(ws(), 5);
    expect(trimmed.length).toBe(1);
    expect(trimmed[0]).toMatchObject({ topic: 'chatty-topic', kept: 5, removed: 7 });

    const path = join(
      stateRoot,
      'sessions',
      ws().dirName,
      'chatty-topic.history.jsonl'
    );
    const lines = readFileSync(path, 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(5);
    // The kept lines should be the *last* N — verify by parsing the
    // last entry's round number.
    const last = JSON.parse(lines[lines.length - 1]!) as { round?: number };
    expect(last.round).toBe(12);
  });

  it('no-op when history is already shorter than keep', async () => {
    await rounds('quiet-topic', 3);
    const { trimmed } = await trimActiveHistories(ws(), 100);
    // `chatty-topic` from prior test is now at 5 lines (already trimmed
    // and ≤ 100). `quiet-topic` is at 3 lines. Neither should re-trim.
    expect(trimmed.length).toBe(0);
  });

  it('rejects non-positive keepLast', async () => {
    await expect(trimActiveHistories(ws(), 0)).rejects.toThrow(/keepLast/);
    await expect(trimActiveHistories(ws(), -3)).rejects.toThrow(/keepLast/);
  });
});
