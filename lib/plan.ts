/**
 * Plan artifact storage — per-topic markdown file managed by handoff.
 *
 * **Conceptual contract.** Plans are *active coordination state* —
 * execution scaffolding for in-flight work, not project memory.
 * Once execution lands, the git diff is the artifact; the plan is
 * throwaway. If a plan becomes worth preserving, it should be
 * promoted/exported deliberately (`handoff plan <topic> --export <path>`).
 *
 * Storage:
 *   `<state-dir>/sessions/<workspace>/plans/<topic>.md`            current plan
 *   `<state-dir>/sessions/<workspace>/plans/<topic>.history/<round>.md`
 *                                                                  opt-in snapshots
 *
 * Auto-included in `handoff send` prompts unless `--no-plan`. The
 * injection wraps the plan body with a provenance header so the
 * receiving agent can see *what* it was handed and *when* it was
 * last edited:
 *
 *   ## handoff plan: <topic> (last edited 2h ago)
 *   <plan content>
 *   ## end handoff plan
 *
 *   <user prompt>
 *
 * Note on the marker shape: avoid leading `---`. Codex's argv parser
 * treats a positional argument starting with `--` as a flag attempt;
 * a header like `--- handoff plan ---` causes the agent process to
 * exit immediately. Markdown-style `##` is benign for every adapter
 * we ship.
 *
 * Snapshots happen only when `--snapshot-plan-on-edit` is passed to
 * `send` AND the plan's sha256 differs from the latest snapshot.
 * Default off — most plans are throwaway and history snapshots are
 * only useful for forensic plan-drift debugging.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AtomicFile } from './atomic-file.ts';
import { ensureStateDir } from './state-dir.ts';
import type { WorkspaceInfo } from './workspace.ts';

const PLANS_DIRNAME = 'plans';

export type PlanState = {
  /** Absolute path to the plan file (may not exist). */
  path: string;
  /** Plan body, or null if no plan exists. */
  content: string | null;
  /** Last modified time, or null if no plan exists. */
  lastModified: Date | null;
  /** sha256 of body, or null if no plan exists. */
  contentHash: string | null;
};

function plansDir(ws: WorkspaceInfo): string {
  return join(ensureStateDir(), 'sessions', ws.dirName, PLANS_DIRNAME);
}

export function planPath(ws: WorkspaceInfo, topic: string): string {
  return join(plansDir(ws), `${topic}.md`);
}

export function planHistoryDir(ws: WorkspaceInfo, topic: string): string {
  return join(plansDir(ws), `${topic}.history`);
}

/** Read current plan state. Returns content=null if file doesn't exist. */
export function readPlan(ws: WorkspaceInfo, topic: string): PlanState {
  const path = planPath(ws, topic);
  if (!existsSync(path)) {
    return { path, content: null, lastModified: null, contentHash: null };
  }
  const content = readFileSync(path, 'utf-8');
  const lastModified = statSync(path).mtime;
  const contentHash = sha256(content);
  return { path, content, lastModified, contentHash };
}

/** Write current plan content atomically (0600). Creates parent dir. */
export function writePlan(ws: WorkspaceInfo, topic: string, content: string): void {
  new AtomicFile(planPath(ws, topic)).write(content);
}

/**
 * Write a round-stamped snapshot if the current plan's hash differs
 * from the most recent snapshot. Returns true if a snapshot was
 * written, false if skipped (no change since last snapshot, or no
 * plan to snapshot).
 */
export function snapshotPlanIfChanged(
  ws: WorkspaceInfo,
  topic: string,
  round: number,
): { snapshotted: boolean; path: string | null } {
  const current = readPlan(ws, topic);
  if (current.content === null || current.contentHash === null) {
    return { snapshotted: false, path: null };
  }
  const history = listPlanHistoryRounds(ws, topic);
  if (history.length > 0) {
    const lastRound = history[history.length - 1]!;
    const lastContent = readPlanSnapshot(ws, topic, lastRound);
    if (lastContent !== null && sha256(lastContent) === current.contentHash) {
      return { snapshotted: false, path: null };
    }
  }
  const snapPath = join(planHistoryDir(ws, topic), `${String(round).padStart(6, '0')}.md`);
  new AtomicFile(snapPath).write(current.content);
  return { snapshotted: true, path: snapPath };
}

/** List round numbers that have a snapshot, ascending. */
export function listPlanHistoryRounds(ws: WorkspaceInfo, topic: string): number[] {
  const dir = planHistoryDir(ws, topic);
  if (!existsSync(dir)) return [];
  const rounds: number[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const rawRound = name.slice(0, -'.md'.length);
    const n = Number.parseInt(rawRound, 10);
    if (Number.isFinite(n) && n > 0) rounds.push(n);
  }
  return rounds.sort((a, b) => a - b);
}

/** Read a snapshot's content, or null if missing. */
export function readPlanSnapshot(
  ws: WorkspaceInfo,
  topic: string,
  round: number,
): string | null {
  const path = join(planHistoryDir(ws, topic), `${String(round).padStart(6, '0')}.md`);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

/**
 * Compose the prompt that gets sent to the agent. If a plan exists,
 * prepend it with a provenance header so the agent can reason about
 * what context it was handed and how fresh it is. Returns the
 * composed prompt + injection metadata for footer reporting.
 */
export function composePromptWithPlan(
  ws: WorkspaceInfo,
  topic: string,
  userPrompt: string,
  now: Date = new Date(),
): { prompt: string; injection: PlanInjectionInfo | null } {
  const state = readPlan(ws, topic);
  if (state.content === null || state.lastModified === null) {
    return { prompt: userPrompt, injection: null };
  }
  const ageStr = formatAge(state.lastModified, now);
  const header = `## handoff plan: ${topic} (last edited ${ageStr})`;
  const footer = '## end handoff plan';
  const composed = `${header}\n${state.content.trim()}\n${footer}\n\n${userPrompt}`;
  return {
    prompt: composed,
    injection: {
      sizeBytes: Buffer.byteLength(state.content, 'utf-8'),
      ageString: ageStr,
      lastModified: state.lastModified,
      contentHash: state.contentHash!,
    },
  };
}

export type PlanInjectionInfo = {
  sizeBytes: number;
  ageString: string;
  lastModified: Date;
  contentHash: string;
};

/**
 * Format a timestamp as a human-readable age string. Coarse on
 * purpose — sub-minute precision adds noise without value.
 *   "just now" (<60s), "5m ago", "2h ago", "3d ago", "2w ago"
 */
export function formatAge(then: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - then.getTime();
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  if (diffMs < 7 * 86_400_000) return `${Math.floor(diffMs / 86_400_000)}d ago`;
  return `${Math.floor(diffMs / (7 * 86_400_000))}w ago`;
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}
