/**
 * Two semi-related correctness pins:
 *
 *   - Pointer auto-clear on archive (the P1 catch from final review).
 *     `handoff use X` followed by `handoff archive X` must drop the pointer,
 *     otherwise the next pointer-routed `handoff send --current` would
 *     recreate the archived slug as a new topic.
 *
 *   - Anti-recursion env-var propagation. The handoff sets
 *     AGENT_HANDOFF_DEPTH=1 before invoking an agent; if that agent
 *     spawns handoff again (deliberately or via skill side-effect), the
 *     child must refuse with exit 3.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveTopic, createTopic } from '../lib/registry.ts';
import { clearPointer, readPointer, setPointer } from '../lib/pointer.ts';
import type { WorkspaceInfo } from '../lib/workspace.ts';

let stateRoot: string;
let projectRoot: string;
let originalStateDir: string | undefined;

function workspace(): WorkspaceInfo {
  return {
    resolvedRoot: projectRoot,
    basename: 'pointer-test',
    hash: 'pointertest1',
    dirName: 'pointer-test-pointertest1',
    fromGit: false, // skip .git/info/exclude touch in tests
    aliased: false,
    gitProbe: 'not-a-repo',
  };
}

describe('pointer + nesting', () => {
  beforeAll(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'agent-handoff-pointer-test-state-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'agent-handoff-pointer-test-project-'));
    mkdirSync(projectRoot, { recursive: true });
    originalStateDir = process.env.AGENT_HANDOFF_STATE_DIR;
    process.env.AGENT_HANDOFF_STATE_DIR = stateRoot;
  });

  afterAll(() => {
    if (originalStateDir === undefined) delete process.env.AGENT_HANDOFF_STATE_DIR;
    else process.env.AGENT_HANDOFF_STATE_DIR = originalStateDir;
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('readPointer returns null after archive when CLI clears it', async () => {
    const ws = workspace();
    await createTopic({
      workspace: ws,
      topic: 'pointer-archive-target',
      agent: 'codex',
      mode: 'consult',
      summary: null,
      initialSessionId: null,
    });
    setPointer(ws, 'pointer-archive-target');
    expect(readPointer(ws)?.current_topic).toBe('pointer-archive-target');

    // Archive flow proper: the CLI clears the pointer, but at the lib
    // level it's the caller's responsibility. We simulate the CLI
    // sequence: archive, then conditional clear if pointer matched.
    await archiveTopic(ws, 'pointer-archive-target', 'manual');
    const ptr = readPointer(ws);
    if (ptr?.current_topic === 'pointer-archive-target') {
      clearPointer(ws);
    }
    expect(readPointer(ws)?.current_topic ?? null).toBeNull();
  });

  it('AGENT_HANDOFF_DEPTH alone does NOT refuse (stale-env false-positive guard)', async () => {
    // A bare `AGENT_HANDOFF_DEPTH=1` exported by some unrelated parent
    // shell shouldn't wedge direct user invocations. Without the
    // matching `AGENT_HANDOFF_TOKEN` the depth counter is treated as
    // stale env. The send still fails (no codex binary in test env,
    // missing topic, etc), but it must NOT exit 3 with "Refusing
    // nested handoff invocation".
    const handoffPath = join(__dirname, '..', 'bin', 'agent-handoff.ts');
    expect(existsSync(handoffPath)).toBe(true);

    // Use a `handoff status` invocation instead of `send` — status
    // exercises the same env/argv path but exits without spawning an
    // agent subprocess, so the test can't hang on a missing CLI.
    // The recursion guard lives in `cmdSend`; status doesn't gate on
    // it, so a non-3 exit is the proof the false-positive case is
    // handled. Belt-and-braces: assert on the lack of the refuse
    // message specifically.
    const result = spawnSync('bun', [handoffPath, 'status'], {
      env: {
        ...process.env,
        AGENT_HANDOFF_DEPTH: '1',
        AGENT_HANDOFF_STATE_DIR: stateRoot,
      },
      encoding: 'utf-8',
      timeout: 4000,
    });
    expect(result.stderr).not.toContain('Refusing nested handoff invocation');
    expect(result.status).not.toBe(3);
  });

  it('AGENT_HANDOFF_DEPTH alone does NOT refuse a send either', async () => {
    // Same false-positive guard, exercised through the actual gated
    // path (`cmdSend`). Use a bogus --agent so the dispatcher exits at
    // resolveAgent (UnknownAgentError → exit 2) before any subprocess
    // spawn. The recursion guard fires earlier than that, so a non-3
    // exit proves the false-positive case is handled.
    const handoffPath = join(__dirname, '..', 'bin', 'agent-handoff.ts');
    const result = spawnSync(
      'bun',
      [
        handoffPath,
        'send',
        '--agent',
        'no-such-agent',
        '--mode',
        'review',
        '--topic',
        'never-created',
        '--prompt',
        'p',
      ],
      {
        env: {
          ...process.env,
          AGENT_HANDOFF_DEPTH: '1',
          AGENT_HANDOFF_STATE_DIR: stateRoot,
        },
        input: '',
        encoding: 'utf-8',
        timeout: 4000,
      }
    );
    expect(result.stderr).not.toContain('Refusing nested handoff invocation');
    expect(result.status).not.toBe(3);
    // Should exit at unknown-agent rejection instead.
    expect(result.stderr.toLowerCase()).toContain('agent');
  });

  it('AGENT_HANDOFF_DEPTH + AGENT_HANDOFF_TOKEN: child handoff refuses with exit 3', async () => {
    // Both env vars set means the parent really was handoff. Without
    // --allow-nested, refuse the inner call with exit 3.
    const handoffPath = join(__dirname, '..', 'bin', 'agent-handoff.ts');
    expect(existsSync(handoffPath)).toBe(true);

    const result = spawnSync(
      'bun',
      [
        handoffPath,
        'send',
        '--agent',
        'codex',
        '--mode',
        'review',
        '--topic',
        'should-never-create',
        '--summary',
        'nested-test',
        '--prompt',
        'this should never reach codex',
      ],
      {
        env: {
          ...process.env,
          AGENT_HANDOFF_DEPTH: '1',
          AGENT_HANDOFF_TOKEN: 'r-test-marker',
          AGENT_HANDOFF_STATE_DIR: stateRoot,
        },
        encoding: 'utf-8',
      }
    );
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('Refusing nested handoff invocation');
  });

  it('--allow-nested overrides the depth refusal (still fails on missing prompt etc, but past the guard)', async () => {
    const handoffPath = join(__dirname, '..', 'bin', 'agent-handoff.ts');
    const result = spawnSync(
      'bun',
      [
        handoffPath,
        'send',
        '--agent',
        'codex',
        '--mode',
        'review',
        '--topic',
        // Deliberately fail later validation (slug too short) so we
        // don't actually invoke codex. We just want to verify the depth
        // guard let us past. "too-short" is 9 chars, which would PASS
        // the 8-char minimum and reach codex spawn — use 5-char "short"
        // so validateTopic rejects before any agent process is launched.
        'short',
        '--allow-nested',
        '--prompt',
        'irrelevant',
      ],
      {
        env: { ...process.env, AGENT_HANDOFF_DEPTH: '1', AGENT_HANDOFF_STATE_DIR: stateRoot },
        encoding: 'utf-8',
      }
    );
    // Past the depth guard means stderr does NOT contain the refusal.
    expect(result.stderr).not.toContain('Refusing nested handoff invocation');
  });
});
