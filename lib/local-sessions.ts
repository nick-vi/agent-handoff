/**
 * Per-agent local-conversation file resolvers.
 *
 * Each CLI agent persists the live conversation to a known location
 * on disk while the round runs. Given a `session_id` (recorded in our
 * snapshot per (topic, agent)), we can locate that file and tail it
 * to watch progress without touching the agent's API.
 *
 * Layouts (verified on disk, May 2026):
 *   claude  ~/.claude/projects/<encoded-workspace>/<session_id>.jsonl
 *           Workspace path is encoded by replacing `/` and `.` with `-`.
 *           File grows in real time as the agent emits messages.
 *   codex   ~/.codex/sessions/YYYY/MM/DD/rollout-*-<session_id>.jsonl
 *           File path includes the session id at the tail. Walk recent
 *           date dirs to find it; sessions can span more than one day
 *           but a fresh round always lands in today's dir.
 *   cursor  ~/.cursor/chats/<workspace-hash>/<chat_id>/store.db
 *           SQLite, not a tailable file — return null with a reason
 *           so the caller can surface a useful message.
 *
 * Resolvers are best-effort: if the agent updates layout in a future
 * release, we return null rather than crashing. Wrap in try/catch at
 * the call site.
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentName } from './schema/v1.ts';
import { isValidSessionId } from './session-id.ts';

export type LocalSessionResolution =
  /** Plain JSONL file — tail with byte offsets. */
  | { kind: 'file'; path: string }
  /** Cursor's content-addressed sqlite store — read with cursor-sqlite adapter. */
  | { kind: 'sqlite-cursor'; path: string }
  /** Adapter doesn't support live introspection for this agent yet. */
  | { kind: 'unsupported'; reason: string }
  /** Path expected but not found on disk. */
  | { kind: 'missing'; reason: string };

/**
 * Encode a workspace path the way claude does for its `projects/` dir.
 * `/Users/me/code/project` -> `-Users-me-code-project`.
 */
export function encodeClaudeWorkspace(workspaceRoot: string): string {
  return workspaceRoot.replace(/[/.]/g, '-');
}

export function resolveLocalSession(
  agent: AgentName,
  sessionId: string,
  workspaceRoot: string
): LocalSessionResolution {
  if (!isValidSessionId(agent, sessionId)) {
    return { kind: 'missing', reason: `invalid ${agent} session id shape` };
  }
  switch (agent) {
    case 'claude':
      return resolveClaude(sessionId, workspaceRoot);
    case 'codex':
      return resolveCodex(sessionId);
    case 'cursor':
      return resolveCursor(sessionId);
  }
}

function resolveCursor(sessionId: string): LocalSessionResolution {
  const root = join(homedir(), '.cursor', 'chats');
  if (!existsSync(root)) {
    return { kind: 'missing', reason: 'no ~/.cursor/chats directory' };
  }
  // Cursor groups chats by workspace hash; within a workspace each chat
  // gets its own dir named with the chat (= session) id. Walk all
  // workspaces and look for a dir whose name matches our session id.
  for (const ws of readdirSync(root)) {
    const candidate = join(root, ws, sessionId, 'store.db');
    if (existsSync(candidate)) return { kind: 'sqlite-cursor', path: candidate };
  }
  return {
    kind: 'missing',
    reason: `no store.db under ~/.cursor/chats/*/${sessionId}/`,
  };
}

function resolveClaude(sessionId: string, workspaceRoot: string): LocalSessionResolution {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) {
    return { kind: 'missing', reason: `no ~/.claude/projects directory` };
  }
  const encoded = encodeClaudeWorkspace(workspaceRoot);
  const candidate = join(root, encoded, `${sessionId}.jsonl`);
  if (existsSync(candidate)) return { kind: 'file', path: candidate };

  // Fallback: claude sometimes encodes a slightly different parent (e.g.
  // when invoked from a subdirectory of the repo) — scan all project
  // dirs for the session id.
  for (const dir of readdirSync(root)) {
    const path = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(path)) return { kind: 'file', path };
  }
  return {
    kind: 'missing',
    reason: `no ${sessionId}.jsonl under ~/.claude/projects/* (workspace ${encoded})`,
  };
}

function resolveCodex(sessionId: string): LocalSessionResolution {
  const root = join(homedir(), '.codex', 'sessions');
  if (!existsSync(root)) {
    return { kind: 'missing', reason: 'no ~/.codex/sessions directory' };
  }
  // Walk YYYY/MM/DD looking for `rollout-*-<sessionId>.jsonl`. Newest
  // dirs first so we find the active session quickly. Cheap because
  // there are at most ~31 day dirs per month.
  const tail = `-${sessionId}.jsonl`;
  const years = readdirSync(root).filter((n) => /^\d{4}$/.test(n)).sort().reverse();
  for (const y of years) {
    const months = readdirSync(join(root, y))
      .filter((n) => /^\d{2}$/.test(n))
      .sort()
      .reverse();
    for (const m of months) {
      const days = readdirSync(join(root, y, m))
        .filter((n) => /^\d{2}$/.test(n))
        .sort()
        .reverse();
      for (const d of days) {
        const dir = join(root, y, m, d);
        for (const name of readdirSync(dir)) {
          if (name.endsWith(tail)) return { kind: 'file', path: join(dir, name) };
        }
      }
    }
  }
  return {
    kind: 'missing',
    reason: `no rollout-*-${sessionId}.jsonl under ~/.codex/sessions`,
  };
}
