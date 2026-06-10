/**
 * Skill-owned per-agent model defaults.
 *
 * These live in the handoff state dir instead of each agent's own global
 * config, so a handoff workflow can pin child-agent defaults without
 * changing normal interactive Codex / Claude / Cursor behavior.
 */

import { join } from 'node:path';
import { AtomicFile } from './atomic-file.ts';
import { ensureStateDir, resolveStateDir } from './state-dir.ts';
import type { AgentName } from './schema/v1.ts';

export type AgentInvocationDefaults = {
  /** Per-invocation model passed via each agent CLI's --model flag. */
  model?: string;
  /**
   * Effort-like knob for agents that expose one.
   * - codex: passed as `-c model_reasoning_effort="<value>"`
   * - claude: passed as `--effort <value>`
   * - cursor: unsupported; speed/effort are encoded in model IDs
   */
  effort?: string;
  /**
   * Speed tier for agents that expose a separate fast-mode control.
   * - claude: `fast` maps to `--settings {"fastMode":true}`.
   * - codex: `fast` maps to `service_tier="fast"` + fast-mode feature.
   * - cursor: speed is encoded in the model ID, e.g. `composer-2.5-fast`.
   */
  speed?: SpeedDefault;
  /** Claude-only fallback chain passed as `--fallback-model <models>`. */
  fallbackModel?: string;
};

type AgentDefaults = AgentInvocationDefaults & {
  updated_at?: string;
};

type DefaultsFile = {
  schema_version: 1;
  agents: Partial<Record<AgentName, AgentDefaults>>;
};

export type ResolvedAgentDefaults = AgentInvocationDefaults & {
  modelSource: DefaultSource;
  effortSource: DefaultSource;
  speedSource: DefaultSource;
  fallbackModelSource: DefaultSource;
};

export type SpeedDefault = 'fast' | 'default';
export type DefaultSource = 'env' | 'state' | 'runtime' | 'unset';

const EMPTY_DEFAULTS: DefaultsFile = {
  schema_version: 1,
  agents: {},
};

const MODEL_ENV: Record<AgentName, string> = {
  claude: 'AGENT_HANDOFF_CLAUDE_MODEL',
  codex: 'AGENT_HANDOFF_CODEX_MODEL',
  cursor: 'AGENT_HANDOFF_CURSOR_MODEL',
};

const EFFORT_ENV: Record<AgentName, string> = {
  claude: 'AGENT_HANDOFF_CLAUDE_EFFORT',
  codex: 'AGENT_HANDOFF_CODEX_REASONING_EFFORT',
  cursor: 'AGENT_HANDOFF_CURSOR_EFFORT',
};

const SPEED_ENV: Record<AgentName, string> = {
  claude: 'AGENT_HANDOFF_CLAUDE_SPEED',
  codex: 'AGENT_HANDOFF_CODEX_SPEED',
  cursor: 'AGENT_HANDOFF_CURSOR_SPEED',
};

const FALLBACK_MODEL_ENV: Record<AgentName, string> = {
  claude: 'AGENT_HANDOFF_CLAUDE_FALLBACK_MODEL',
  codex: 'AGENT_HANDOFF_CODEX_FALLBACK_MODEL',
  cursor: 'AGENT_HANDOFF_CURSOR_FALLBACK_MODEL',
};

export function agentDefaultsPath(): string {
  return join(resolveStateDir(), 'agent-defaults.json');
}

export function readAgentDefaultsFile(): DefaultsFile {
  const raw = new AtomicFile(agentDefaultsPath()).readJson<unknown>();
  if (raw === null) return EMPTY_DEFAULTS;
  if (!isDefaultsFile(raw)) {
    throw new Error(`Invalid agent defaults file: ${agentDefaultsPath()}`);
  }
  return raw;
}

export function getStoredAgentDefaults(agent: AgentName): AgentInvocationDefaults {
  const file = readAgentDefaultsFile();
  const entry = file.agents[agent] ?? {};
  const out: AgentInvocationDefaults = {};
  if (entry.model) out.model = entry.model;
  if (agent === 'cursor') return out;
  if (entry.effort) out.effort = entry.effort;
  if (entry.speed) out.speed = entry.speed;
  if (agent === 'claude' && entry.fallbackModel) out.fallbackModel = entry.fallbackModel;
  return out;
}

export function resolveAgentDefaults(agent: AgentName, env: NodeJS.ProcessEnv = process.env): ResolvedAgentDefaults {
  const stored = getStoredAgentDefaults(agent);
  const modelEnv = cleanValue(env[MODEL_ENV[agent]]);
  const effortEnv = agent === 'cursor' ? null : cleanValue(env[EFFORT_ENV[agent]]);
  const speedEnv = agent === 'cursor' ? null : normalizeSpeedValue(cleanValue(env[SPEED_ENV[agent]]));
  const fallbackModelEnv = agent === 'claude' ? cleanValue(env[FALLBACK_MODEL_ENV[agent]]) : null;
  const legacyCodexEffortEnv =
    agent === 'codex' ? cleanValue(env.AGENT_HANDOFF_CODEX_EFFORT) : null;

  const model = modelEnv ?? stored.model;
  const effort = effortEnv ?? legacyCodexEffortEnv ?? stored.effort;
  const speed = speedEnv ?? stored.speed;
  const fallbackModel = fallbackModelEnv ?? stored.fallbackModel;

  const out: ResolvedAgentDefaults = {
    modelSource: modelEnv ? 'env' : stored.model ? 'state' : 'unset',
    effortSource: effortEnv || legacyCodexEffortEnv ? 'env' : stored.effort ? 'state' : 'unset',
    speedSource: speedEnv ? 'env' : stored.speed ? 'state' : 'unset',
    fallbackModelSource: fallbackModelEnv ? 'env' : stored.fallbackModel ? 'state' : 'unset',
  };
  if (model) out.model = model;
  if (effort) out.effort = effort;
  if (speed) out.speed = speed;
  if (fallbackModel) out.fallbackModel = fallbackModel;
  return out;
}

