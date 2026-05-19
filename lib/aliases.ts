/**
 * Workspace alias map for moved-or-renamed project directories.
 *
 * Stored at `<state>/aliases.json` as `{ resolvedPath: workspaceHash }`.
 * Example use: project lived at `/Users/me/code/foo`, registry topics
 * exist under hash X. User renames the dir to `bar`; new resolved path
 * hashes to Y. `handoff alias /Users/me/code/bar X` redirects all topic
 * lookups for the new path to the historical hash X.
 *
 * Aliases never silently auto-detect — would risk cross-project state
 * bleeding when two directories happen to share a git remote. Manual
 * assertion only.
 */

import { AtomicFile } from './atomic-file.ts';
import { ensureStateDir } from './state-dir.ts';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

type AliasFile = {
  schema_version: 1;
  /** Map of resolved-absolute-path → registry workspace hash. */
  aliases: Record<string, string>;
};

const FILENAME = 'aliases.json';

function aliasFilePath(): string {
  return join(ensureStateDir(), FILENAME);
}

function load(): AliasFile {
  const file = new AtomicFile(aliasFilePath());
  const raw = file.readJson<AliasFile>();
  if (raw && raw.schema_version === 1 && raw.aliases) return raw;
  return { schema_version: 1, aliases: {} };
}

function save(data: AliasFile): void {
  new AtomicFile(aliasFilePath()).writeJson(data, 2);
}

/** Look up an alias by resolved path. Returns the aliased hash, or null. */
export function lookupAlias(resolvedRoot: string): string | null {
  const file = load();
  return file.aliases[resolvedRoot] ?? null;
}

/** Register an alias mapping a resolved path to an existing workspace hash. */
export function setAlias(resolvedRoot: string, hash: string): void {
  const file = load();
  file.aliases[resolvedRoot] = hash;
  save(file);
}

/** Remove an alias entry. Returns true iff one was removed. */
export function removeAlias(resolvedRoot: string): boolean {
  const file = load();
  if (!(resolvedRoot in file.aliases)) return false;
  delete file.aliases[resolvedRoot];
  save(file);
  return true;
}

export function listAliases(): Record<string, string> {
  return { ...load().aliases };
}

/**
 * Walk every workspace dir under `<state>/sessions/`, read the most
 * recent snapshot, and report any whose recorded `resolvedRoot` no
 * longer exists on disk. These are candidates for `handoff alias` —
 * either the project was moved, renamed, or the path was on a removable
 * volume that's not mounted.
 *
 * Pure suggestion; never auto-applies. The user picks.
 */
export type MovedCandidate = {
  /** Workspace hash (last 12 chars of dirName, after the basename prefix). */
  hash: string;
  /** Full state-dir entry name, e.g. `prophex-extractor-d1952c564305`. */
  dirName: string;
  /** Path the topic snapshots claim was the resolved workspace root. */
  recordedRoot: string;
  /** Most recent snapshot date observed in this workspace. */
  lastUsedAt: string | null;
  /** Topic count under this workspace dir (skipping archives, locks). */
  topicCount: number;
};

export function suggestMovedWorkspaces(): MovedCandidate[] {
  const sessionsDir = join(ensureStateDir(), 'sessions');
  if (!existsSync(sessionsDir)) return [];
  const out: MovedCandidate[] = [];
  for (const dirName of readdirSync(sessionsDir)) {
    const dirPath = join(sessionsDir, dirName);
    let stat;
    try {
      stat = statSync(dirPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const entries = readdirSync(dirPath);
    const snapshotName = entries.find(
      (n) => n.endsWith('.json') && !n.endsWith('.history.jsonl')
    );
    if (!snapshotName) continue;

    let snap: { workspace?: { resolvedRoot?: string }; last_used_at?: string } | null = null;
    try {
      snap = JSON.parse(readFileSync(join(dirPath, snapshotName), 'utf-8'));
    } catch {
      continue;
    }
    const recordedRoot = snap?.workspace?.resolvedRoot;
    if (!recordedRoot) continue;
    if (existsSync(recordedRoot)) continue;

    const topicCount = entries.filter(
      (n) => n.endsWith('.json') && !n.endsWith('.history.jsonl')
    ).length;
    const hash = dirName.slice(-12);
    out.push({
      hash,
      dirName,
      recordedRoot,
      lastUsedAt: snap?.last_used_at ?? null,
      topicCount,
    });
  }
  return out.sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''));
}
