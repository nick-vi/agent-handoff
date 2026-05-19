/**
 * Agent dispatch table — lookup adapters by name.
 *
 * Adding a new agent: implement `AgentAdapter` in `./<name>.ts`, import
 * it, register here. The wrapper rejects unknown names at the CLI
 * boundary, so the table is the only registry.
 */

import type { AgentAdapter } from './base.ts';
import type { AgentName } from '../schema/v1.ts';
import { claude } from './claude.ts';
import { codex } from './codex.ts';
import { cursor } from './cursor.ts';

export const AGENTS: Record<AgentName, AgentAdapter> = {
  claude,
  codex,
  cursor,
};

export class UnknownAgentError extends Error {
  constructor(readonly raw: string) {
    super(
      `Unknown agent "${raw}". Supported: ${Object.keys(AGENTS).join(', ')}.`
    );
    this.name = 'UnknownAgentError';
  }
}

export function resolveAgent(raw: string): AgentAdapter {
  if (raw === 'claude' || raw === 'codex' || raw === 'cursor') {
    return AGENTS[raw];
  }
  throw new UnknownAgentError(raw);
}

export type { AgentAdapter, AgentRequest, AgentResponse } from './base.ts';