export function setAgentDefaults(agent: AgentName, patch: AgentInvocationDefaults): DefaultsFile {
  if (agent === 'cursor' && patch.effort !== undefined) {
    throw new Error('Cursor Agent CLI does not expose a separate effort flag; set only model.');
  }
  if (agent === 'cursor' && patch.speed !== undefined) {
    throw new Error('Cursor Agent encodes speed in the model id; set only model.');
  }
  if (agent !== 'claude' && patch.fallbackModel !== undefined) {
    throw new Error('Fallback model chains are currently supported only for Claude.');
  }
  ensureStateDir();
  const file = readAgentDefaultsFile();
  const prev = file.agents[agent] ?? {};
  const next: AgentDefaults = agent === 'cursor' ? pickCursorSupportedDefaults(prev) : { ...prev };
  if (patch.model !== undefined) next.model = normalizeValue('model', patch.model);
  if (patch.effort !== undefined) next.effort = normalizeValue('effort', patch.effort);
  if (patch.speed !== undefined) {
    const speed = normalizeSpeedValue(normalizeValue('speed', patch.speed));
    if (speed) next.speed = speed;
  }
  if (patch.fallbackModel !== undefined) {
    next.fallbackModel = normalizeFallbackModel(patch.fallbackModel);
  }
  next.updated_at = new Date().toISOString();
  const updated: DefaultsFile = {
    schema_version: 1,
    agents: { ...file.agents, [agent]: next },
  };
  new AtomicFile(agentDefaultsPath()).writeJson(updated, 2);
  return updated;
}

export function unsetAgentDefaults(
  agent: AgentName,
  fields: { model?: boolean; effort?: boolean; speed?: boolean; fallbackModel?: boolean },
): DefaultsFile {
  ensureStateDir();
  const file = readAgentDefaultsFile();
  const prev = file.agents[agent] ?? {};
  const next: AgentDefaults = { ...prev };
  if (fields.model) delete next.model;
  if (fields.effort) delete next.effort;
  if (fields.speed) delete next.speed;
  if ('fallbackModel' in fields && fields.fallbackModel) delete next.fallbackModel;
  next.updated_at = new Date().toISOString();

  const updatedAgents = { ...file.agents };
  if (!next.model && !next.effort && !next.speed && !next.fallbackModel) {
    delete updatedAgents[agent];
  } else {
    updatedAgents[agent] = next;
  }

  const updated: DefaultsFile = {
    schema_version: 1,
    agents: updatedAgents,
  };
  new AtomicFile(agentDefaultsPath()).writeJson(updated, 2);
  return updated;
}

export function envNamesForAgent(agent: AgentName): {
  model: string;
  effort: string;
  speed: string;
  fallbackModel: string;
} {
  if (agent === 'cursor') {
    return {
      model: MODEL_ENV[agent],
      effort: 'unsupported',
      speed: 'unsupported',
      fallbackModel: 'unsupported',
    };
  }
  if (agent === 'claude') {
    return {
      model: MODEL_ENV[agent],
      effort: EFFORT_ENV[agent],
      speed: SPEED_ENV[agent],
      fallbackModel: FALLBACK_MODEL_ENV[agent],
    };
  }
  return {
    model: MODEL_ENV[agent],
    effort: EFFORT_ENV[agent],
    speed: SPEED_ENV[agent],
    fallbackModel: 'unsupported',
  };
}

function cleanValue(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeValue(field: 'model' | 'effort' | 'speed' | 'fallback model', value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must be non-empty`);
  if (/[\r\n]/.test(trimmed)) throw new Error(`${field} must be a single line`);
  return trimmed;
}

function normalizeSpeedValue(value: string | null): SpeedDefault | null {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'fast') return 'fast';
  if (normalized === 'default' || normalized === 'standard') return 'default';
  throw new Error(`Unsupported speed "${value}". Supported: fast, default.`);
}

function normalizeFallbackModel(value: string): string {
  const normalized = normalizeValue('fallback model', value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(',');
  if (!normalized) throw new Error('fallback model must include at least one model');
  return normalized;
}

function isDefaultsFile(value: unknown): value is DefaultsFile {
  if (!value || typeof value !== 'object') return false;
  const raw = value as DefaultsFile;
  if (raw.schema_version !== 1) return false;
  if (!raw.agents || typeof raw.agents !== 'object') return false;
  for (const [agent, defaults] of Object.entries(raw.agents)) {
    if (agent !== 'claude' && agent !== 'codex' && agent !== 'cursor') return false;
    if (!defaults || typeof defaults !== 'object') return false;
    const d = defaults as Record<string, unknown>;
    if (d.model !== undefined && typeof d.model !== 'string') return false;
    if (d.effort !== undefined && typeof d.effort !== 'string') return false;
    if (d.speed !== undefined) {
      if (typeof d.speed !== 'string') return false;
      if (!isPersistedSpeedDefault(d.speed)) return false;
    }
    if (d.fallbackModel !== undefined && typeof d.fallbackModel !== 'string') return false;
    if (d.updated_at !== undefined && typeof d.updated_at !== 'string') return false;
  }
  return true;
}

function isPersistedSpeedDefault(value: string): value is SpeedDefault {
  return value === 'fast' || value === 'default';
}

function pickCursorSupportedDefaults(defaults: AgentDefaults): AgentDefaults {
  const out: AgentDefaults = {};
  if (defaults.model) out.model = defaults.model;
  if (defaults.updated_at) out.updated_at = defaults.updated_at;
  return out;
}
