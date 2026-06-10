import { describe, expect, it } from 'bun:test';
import {
  parseClaudeCodeVersion,
  resolveClaudeInvocationDefaults,
  supportsClaudeFable,
} from '../lib/agents/claude-models.ts';
import type { AgentInvocationDefaults } from '../lib/model-defaults.ts';

describe('claude model capability resolution', () => {
  it('parses Claude Code semver from version output', () => {
    expect(parseClaudeCodeVersion('2.1.170 (Claude Code)')).toEqual({
      major: 2,
      minor: 1,
      patch: 170,
      raw: '2.1.170',
    });
    expect(parseClaudeCodeVersion('not a version')).toBeNull();
  });

  it('detects fable support from the Claude Code version', () => {
    expect(supportsClaudeFable(parseClaudeCodeVersion('2.1.169 (Claude Code)'))).toBe(false);
    expect(supportsClaudeFable(parseClaudeCodeVersion('2.1.170 (Claude Code)'))).toBe(true);
    expect(supportsClaudeFable(parseClaudeCodeVersion('2.2.0 (Claude Code)'))).toBe(true);
  });

  it('resolves latest-claude to fable with a fallback chain on new Claude Code', () => {
    const input: AgentInvocationDefaults = { model: 'latest-claude', effort: 'max' };
    const resolved = resolveClaudeInvocationDefaults(
      input,
      { versionText: '2.1.170 (Claude Code)' },
    );
    expect(resolved.defaults).toEqual({
      model: 'fable',
      effort: 'max',
      fallbackModel: 'opus,sonnet',
    });
    expect(resolved.notes).toEqual([]);
  });

  it('resolves latest-claude to opus when fable support is unavailable', () => {
    const resolved = resolveClaudeInvocationDefaults(
      { model: 'latest-claude', effort: 'max' },
      { versionText: '2.1.150 (Claude Code)' },
    );
    expect(resolved.defaults).toEqual({ model: 'opus', effort: 'max' });
    expect(resolved.notes.join('\n')).toContain('resolves to opus');
  });

  it('downgrades explicit fable only when a parsed old version proves it unsupported', () => {
    expect(
      resolveClaudeInvocationDefaults(
        { model: 'claude-fable-5', effort: 'max' },
        { versionText: '2.1.150 (Claude Code)' },
      ).defaults,
    ).toEqual({ model: 'opus', effort: 'max' });

    expect(
      resolveClaudeInvocationDefaults(
        { model: 'claude-fable-5', effort: 'max' } as AgentInvocationDefaults,
        { versionText: 'unparseable' },
      ).defaults,
    ).toEqual({ model: 'claude-fable-5', effort: 'max', fallbackModel: 'opus,sonnet' });
  });

  it('suppresses fast mode for non-opus models', () => {
    const input: AgentInvocationDefaults = { model: 'fable', speed: 'fast' };
    const resolved = resolveClaudeInvocationDefaults(
      input,
      { versionText: '2.1.170 (Claude Code)' },
    );
    expect(resolved.defaults).toEqual({ model: 'fable', fallbackModel: 'opus,sonnet' });
    expect(resolved.notes.join('\n')).toContain('suppressing speed=fast');
  });

  it('supports explicit opus profiles', () => {
    expect(resolveClaudeInvocationDefaults({ model: 'latest-opus' }).defaults.model).toBe('opus');
    expect(resolveClaudeInvocationDefaults({ model: 'fast-opus' } as AgentInvocationDefaults).defaults).toEqual({
      model: 'opus',
      speed: 'fast',
    });
  });
});
