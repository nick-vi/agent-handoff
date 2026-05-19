/**
 * Project-local pointer file: `.handoff/current.json` in the workspace root.
 *
 * Holds the per-workspace current topic plus a recency cache. Read by
 * `handoff send --current` and by `handoff status`. Written by `handoff use`
 * and `handoff clear`. Never source of truth — the canonical registry
 * under `~/.local/share/agent-handoff/` always wins on conflict.
 *
 * Auto-injected into `.git/info/exclude` so it never surfaces as an
 * untracked file in `git status` and never gets committed by accident.
 * The exclude line is project-local (not `.gitignore`), keeping the
 * project's own ignore rules untouched.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AtomicFile } from './atomic-file.ts';
import type { WorkspaceInfo } from './workspace.ts';

const POINTER_DIR = '.handoff';
const POINTER_FILE = 'current.json';
const GIT_EXCLUDE_FILE = '.git/info/exclude';
const GIT_EXCLUDE_LINE = '.handoff/';

export type Pointer = {
  schema_version: 1;
  workspace_hash: string;
  current_topic: string | null;
  set_at: string;
};

function pointerPath(workspaceRoot: string): string {
  return join(workspaceRoot, POINTER_DIR, POINTER_FILE);
}

export function readPointer(ws: WorkspaceInfo): Pointer | null {
  const file = new AtomicFile(pointerPath(ws.resolvedRoot));
  const raw = file.readJson<Pointer>();
  if (raw === null) return null;
  // Guard against pointer files copied between workspaces (rare but possible).
  if (raw.workspace_hash !== ws.hash) return null;
  return raw;
}

export function setPointer(ws: WorkspaceInfo, topic: string | null): void {
  const path = pointerPath(ws.resolvedRoot);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const pointer: Pointer = {
    schema_version: 1,
    workspace_hash: ws.hash,
    current_topic: topic,
    set_at: new Date().toISOString(),
  };
  new AtomicFile(path).writeJson(pointer, 2);

  if (ws.fromGit) ensureGitExcludeLine(ws.resolvedRoot);
}

export function clearPointer(ws: WorkspaceInfo): void {
  setPointer(ws, null);
}

/**
 * Append `.handoff/` to `.git/info/exclude` once, idempotent. Uses the
 * project-local exclude file rather than `.gitignore` so the project's
 * own ignore rules stay untouched and the line never gets committed.
 */
function ensureGitExcludeLine(workspaceRoot: string): void {
  const excludePath = join(workspaceRoot, GIT_EXCLUDE_FILE);
  if (!existsSync(excludePath)) {
    // Repo has no info/exclude (rare; some setups omit it). Bail rather
    // than create — the user might have policies about this dir.
    return;
  }
  const content = readFileSync(excludePath, 'utf-8');
  if (content.split('\n').includes(GIT_EXCLUDE_LINE)) return;
  const newContent = content.endsWith('\n')
    ? `${content}${GIT_EXCLUDE_LINE}\n`
    : `${content}\n${GIT_EXCLUDE_LINE}\n`;
  writeFileSync(excludePath, newContent, 'utf-8');
}
