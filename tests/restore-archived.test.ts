/**
 * `restoreArchivedTopic` rollback path — covers the data-loss window
 * in `--archive-and-new` where:
 *   1. archiveTopic moves snapshot/history to archive/
 *   2. agent.invoke runs and the brief is sent
 *   3. createTopic fails (lock timeout, FS error, etc.)
 *
 * Without restore, the brief was sent and the topic exists nowhere —
 * neither the old (archived) nor the new (failed-to-create) state can
 * record the round. With restore, the archived state moves back to
 * live so a retry sees the same topic the user expected.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  archiveTopic,
  createTopic,
  restoreArchivedTopic,
} from '../lib/registry.ts';
import { writePlan } from '../lib/plan.ts';
import type { WorkspaceInfo } from '../lib/workspace.ts';

let stateRoot: string;
let originalStateDir: string | undefined;

function ws(): WorkspaceInfo {
  return {
    resolvedRoot: '/tmp/restore-arch-test',
    basename: 'restore',
    hash: 'restore0aaaaa',
    dirName: 'restore-restore0aaaaa',
    fromGit: false,
    aliased: false,
    gitProbe: 'not-a-repo',
  };
}

describe('restoreArchivedTopic', () => {
  beforeAll(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'agent-handoff-restore-'));
    originalStateDir = process.env.AGENT_HANDOFF_STATE_DIR;
    process.env.AGENT_HANDOFF_STATE_DIR = stateRoot;
  });

  afterAll(() => {
    if (originalStateDir === undefined) delete process.env.AGENT_HANDOFF_STATE_DIR;
    else process.env.AGENT_HANDOFF_STATE_DIR = originalStateDir;
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it('moves snapshot, history, and plan back to live paths', async () => {
    const w = ws();
    await createTopic({
      workspace: w,
      topic: 'roll-back-me',
      agent: 'codex',
      mode: 'consult',
      summary: 'pre-archive summary',
      initialSessionId: '019ddead-1111-7000-aaaa-cccccccccccc',
    });
    writePlan(w, 'roll-back-me', '# plan body before archive\n');

    const arch = await archiveTopic(w, 'roll-back-me', 'archive_and_new');
    expect(existsSync(arch.liveSnapshot)).toBe(false);
    expect(existsSync(arch.archivedSnapshot)).toBe(true);
    expect(arch.archivedPlan).not.toBeNull();
    expect(existsSync(arch.archivedPlan!)).toBe(true);

    restoreArchivedTopic(arch);

    expect(existsSync(arch.liveSnapshot)).toBe(true);
    expect(existsSync(arch.liveHistory)).toBe(true);
    expect(existsSync(arch.livePlan)).toBe(true);
    expect(existsSync(arch.archivedSnapshot)).toBe(false);
    expect(existsSync(arch.archivedHistory)).toBe(false);

    // The trailing `archived` event archiveTopic appended must be
    // stripped — otherwise readers see a phantom archive while the
    // topic is live again.
    const lines = readFileSync(arch.liveHistory, 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0);
    for (const line of lines) {
      const ev = JSON.parse(line) as { kind?: string };
      expect(ev.kind).not.toBe('archived');
    }
  });

  it('handles topics that had no plan (only snapshot + history)', async () => {
    const w = ws();
    await createTopic({
      workspace: w,
      topic: 'no-plan-topic',
      agent: 'codex',
      mode: 'review',
      summary: null,
      initialSessionId: null,
    });
    const arch = await archiveTopic(w, 'no-plan-topic', 'archive_and_new');
    expect(arch.archivedPlan).toBeNull();

    restoreArchivedTopic(arch);

    expect(existsSync(arch.liveSnapshot)).toBe(true);
    expect(existsSync(arch.archivedSnapshot)).toBe(false);
  });
});
