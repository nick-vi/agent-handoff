/**
 * Multi-workspace parallel stress test.
 *
 * Models the realistic scenario the user posed: 4 worktrees, each
 * orchestrating multiple agents against multiple topics, all in flight
 * at the same time. Worktrees are isolated by workspace hash so cross-
 * worktree calls should have zero contention; within a worktree, each
 * topic has its own lock so cross-topic calls in the same worktree
 * should also be contention-free; within a topic, sequential
 * serialization is the load-bearing guarantee.
 *
 * Test setup:
 *   - 4 fake "workspace roots" (real tmp dirs, not git repos)
 *   - 3 topics per workspace = 12 topics total
 *   - 8 parallel `recordInvocation` calls per topic = 96 mutations
 *   - All 96 fire simultaneously
 *
 * Pass condition:
 *   - Each topic ends with `round_count = 9` (1 from create + 8 records)
 *   - Each history.jsonl has exactly 9 lines
 *   - No lost updates, no torn writes, no exceptions
 *
 * The state dir is redirected via `AGENT_HANDOFF_STATE_DIR` so the test
 * doesn't pollute the user's real `~/.local/share/agent-handoff`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTopic, listTopics, loadSnapshot, recordInvocation } from '../lib/registry.ts';
import type { WorkspaceInfo } from '../lib/workspace.ts';

const NUM_WORKSPACES = 4;
const TOPICS_PER_WORKSPACE = 3;
const PARALLEL_PER_TOPIC = 8;

let stateRoot: string;
let workspaceRoots: string[] = [];
let originalStateDir: string | undefined;

function makeWorkspace(root: string, hash: string): WorkspaceInfo {
  return {
    resolvedRoot: root,
    basename: hash.slice(0, 8),
    hash,
    dirName: `${hash.slice(0, 8)}-${hash}`,
    fromGit: false,
    aliased: false,
    gitProbe: 'not-a-repo',
  };
}

describe('multi-workspace parallel stress', () => {
  beforeAll(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'agent-handoff-multi-state-'));
    originalStateDir = process.env.AGENT_HANDOFF_STATE_DIR;
    process.env.AGENT_HANDOFF_STATE_DIR = stateRoot;

    // Synthesize four workspace roots (no git, no shared state) and
    // pre-fabricate distinct workspace hashes per dir.
    for (let i = 0; i < NUM_WORKSPACES; i++) {
      const root = mkdtempSync(join(tmpdir(), `agent-handoff-multi-ws${i}-`));
      mkdirSync(root, { recursive: true });
      workspaceRoots.push(root);
    }
  });

  afterAll(() => {
    if (originalStateDir === undefined) {
      delete process.env.AGENT_HANDOFF_STATE_DIR;
    } else {
      process.env.AGENT_HANDOFF_STATE_DIR = originalStateDir;
    }
    rmSync(stateRoot, { recursive: true, force: true });
    for (const root of workspaceRoots) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* swallow; tmp dir cleanup is best-effort */
      }
    }
  });

  it(
    'survives 4 workspaces × 3 topics × 8 parallel records (96 mutations)',
    async () => {
      const workspaces = workspaceRoots.map((root, i) =>
        makeWorkspace(root, `wstest${i.toString().padStart(2, '0')}aaaa`.slice(0, 12))
      );

      type Plan = { ws: WorkspaceInfo; topic: string; agent: 'codex' | 'claude' | 'cursor' };
      const plans: Plan[] = [];
      for (const ws of workspaces) {
        for (let t = 0; t < TOPICS_PER_WORKSPACE; t++) {
          plans.push({
            ws,
            topic: `topic-${ws.hash.slice(0, 6)}-${t}`,
            agent: t === 0 ? 'codex' : t === 1 ? 'claude' : 'cursor',
          });
        }
      }

      // Phase 1: create each topic exactly once, in parallel across all
      // (workspace, topic) pairs. Each call hits its own lock dir so
      // there's no cross-pair contention.
      await Promise.all(
        plans.map((p) =>
          createTopic({
            workspace: p.ws,
            topic: p.topic,
            agent: p.agent,
            mode: 'consult',
            summary: `stress test ${p.topic}`,
            initialSessionId: null,
          })
        )
      );

      // Phase 2: PARALLEL_PER_TOPIC simultaneous recordInvocation calls
      // per topic, all topics fired at once. Within a topic, the lock
      // must serialize. Across topics, no contention. Across workspaces,
      // also no contention.
      const recordTasks: Promise<unknown>[] = [];
      for (const p of plans) {
        for (let i = 0; i < PARALLEL_PER_TOPIC; i++) {
          recordTasks.push(
            recordInvocation({
              workspace: p.ws,
              topic: p.topic,
              agent: p.agent,
              mode: 'consult',
              sessionId: `019df000-${i.toString().padStart(4, '0')}-7000-aaaa-${p.topic
                .slice(-12)
                .padEnd(12, '0')
                .replace(/[^0-9a-f]/g, '0')}`,
              verdict: 'ok',
              durationMs: 10 + i,
            })
          );
        }
      }
      await Promise.all(recordTasks);

      // Verify each topic's final state.
      for (const p of plans) {
        const snap = loadSnapshot(p.ws, p.topic);
        expect(snap).not.toBeNull();
        expect(snap?.round_count).toBe(1 + PARALLEL_PER_TOPIC);

        // History line count = 1 (created) + PARALLEL_PER_TOPIC (invocations)
        const historyPath = join(
          stateRoot,
          'sessions',
          p.ws.dirName,
          `${p.topic}.history.jsonl`
        );
        const lines = readFileSync(historyPath, 'utf-8')
          .split('\n')
          .filter((l) => l.length > 0);
        expect(lines.length).toBe(1 + PARALLEL_PER_TOPIC);

        // Round numbers in invocation events should be exactly 2..9
        // (round 1 was the `created` event). Any order is acceptable
        // because lock acquisition order isn't deterministic.
        const invocationRounds: number[] = [];
        for (const line of lines) {
          const obj = JSON.parse(line);
          if (obj.kind === 'invocation') invocationRounds.push(obj.round);
        }
        invocationRounds.sort((a, b) => a - b);
        expect(invocationRounds).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
      }

      // Cross-workspace check: each workspace dir contains exactly its
      // 3 topic snapshots (no leakage between workspaces).
      for (const ws of workspaces) {
        const topics = listTopics(ws);
        expect(topics.length).toBe(TOPICS_PER_WORKSPACE);
      }
    },
    60_000
  );
});
