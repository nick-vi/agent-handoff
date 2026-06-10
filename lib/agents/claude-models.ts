/**
 * Claude Code model compatibility.
 *
 * Handoff stores model defaults as user intent. This layer translates
 * version-sensitive Claude intents into argv-safe per-invocation defaults
 * before the child process starts.
 */

import { spawnSync } from 'node:child_process';
import type { AgentInvocationDefaults } from '../model-defaults.ts';

export type ClaudeCodeVersion = {
  major: number;
  minor: number;
  patch: number;
  raw: string;
};

export type ClaudeDefaultResolution<T extends AgentInvocationDefaults> = {
  defaults: T;
  version: ClaudeCodeVersion | null;
  notes: string[];
};

export const CLAUDE_FABLE_MIN_VERSION: ClaudeCodeVersion = {
  major: 2,
  minor: 1,
  patch: 170,
  raw: '2.1.170',
};

const FABLE_MODELS = new Set(['fable', 'claude-fable-5']);
const LATEST_CLAUDE_PROFILE = 'latest-claude';
const LATEST_OPUS_PROFILE = 'latest-opus';
const FAST_OPUS_PROFILE = 'fast-opus';
const DEFAULT_FABLE_FALLBACK = 'opus,sonnet';

export function readClaudeCodeVersionText(env: NodeJS.ProcessEnv = process.env): string | null {
  const result = spawnSync('claude', ['--version'], {
    encoding: 'utf-8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) return null;
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() || null;
}

export function parseClaudeCodeVersion(text: string | null | undefined): ClaudeCodeVersion | null {
  if (!text) return null;
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(text);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
    patch: Number.parseInt(match[3]!, 10),
    raw: match[0],
  };
}

export function supportsClaudeFable(version: ClaudeCodeVersion | null): boolean {
  return version !== null && compareClaudeVersions(version, CLAUDE_FABLE_MIN_VERSION) >= 0;
}

export function resolveClaudeInvocationDefaults<T extends AgentInvocationDefaults>(
  input: T,
  opts: { versionText?: string | null } = {},
): ClaudeDefaultResolution<T> {
  const defaults = { ...input };
  const version = parseClaudeCodeVersion(opts.versionText ?? null);
  const notes: string[] = [];
  const requestedModel = defaults.model?.trim();
  const requestedKey = requestedModel?.toLowerCase();

  if (requestedKey === LATEST_CLAUDE_PROFILE) {
    if (supportsClaudeFable(version)) {
      defaults.model = 'fable';
      setRuntimeSource(defaults, 'modelSource');
      setDefaultFallback(defaults);
    } else {
      defaults.model = 'opus';
      setRuntimeSource(defaults, 'modelSource');
      notes.push(
        version
          ? `latest-claude requires Claude Code ${CLAUDE_FABLE_MIN_VERSION.raw}+ for fable; ${version.raw} resolves to opus.`
          : 'latest-claude could not verify Claude Code version; resolving to opus.',
      );
    }
  } else if (requestedKey === LATEST_OPUS_PROFILE) {
    defaults.model = 'opus';
    setRuntimeSource(defaults, 'modelSource');
  } else if (requestedKey === FAST_OPUS_PROFILE) {
    defaults.model = 'opus';
    defaults.speed = 'fast';
    setRuntimeSource(defaults, 'modelSource');
    setRuntimeSource(defaults, 'speedSource');
  } else if (requestedKey && FABLE_MODELS.has(requestedKey)) {
    if (version && !supportsClaudeFable(version)) {
      defaults.model = 'opus';
      setRuntimeSource(defaults, 'modelSource');
      notes.push(
        `${requestedModel} requires Claude Code ${CLAUDE_FABLE_MIN_VERSION.raw}+; ${version.raw} resolves to opus.`,
      );
    } else {
      setDefaultFallback(defaults);
    }
  }

  if (defaults.speed === 'fast' && defaults.model && !isClaudeOpusModel(defaults.model)) {
    notes.push(`fast mode is Opus-only in Claude Code; suppressing speed=fast for ${defaults.model}.`);
    delete defaults.speed;
    setRuntimeSource(defaults, 'speedSource');
  }

  return { defaults, version, notes };
}

function compareClaudeVersions(a: ClaudeCodeVersion, b: ClaudeCodeVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function isClaudeOpusModel(model: string): boolean {
  const normalized = model.toLowerCase();
  return normalized === 'opus' || normalized === 'latest-opus' || normalized.includes('opus');
}

function setDefaultFallback(defaults: AgentInvocationDefaults): void {
  if (!defaults.fallbackModel) {
    defaults.fallbackModel = DEFAULT_FABLE_FALLBACK;
    setRuntimeSource(defaults, 'fallbackModelSource');
  }
}

function setRuntimeSource(defaults: AgentInvocationDefaults, key: string): void {
  if (key in defaults) {
    (defaults as Record<string, unknown>)[key] = 'runtime';
  }
}
