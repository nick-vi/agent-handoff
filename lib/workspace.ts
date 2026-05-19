/**
 * Workspace key derivation.
 *
 * State for the same project should share a registry directory across
 * worktrees and across invocation cwds. The key is therefore derived
 * from `git rev-parse --git-common-dir` (shared across linked worktrees
 * of the same repo), falling back to `realpath(cwd)` outside a repo.
 *
 * `--show-toplevel` would NOT do — it returns the worktree dir, which
 * differs per linked worktree. Using it fragments the registry across
 * worktrees of the same project; the discovery guard
 * (`handoff send` fails-with-list on active topics) breaks cross-worktree.
 *
 * Directory format: `<basename>-<12hex>`
 *   - basename = leaf of the resolved repo root (human ls-readability)
 *   - 12hex    = first 12 chars of sha256(resolved repo root)
 *
 * 12 hex (48 bits) is overkill for the ~thousands-of-projects scale this
 * skill targets, but the cost is zero and the future-safety nonzero.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { lookupAlias } from './aliases.ts';

export type GitProbe =
  /** Found a repo via `git rev-parse --git-common-dir`. */
  | 'ok'
  /** `git` binary not on PATH. Workspace silently fragments per-cwd. */
  | 'missing-binary'
  /** `git` is available but cwd isn't inside a repo. */
  | 'not-a-repo';

export type WorkspaceInfo = {
  /** Resolved absolute path used to derive the key. */
  resolvedRoot: string;
  /** Final basename used in directory naming. */
  basename: string;
  /** First 12 hex chars of sha256(resolvedRoot), or alias-overridden hash. */
  hash: string;
  /** `<basename>-<hash>`; safe for direct use as a directory name. */
  dirName: string;
  /** True if `resolvedRoot` came from `git rev-parse --git-common-dir`. */
  fromGit: boolean;
  /** True if the hash came from the alias map rather than direct sha256. */
  aliased: boolean;
  /** Outcome of the git probe — used by doctor / send to warn on `missing-binary`. */
  gitProbe: GitProbe;
};

export function resolveWorkspace(cwd: string = process.cwd()): WorkspaceInfo {
  const cwdReal = realpathSync(cwd);
  const probe = probeGitRepoRoot(cwdReal);
  const resolvedRoot = probe.kind === 'ok' ? probe.repoRoot : cwdReal;

  // Aliases override the natural sha256 → registry continuity survives
  // dir renames after the user runs `handoff alias`.
  const aliasedHash = lookupAlias(resolvedRoot);
  const hash =
    aliasedHash ?? createHash('sha256').update(resolvedRoot, 'utf8').digest('hex').slice(0, 12);
  const base = sanitizeBasename(basename(resolvedRoot));

  return {
    resolvedRoot,
    basename: base,
    hash,
    dirName: `${base}-${hash}`,
    fromGit: probe.kind === 'ok',
    aliased: aliasedHash !== null,
    gitProbe: probe.kind,
  };
}

/**
 * Resolve to the repo root that all linked worktrees of the same
 * project share. Uses `--git-common-dir` (which points at the main
 * `.git` directory regardless of which worktree we invoke from), then
 * strips the trailing `.git` segment to get the repo root. Falls back
 * to null outside a repo.
 *
 * Edge cases:
 *   - Normal repo: common-dir = `.git` (relative to toplevel) → strip → toplevel
 *   - Linked worktree: common-dir = `/path/to/main/.git` (absolute) → strip → main
 *   - Bare repo: common-dir = `.` or `<repo>.git` directory → use as-is
 */
type ProbeResult =
  | { kind: 'ok'; repoRoot: string }
  | { kind: 'missing-binary' }
  | { kind: 'not-a-repo' };

function probeGitRepoRoot(cwd: string): ProbeResult {
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // ENOENT/EACCES on the binary itself surface as `result.error` with
  // `code === 'ENOENT'`. Distinguishing "git missing" from "not in a
  // repo" lets doctor + send tell the user which footgun they're in:
  // missing-binary silently fragments the registry per-cwd.
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    return { kind: 'missing-binary' };
  }
  if (result.status !== 0) return { kind: 'not-a-repo' };
  const raw = result.stdout.trim();
  if (!raw) return { kind: 'not-a-repo' };

  const absoluteGitDir = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const repoRoot = basename(absoluteGitDir) === '.git' ? dirname(absoluteGitDir) : absoluteGitDir;

  try {
    return { kind: 'ok', repoRoot: realpathSync(repoRoot) };
  } catch {
    return { kind: 'ok', repoRoot };
  }
}

/**
 * Coerce an arbitrary path basename into a filesystem-safe form for the
 * registry directory. Lowercase ASCII letters/digits/dashes only; anything
 * else collapses to a dash. Falls back to "workspace" for paths whose
 * basename contains no usable characters.
 */
function sanitizeBasename(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || 'workspace';
}
