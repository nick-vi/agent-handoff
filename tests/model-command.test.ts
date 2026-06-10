import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HANDOFF = join(__dirname, '..', 'bin', 'agent-handoff.ts');

let stateRoot: string;

function run(...argv: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('bun', [HANDOFF, ...argv], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      AGENT_HANDOFF_STATE_DIR: stateRoot,
    },
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('handoff model command', () => {
  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'agent-handoff-model-command-'));
  });

  afterEach(() => {
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it('sets, lists, and unsets a codex model + effort + speed default', () => {
    const set = run('model', 'set', 'codex', 'gpt-5.5', '--effort', 'xhigh', '--speed', 'fast');
    expect(set.code).toBe(0);
    expect(set.stdout).toContain('codex');
    expect(set.stdout).toContain('model=gpt-5.5 (state)');
    expect(set.stdout).toContain('effort=xhigh (state)');
    expect(set.stdout).toContain('speed=fast (state)');

    const list = run('model');
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('codex');
    expect(list.stdout).toContain('gpt-5.5');
    expect(list.stdout).toContain('xhigh');
    expect(list.stdout).toContain('fast');
    expect(list.stdout).toContain('agent-defaults.json');

    const unsetEffort = run('model', 'unset', 'codex', '--effort-only');
    expect(unsetEffort.code).toBe(0);
    expect(unsetEffort.stdout).toContain('model=gpt-5.5 (state)');
    expect(unsetEffort.stdout).toContain('effort=(agent CLI default)');
    expect(unsetEffort.stdout).toContain('speed=fast (state)');

    const unsetSpeed = run('model', 'unset', 'codex', '--speed-only');
    expect(unsetSpeed.code).toBe(0);
    expect(unsetSpeed.stdout).toContain('model=gpt-5.5 (state)');
    expect(unsetSpeed.stdout).toContain('speed=(agent CLI default)');

    const unsetAll = run('model', 'unset', 'codex');
    expect(unsetAll.code).toBe(0);
    expect(unsetAll.stdout).toContain('model=(agent CLI default)');
  });

  it('rejects cursor effort because the CLI has no separate effort flag', () => {
    const result = run('model', 'set', 'cursor', 'gpt-5', '--effort', 'high');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('does not expose a separate effort flag');
  });

  it('rejects cursor speed because speed is encoded in cursor model ids', () => {
    const result = run('model', 'set', 'cursor', 'composer-2.5-fast', '--speed', 'fast');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('encodes speed in the model id');
  });

  it('accepts standard as an alias for default speed', () => {
    const result = run('model', 'set', 'claude', 'opus', '--speed', 'standard');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('speed=default (state)');
  });

  it('sets and unsets a Claude fallback model chain', () => {
    const set = run('model', 'set', 'claude', 'latest-claude', '--fallback-model', 'opus,sonnet');
    expect(set.code).toBe(0);
    expect(set.stdout).toContain('model=latest-claude (state)');
    expect(set.stdout).toContain('fallback=opus,sonnet (state)');

    const unset = run('model', 'unset', 'claude', '--fallback-only');
    expect(unset.code).toBe(0);
    expect(unset.stdout).toContain('model=latest-claude (state)');
    expect(unset.stdout).toContain('fallback=(none)');
  });

  it('rejects fallback chains for non-Claude agents', () => {
    const result = run('model', 'set', 'codex', 'gpt-5.5', '--fallback-model', 'gpt-5');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('supported only for Claude');
  });
});
