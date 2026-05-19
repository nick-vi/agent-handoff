/**
 * Trace storage tests. Pins layout (`traces/<topic>/<round>-<agent>.json`),
 * round-ordering on read, and 0600 perms inherited from AtomicFile.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTraces, traceFilePath, writeTrace } from '../lib/trace.ts';
import type { WorkspaceInfo } from '../lib/workspace.ts';

let stateRoot: string;
let originalStateDir: string | undefined;

const ws: WorkspaceInfo = {
  resolvedRoot: '/tmp/fake',
  basename: 'fake',
  hash: 'abcdef012345',
  dirName: 'fake-abcdef012345',
  fromGit: false,
  aliased: false,
  gitProbe: 'not-a-repo',
};

describe('trace storage', () => {
  beforeAll(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'agent-handoff-trace-'));
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

  it('writes a trace file at the expected path', () => {
    writeTrace(ws, {
      schema_version: 1,
      topic: 'demo-topic',
      agent: 'codex',
      mode: 'consult',
      round: 1,
      ts: '2026-05-01T12:00:00.000Z',
      prompt: 'design X',
      output: 'design Y',
      session_id: '019dd000-aaaa-7000-bbbb-cccccccccccc',
      verdict: 'advisory',
      duration_ms: 1234,
    });

    const path = traceFilePath(ws, 'demo-topic', 1, 'codex');
    const contents = JSON.parse(readFileSync(path, 'utf-8'));
    expect(contents.prompt).toBe('design X');
    expect(contents.output).toBe('design Y');
    expect(contents.round).toBe(1);
    expect(contents.agent).toBe('codex');

    // 0600 perms (single-user-only)
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('rounds sort by numeric round, not lexical filename', () => {
    for (const r of [1, 2, 10, 11]) {
      writeTrace(ws, {
        schema_version: 1,
        topic: 'sort-topic',
        agent: 'claude',
        mode: 'consult',
        round: r,
        ts: '2026-05-01T12:00:00.000Z',
        prompt: `p${r}`,
        output: `o${r}`,
        session_id: null,
        verdict: 'advisory',
        duration_ms: null,
      });
    }
    const traces = readTraces(ws, 'sort-topic');
    expect(traces.map((t) => t.round)).toEqual([1, 2, 10, 11]);
  });

  it('returns empty array when topic has no traces', () => {
    const traces = readTraces(ws, 'never-traced-topic');
    expect(traces).toEqual([]);
  });

  it('zero-pads filenames so `ls` is naturally ordered', () => {
    const path = traceFilePath(ws, 'pad-topic', 7, 'cursor');
    expect(path).toMatch(/000007-cursor\.json$/);
  });
});
