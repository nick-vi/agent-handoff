import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentDefaultsPath,
  getStoredAgentDefaults,
  resolveAgentDefaults,
  setAgentDefaults,
  unsetAgentDefaults,
} from '../lib/model-defaults.ts';

let stateRoot: string;
let originalStateDir: string | undefined;
let originalCodexModel: string | undefined;
let originalCodexEffort: string | undefined;
let originalCodexSpeed: string | undefined;

describe('agent model defaults', () => {
  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'agent-handoff-model-defaults-'));
    originalStateDir = process.env.AGENT_HANDOFF_STATE_DIR;
    originalCodexModel = process.env.AGENT_HANDOFF_CODEX_MODEL;
    originalCodexEffort = process.env.AGENT_HANDOFF_CODEX_REASONING_EFFORT;
    originalCodexSpeed = process.env.AGENT_HANDOFF_CODEX_SPEED;
    process.env.AGENT_HANDOFF_STATE_DIR = stateRoot;
    delete process.env.AGENT_HANDOFF_CODEX_MODEL;
    delete process.env.AGENT_HANDOFF_CODEX_REASONING_EFFORT;
    delete process.env.AGENT_HANDOFF_CODEX_SPEED;
  });

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.AGENT_HANDOFF_STATE_DIR;
    else process.env.AGENT_HANDOFF_STATE_DIR = originalStateDir;
    if (originalCodexModel === undefined) delete process.env.AGENT_HANDOFF_CODEX_MODEL;
    else process.env.AGENT_HANDOFF_CODEX_MODEL = originalCodexModel;
    if (originalCodexEffort === undefined) delete process.env.AGENT_HANDOFF_CODEX_REASONING_EFFORT;
    else process.env.AGENT_HANDOFF_CODEX_REASONING_EFFORT = originalCodexEffort;
    if (originalCodexSpeed === undefined) delete process.env.AGENT_HANDOFF_CODEX_SPEED;
    else process.env.AGENT_HANDOFF_CODEX_SPEED = originalCodexSpeed;
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it('starts unset and does not create the backing file on read', () => {
    expect(resolveAgentDefaults('codex')).toEqual({
      modelSource: 'unset',
      effortSource: 'unset',
      speedSource: 'unset',
    });
    expect(existsSync(agentDefaultsPath())).toBe(false);
  });

  it('persists model and effort per agent', () => {
    setAgentDefaults('codex', { model: 'gpt-5.5', effort: 'xhigh', speed: 'fast' });
    expect(getStoredAgentDefaults('codex')).toEqual({ model: 'gpt-5.5', effort: 'xhigh', speed: 'fast' });
    expect(resolveAgentDefaults('codex')).toEqual({
      model: 'gpt-5.5',
      effort: 'xhigh',
      speed: 'fast',
      modelSource: 'state',
      effortSource: 'state',
      speedSource: 'state',
    });
  });

  it('lets env override stored defaults', () => {
    setAgentDefaults('codex', { model: 'gpt-5.4-mini', effort: 'low', speed: 'default' });
    process.env.AGENT_HANDOFF_CODEX_MODEL = 'gpt-5.5';
    process.env.AGENT_HANDOFF_CODEX_REASONING_EFFORT = 'high';
    process.env.AGENT_HANDOFF_CODEX_SPEED = 'fast';
    expect(resolveAgentDefaults('codex')).toEqual({
      model: 'gpt-5.5',
      effort: 'high',
      speed: 'fast',
      modelSource: 'env',
      effortSource: 'env',
      speedSource: 'env',
    });
  });

  it('ignores unsupported cursor effort and speed env overrides', () => {
    setAgentDefaults('cursor', { model: 'composer-2.5-fast' });
    expect(
      resolveAgentDefaults('cursor', {
        AGENT_HANDOFF_CURSOR_MODEL: 'gpt-5.5-high-fast',
        AGENT_HANDOFF_CURSOR_EFFORT: 'high',
        AGENT_HANDOFF_CURSOR_SPEED: 'turbo',
      }),
    ).toEqual({
      model: 'gpt-5.5-high-fast',
      modelSource: 'env',
      effortSource: 'unset',
      speedSource: 'unset',
    });
  });

  it('ignores stale cursor effort and speed entries from the state file', () => {
    writeFileSync(
      agentDefaultsPath(),
      JSON.stringify({
        schema_version: 1,
        agents: {
          cursor: {
            model: 'composer-2.5-fast',
            effort: 'high',
            speed: 'fast',
            updated_at: '2026-06-05T00:00:00.000Z',
          },
        },
      }),
    );

    expect(getStoredAgentDefaults('cursor')).toEqual({ model: 'composer-2.5-fast' });
    expect(resolveAgentDefaults('cursor')).toEqual({
      model: 'composer-2.5-fast',
      modelSource: 'state',
      effortSource: 'unset',
      speedSource: 'unset',
    });
  });

  it('rejects unsupported cursor effort and speed at the storage boundary', () => {
    expect(() => setAgentDefaults('cursor', { effort: 'high' })).toThrow('separate effort');
    expect(() => setAgentDefaults('cursor', { speed: 'fast' })).toThrow('encodes speed');
  });

  it('unsets selected fields without touching the other field', () => {
    setAgentDefaults('claude', { model: 'sonnet', effort: 'high', speed: 'fast' });
    unsetAgentDefaults('claude', { effort: true });
    expect(getStoredAgentDefaults('claude')).toEqual({ model: 'sonnet', speed: 'fast' });
    unsetAgentDefaults('claude', { speed: true });
    expect(getStoredAgentDefaults('claude')).toEqual({ model: 'sonnet' });
    unsetAgentDefaults('claude', { model: true });
    expect(getStoredAgentDefaults('claude')).toEqual({});
  });
});
