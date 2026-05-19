/**
 * Plan storage + injection tests.
 *
 * Pins:
 *   - read/write path layout
 *   - 0600 perms
 *   - composePromptWithPlan provenance header (load-bearing for the
 *     stale-context safety guarantee codex flagged)
 *   - snapshot only on content change (sha256 short-circuit)
 *   - history listing in numeric round order
 *   - age formatter buckets
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  composePromptWithPlan,
  formatAge,
  listPlanHistoryRounds,
  planPath,
  readPlan,
  readPlanSnapshot,
  snapshotPlanIfChanged,
  writePlan,
} from '../lib/plan.ts';
import type { WorkspaceInfo } from '../lib/workspace.ts';

let stateRoot: string;
let originalStateDir: string | undefined;

const ws: WorkspaceInfo = {
  resolvedRoot: '/tmp/fake',
  basename: 'fake',
  hash: '012345abcdef',
  dirName: 'fake-012345abcdef',
  fromGit: false,
  aliased: false,
  gitProbe: 'not-a-repo',
};

describe('plan storage', () => {
  beforeAll(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'agent-handoff-plan-'));
    originalStateDir = process.env.AGENT_HANDOFF_STATE_DIR;
    process.env.AGENT_HANDOFF_STATE_DIR = stateRoot;
  });

  afterAll(() => {
    if (originalStateDir === undefined) {
      delete process.env.AGENT_HANDOFF_STATE_DIR;
    } else {
      process.env.AGENT_HANDOFF_STATE_DIR = originalStateDir;
    }
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it('read returns null content when plan does not exist', () => {
    const state = readPlan(ws, 'never-written-topic');
    expect(state.content).toBeNull();
    expect(state.lastModified).toBeNull();
    expect(state.contentHash).toBeNull();
    expect(state.path).toMatch(/never-written-topic\.md$/);
  });

  it('write persists with 0600 perms; read round-trips content', () => {
    writePlan(ws, 'plan-rw-test', 'objective: ship the thing\nscope: only X\n');
    const state = readPlan(ws, 'plan-rw-test');
    expect(state.content).toBe('objective: ship the thing\nscope: only X\n');
    expect(state.lastModified).toBeInstanceOf(Date);
    expect(state.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const mode = statSync(planPath(ws, 'plan-rw-test')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('compose injects header + body + footer when plan exists', () => {
    writePlan(ws, 'compose-test', 'do X then Y');
    const fixedNow = new Date();
    const composed = composePromptWithPlan(ws, 'compose-test', 'round 2: address Z', fixedNow);
    expect(composed.injection).not.toBeNull();
    expect(composed.injection?.sizeBytes).toBe('do X then Y'.length);
    expect(composed.prompt).toContain('## handoff plan: compose-test');
    expect(composed.prompt).toContain('do X then Y');
    expect(composed.prompt).toContain('## end handoff plan');
    expect(composed.prompt).toContain('round 2: address Z');
    // Header must come before the user prompt.
    const headerIdx = composed.prompt.indexOf('## handoff plan');
    const userIdx = composed.prompt.indexOf('round 2: address Z');
    expect(headerIdx).toBeLessThan(userIdx);
  });

  it('header marker does NOT start with `--` (codex argv-parser would reject)', () => {
    // Regression pin: an earlier draft used `--- handoff plan ---` as
    // the header. Codex's argv parser treats a positional arg
    // starting with `--` as a flag attempt and exits immediately
    // (~10ms); the agent never runs. Markdown `##` is benign.
    writePlan(ws, 'argv-safety-test', 'plan body');
    const composed = composePromptWithPlan(ws, 'argv-safety-test', 'do thing');
    const firstLine = composed.prompt.split('\n')[0]!;
    expect(firstLine.startsWith('--')).toBe(false);
    expect(firstLine.startsWith('##')).toBe(true);
  });

  it('compose returns prompt unchanged + injection=null when no plan', () => {
    const composed = composePromptWithPlan(ws, 'no-plan-here', 'just my prompt');
    expect(composed.prompt).toBe('just my prompt');
    expect(composed.injection).toBeNull();
  });

  it('snapshot writes new file when plan differs from last snapshot', () => {
    writePlan(ws, 'snap-test', 'v1');
    const r1 = snapshotPlanIfChanged(ws, 'snap-test', 1);
    expect(r1.snapshotted).toBe(true);

    // No content change → no new snapshot.
    const r2 = snapshotPlanIfChanged(ws, 'snap-test', 2);
    expect(r2.snapshotted).toBe(false);

    // Change content → new snapshot.
    writePlan(ws, 'snap-test', 'v2');
    const r3 = snapshotPlanIfChanged(ws, 'snap-test', 3);
    expect(r3.snapshotted).toBe(true);

    // Change back to v1 → still a new snapshot (content differs from
    // last, even though it matches an earlier one). This is fine —
    // history is a sequence, not a set.
    writePlan(ws, 'snap-test', 'v1');
    const r4 = snapshotPlanIfChanged(ws, 'snap-test', 4);
    expect(r4.snapshotted).toBe(true);

    expect(listPlanHistoryRounds(ws, 'snap-test')).toEqual([1, 3, 4]);
    expect(readPlanSnapshot(ws, 'snap-test', 1)).toBe('v1');
    expect(readPlanSnapshot(ws, 'snap-test', 3)).toBe('v2');
    expect(readPlanSnapshot(ws, 'snap-test', 4)).toBe('v1');
  });

  it('snapshot is no-op when no plan exists', () => {
    const result = snapshotPlanIfChanged(ws, 'no-plan-snap', 1);
    expect(result.snapshotted).toBe(false);
    expect(result.path).toBeNull();
  });

  it('history listing is numeric, ascending', () => {
    // Create snapshots out of round order to verify sort.
    writePlan(ws, 'sort-history', 'a');
    snapshotPlanIfChanged(ws, 'sort-history', 1);
    writePlan(ws, 'sort-history', 'b');
    snapshotPlanIfChanged(ws, 'sort-history', 11);
    writePlan(ws, 'sort-history', 'c');
    snapshotPlanIfChanged(ws, 'sort-history', 2);
    writePlan(ws, 'sort-history', 'd');
    snapshotPlanIfChanged(ws, 'sort-history', 100);
    expect(listPlanHistoryRounds(ws, 'sort-history')).toEqual([1, 2, 11, 100]);
  });
});

describe('formatAge', () => {
  const base = new Date('2026-05-01T12:00:00Z');

  it('just now under 60s', () => {
    expect(formatAge(new Date(base.getTime() - 30_000), base)).toBe('just now');
  });

  it('minutes', () => {
    expect(formatAge(new Date(base.getTime() - 5 * 60_000), base)).toBe('5m ago');
  });

  it('hours', () => {
    expect(formatAge(new Date(base.getTime() - 3 * 3_600_000), base)).toBe('3h ago');
  });

  it('days', () => {
    expect(formatAge(new Date(base.getTime() - 4 * 86_400_000), base)).toBe('4d ago');
  });

  it('weeks', () => {
    expect(formatAge(new Date(base.getTime() - 14 * 86_400_000), base)).toBe('2w ago');
  });
});
