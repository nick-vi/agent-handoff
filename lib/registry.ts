/**
 * Topic registry — the storage facade.
 *
 * Owns the snapshot file (`<topic>.json`), the event log
 * (`<topic>.history.jsonl`), and the lock dance around mutations. Callers
 * use `withTopic` / `recordInvocation` / etc; the storage layout is
 * private to this module.
 *
 * Concurrency contract:
 *   - Reads (`loadSnapshot`, `readHistory`) take no lock; the atomic
 *     write of the snapshot means a concurrent read sees either prior
 *     or new state, never torn.
 *   - Writes (`createTopic`, `recordInvocation`, `archive`) take the
 *     topic lock for read-modify-write.
 *   - History append happens under the same lock as the snapshot update,
 *     so the JSONL line and the snapshot's `round_count` increment can
 *     never disagree.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AtomicFile } from './atomic-file.ts';
import { EventLog } from './event-log.ts';
import { classify, type Lifecycle } from './lifecycle.ts';
import { withLock } from './lock.ts';
import { migrateEvent, migrateSnapshot } from './schema/migrate.ts';
import { sanitizeSessionId } from './session-id.ts';
import {
  SCHEMA_VERSION,
  type AgentName,
  type EventV1,
  type Mode,
  type SnapshotV1,
  type Verdict,
} from './schema/v1.ts';
import { ensureStateDir } from './state-dir.ts';
import { validateTopic } from './slug.ts';
import { type WorkspaceInfo } from './workspace.ts';

export type CreateOptions = {
  workspace: WorkspaceInfo;
  topic: string;
  agent: AgentName;
  callerAgent?: AgentName | null;
  mode: Mode;
  summary: string | null;
  /** Used as auto-summary when `summary` is null. First non-empty line, capped. */
  promptForAutoSummary?: string;
  initialSessionId: string | null;
};

export type RecordOptions = {
  workspace: WorkspaceInfo;
  topic: string;
  agent: AgentName;
  callerAgent?: AgentName | null;
  mode: Mode;
  /**
   * Three-state session intent (mirrors `AgentResponse.sessionId`):
   *   - `string`     — replace the snapshot entry.
   *   - `null`       — clear the snapshot entry.
   *   - `undefined`  — preserve whatever's already in the snapshot.
   *
   * Adapters that fail to extract a session id should pass `undefined`
   * so prior values aren't accidentally clobbered or revived.
   */
  sessionId: string | null | undefined;
  verdict: Verdict;
  durationMs: number | null;
};

export type LoadResult = {
  snapshot: SnapshotV1;
  historyPath: string;
  snapshotPath: string;
};

const ARCHIVE_DIRNAME = 'archive';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function workspaceDir(ws: WorkspaceInfo): string {
  return join(ensureStateDir(), 'sessions', ws.dirName);
}

function snapshotPath(ws: WorkspaceInfo, topic: string): string {
  return join(workspaceDir(ws), `${topic}.json`);
}

function historyPath(ws: WorkspaceInfo, topic: string): string {
  return join(workspaceDir(ws), `${topic}.history.jsonl`);
}

function archiveDir(ws: WorkspaceInfo): string {
  return join(workspaceDir(ws), ARCHIVE_DIRNAME);
}

// ---------------------------------------------------------------------------
// Reads (no lock)
// ---------------------------------------------------------------------------

/**
 * Load the snapshot for a topic. Returns null if the topic doesn't exist.
 * Does NOT take the lock — callers wanting a consistent read-modify-write
 * must use `withLock` from the registry's mutation API.
 */
export function loadSnapshot(ws: WorkspaceInfo, topic: string): SnapshotV1 | null {
  validateTopic(topic);
  const file = new AtomicFile(snapshotPath(ws, topic));
  const raw = file.readJson<unknown>();
  if (raw === null) return null;
  return migrateSnapshot(raw);
}

/**
 * Read all history events for a topic in append order.
 */
export function readHistory(ws: WorkspaceInfo, topic: string): EventV1[] {
  validateTopic(topic);
  const log = new EventLog<unknown>(historyPath(ws, topic));
  return log.read().map(migrateEvent);
}

/**
 * List topics under a workspace. Returns slugs sorted alphabetically.
 * Skips the `archive/` subdir, transient `.lock` dirs, and any temp files.
 */
export function listTopics(ws: WorkspaceInfo): string[] {
  const dir = workspaceDir(ws);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  const topics: string[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    if (name.endsWith('.history.jsonl')) continue;
    if (name.startsWith('.')) continue;
    topics.push(name.slice(0, -'.json'.length));
  }
  return topics.sort();
}

export type TopicSummary = {
  topic: string;
  summary: string | null;
  lifecycle: Lifecycle;
  roundCount: number;
  lastUsedAt: string;
  sessions: SnapshotV1['sessions'];
};

/**
 * Higher-level listing: returns one entry per topic with computed
 * lifecycle. Used by `handoff list` and `handoff status` to render the
 * fail-with-list message.
 */
export function listTopicSummaries(ws: WorkspaceInfo): TopicSummary[] {
  const slugs = listTopics(ws);
  const out: TopicSummary[] = [];
  for (const topic of slugs) {
    const snap = loadSnapshot(ws, topic);
    if (!snap) continue;
    out.push({
      topic,
      summary: snap.summary,
      lifecycle: classify(snap),
      roundCount: snap.round_count,
      lastUsedAt: snap.last_used_at,
      sessions: snap.sessions,
    });
  }
  // Active first, then stale, alphabetical within each.
  out.sort((a, b) => {
    if (a.lifecycle !== b.lifecycle) {
      return a.lifecycle === 'active' ? -1 : 1;
    }
    return a.topic.localeCompare(b.topic);
  });
  return out;
}

/** Subset of `listTopicSummaries` filtered to `lifecycle === 'active'`. */
export function getActiveTopics(ws: WorkspaceInfo): TopicSummary[] {
  return listTopicSummaries(ws).filter((t) => t.lifecycle === 'active');
}

// ---------------------------------------------------------------------------
// Writes (locked)
// ---------------------------------------------------------------------------

/**
 * Create a new topic. Throws if a snapshot already exists (callers must
 * pass the existing-topic case through `--resume` or `--archive-and-new`).
 */
export async function createTopic(opts: CreateOptions): Promise<SnapshotV1> {
  validateTopic(opts.topic);
  return withLock(workspaceDir(opts.workspace), opts.topic, opts.agent, async () => {
    const file = new AtomicFile(snapshotPath(opts.workspace, opts.topic));
    if (file.exists()) {
      throw new TopicAlreadyExistsError(opts.topic);
    }

    const now = new Date().toISOString();
    const summary = opts.summary ?? autoSummary(opts.promptForAutoSummary);
    const initialSessionId = sanitizeSessionId(opts.agent, opts.initialSessionId) ?? null;
    const snap: SnapshotV1 = {
      schema_version: SCHEMA_VERSION,
      topic: opts.topic,
      summary,
      workspace: {
        resolvedRoot: opts.workspace.resolvedRoot,
        basename: opts.workspace.basename,
        hash: opts.workspace.hash,
        fromGit: opts.workspace.fromGit,
      },
      sessions: { [opts.agent]: initialSessionId },
      round_count: 1,
      created_at: now,
      last_used_at: now,
    };
    file.writeJson(snap, 2);

    const log = new EventLog<EventV1>(historyPath(opts.workspace, opts.topic));
    log.append({
      schema_version: SCHEMA_VERSION,
      kind: 'created',
      ts: now,
      agent: opts.agent,
      caller_agent: opts.callerAgent ?? null,
      mode: opts.mode,
      round: 1,
      session_id: initialSessionId,
      summary,
    });
    log.close();

    return snap;
  });
}

/**
 * Auto-derive a summary from the prompt when caller didn't supply one.
 * First non-empty, non-marker line, capped at 100 chars. Cheap fallback
 * so `handoff list` always has something useful to show.
 */
function autoSummary(prompt: string | undefined): string | null {
  if (!prompt) return null;
  const lines = prompt.split('\n').map((s) => s.trim());
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('---')) continue;
    return line.length > 100 ? `${line.slice(0, 97)}...` : line;
  }
  return null;
}

/**
 * Record a handoff invocation against an existing topic. Increments the
 * round counter, refreshes `last_used_at`, updates the agent's session ID
 * if a new one was minted, and appends an event-log entry. All under one
 * lock.
 */
export async function recordInvocation(opts: RecordOptions): Promise<SnapshotV1> {
  validateTopic(opts.topic);
  return withLock(workspaceDir(opts.workspace), opts.topic, opts.agent, async () => {
    const file = new AtomicFile(snapshotPath(opts.workspace, opts.topic));
    const raw = file.readJson<unknown>();
    if (raw === null) {
      throw new TopicNotFoundError(opts.topic);
    }
    const snap = migrateSnapshot(raw);

    const now = new Date().toISOString();
    const nextRound = snap.round_count + 1;
    const sanitizedSessionId = sanitizeSessionId(opts.agent, opts.sessionId);
    const mergedSessionId =
      sanitizedSessionId === undefined
        ? snap.sessions[opts.agent] ?? null
        : sanitizedSessionId;
    const next: SnapshotV1 = {
      ...snap,
      sessions: {
        ...snap.sessions,
        [opts.agent]: mergedSessionId,
      },
      round_count: nextRound,
      last_used_at: now,
    };
    file.writeJson(next, 2);

    const log = new EventLog<EventV1>(historyPath(opts.workspace, opts.topic));
    log.append({
      schema_version: SCHEMA_VERSION,
      kind: 'invocation',
      ts: now,
      agent: opts.agent,
      caller_agent: opts.callerAgent ?? null,
      mode: opts.mode,
      round: nextRound,
      session_id: mergedSessionId,
      verdict: opts.verdict,
      duration_ms: opts.durationMs,
    });
    log.close();

    return next;
  });
}

/**
 * Reset a per-agent session ID for an active topic without archiving.
 *
 * Use when an agent's session expired server-side (codex thread not
 * found, claude transcript deleted) and the user wants to keep the
 * topic's round/history continuity but have the next consult/debug
 * round mint a fresh session. Auto-fallback is deliberately not
 * implemented in adapters — `reset-session` is the manual escape hatch.
 *
 * Snapshot mutation: `snapshot.sessions[agent] = null`. History gets
 * a `session_reset` event line. Topic round count is unchanged
 * (the reset is bookkeeping, not a round).
 */
export async function resetSession(
  ws: WorkspaceInfo,
  topic: string,
  agent: AgentName,
  reason: 'manual' | 'expired' | 'crashed' = 'manual'
): Promise<{ previousSessionId: string | null }> {
  validateTopic(topic);
  return withLock(workspaceDir(ws), topic, agent, async () => {
    const file = new AtomicFile(snapshotPath(ws, topic));
    const raw = file.readJson<unknown>();
    if (raw === null) {
      throw new TopicNotFoundError(topic);
    }
    const snap = migrateSnapshot(raw);

    const previousSessionId = snap.sessions[agent] ?? null;
    if (previousSessionId === null) {
      // Idempotent: no-op if there was nothing to reset.
      return { previousSessionId: null };
    }

    const next: SnapshotV1 = {
      ...snap,
      sessions: { ...snap.sessions, [agent]: null },
      last_used_at: new Date().toISOString(),
    };
    file.writeJson(next, 2);

    const log = new EventLog<EventV1>(historyPath(ws, topic));
    log.append({
      schema_version: SCHEMA_VERSION,
      kind: 'session_reset',
      ts: new Date().toISOString(),
      agent,
      previous_session_id: previousSessionId,
      reason,
    });
    log.close();

    return { previousSessionId };
  });
}

/**
 * Archive a topic — moves snapshot + history to `archive/` with a
 * timestamp suffix, then removes the live files. Subsequent `createTopic`
 * for the same slug succeeds.
 *
 * Returns the archive paths AND the live paths the move came from. The
 * live paths are the targets `restoreArchivedTopic` puts the files back
 * into if a downstream operation (e.g. `createTopic` after
 * `archive_and_new`) fails and we need to roll back.
 */
export type ArchiveResult = {
  archivedSnapshot: string;
  archivedHistory: string;
  /** Filled when the topic had a plan/plan-history at archive time. */
  archivedPlan: string | null;
  archivedPlanHistory: string | null;
  /** Original live paths — used by `restoreArchivedTopic` to roll back. */
  liveSnapshot: string;
  liveHistory: string;
  livePlan: string;
  livePlanHistory: string;
};

export async function archiveTopic(
  ws: WorkspaceInfo,
  topic: string,
  reason: 'manual' | 'archive_and_new'
): Promise<ArchiveResult> {
  validateTopic(topic);
  return withLock(workspaceDir(ws), topic, 'cli', async () => {
    // Reject missing topic explicitly. The lock-write-rename dance below
    // would silently produce an orphan archive history file otherwise —
    // confusing to diagnose later.
    const liveSnap = snapshotPath(ws, topic);
    if (!existsSync(liveSnap)) {
      throw new TopicNotFoundError(topic);
    }

    // Compact ISO-8601 timestamp `YYYYMMDDTHHMMSSZ` — matches the
    // regex `prune` parses, sortable lexicographically, no separator
    // chars that would confuse the `<topic>--<ts>.{json|history.jsonl}`
    // splitting downstream.
    const isoMs = new Date().toISOString(); // 2026-04-30T19:10:23.456Z
    const baseTs =
      isoMs.slice(0, 4) + // YYYY
      isoMs.slice(5, 7) + // MM
      isoMs.slice(8, 10) + // DD
      'T' +
      isoMs.slice(11, 13) + // HH
      isoMs.slice(14, 16) + // MM
      isoMs.slice(17, 19) + // SS
      'Z';
    const archDir = archiveDir(ws);
    if (!existsSync(archDir)) mkdirSync(archDir, { recursive: true, mode: 0o700 });

    // Defend against same-second archives (rapid archive_and_new in a
    // tight loop) by suffixing a 4-hex disambiguator if the base name
    // already exists.
    let ts = baseTs;
    let attempt = 0;
    while (existsSync(join(archDir, `${topic}--${ts}.json`))) {
      attempt++;
      const suffix = Math.floor(Math.random() * 0xffff)
        .toString(16)
        .padStart(4, '0');
      ts = `${baseTs}-${suffix}`;
      if (attempt > 8) {
        throw new Error(
          `archive collision unresolvable for ${topic} at ${baseTs}; tried ${attempt}`
        );
      }
    }

    const liveHist = historyPath(ws, topic);
    const archSnap = join(archDir, `${topic}--${ts}.json`);
    const archHist = join(archDir, `${topic}--${ts}.history.jsonl`);

    renameSync(liveSnap, archSnap);
    if (existsSync(liveHist)) renameSync(liveHist, archHist);

    // Plan + plan history go into the archive too. Plans are
    // execution scaffolding tied to the topic; once the topic is
    // archived the plan no longer reflects active work, so it
    // belongs alongside the snapshot for forensic recovery rather
    // than haunting `plans/` as orphan state.
    const livePlan = join(workspaceDir(ws), 'plans', `${topic}.md`);
    const livePlanHistory = join(workspaceDir(ws), 'plans', `${topic}.history`);
    const archPlan = join(archDir, `${topic}--${ts}.plan.md`);
    const archPlanHistory = join(archDir, `${topic}--${ts}.plan.history`);
    let archivedPlan: string | null = null;
    let archivedPlanHistory: string | null = null;
    if (existsSync(livePlan)) {
      renameSync(livePlan, archPlan);
      archivedPlan = archPlan;
    }
    if (existsSync(livePlanHistory)) {
      renameSync(livePlanHistory, archPlanHistory);
      archivedPlanHistory = archPlanHistory;
    }

    // Append a final event into the now-archived history pointing back to
    // the live history file location is meaningless, so we record the
    // archival on a fresh log right next to the archive — useful for
    // reconstructing the audit trail later.
    const archLog = new EventLog<EventV1>(archHist);
    archLog.append({
      schema_version: SCHEMA_VERSION,
      kind: 'archived',
      ts: new Date().toISOString(),
      reason,
    });
    archLog.close();

    return {
      archivedSnapshot: archSnap,
      archivedHistory: archHist,
      archivedPlan,
      archivedPlanHistory,
      liveSnapshot: liveSnap,
      liveHistory: liveHist,
      livePlan,
      livePlanHistory,
    };
  });
}

/**
 * Roll back an archive — moves the archived files back to their live
 * paths. Called by `cmdSend` when `--archive-and-new` archives a topic,
 * the agent invocation succeeds, but the subsequent `createTopic`
 * fails. Without restore, the brief was sent and the artifact produced
 * but the topic's live state has vanished, leaving nothing to record
 * the round against.
 *
 * Strips the trailing `archived` event the archive added so the
 * history.jsonl reads as if archive never happened. Best-effort:
 * surfaces errors as `console.error` warnings rather than throwing,
 * because the caller's primary error (createTopic failure) is the one
 * the user needs to see first.
 */
export function restoreArchivedTopic(arch: ArchiveResult): void {
  // Reverse order of the moves done in archiveTopic so a partial
  // failure leaves the more important files (snapshot first) live.
  if (arch.archivedPlanHistory && existsSync(arch.archivedPlanHistory)) {
    try {
      mkdirSync(dirname(arch.livePlanHistory), { recursive: true, mode: 0o700 });
      renameSync(arch.archivedPlanHistory, arch.livePlanHistory);
    } catch (err) {
      console.error(`[handoff] restore: failed to move plan history back: ${(err as Error).message}`);
    }
  }
  if (arch.archivedPlan && existsSync(arch.archivedPlan)) {
    try {
      mkdirSync(dirname(arch.livePlan), { recursive: true, mode: 0o700 });
      renameSync(arch.archivedPlan, arch.livePlan);
    } catch (err) {
      console.error(`[handoff] restore: failed to move plan back: ${(err as Error).message}`);
    }
  }
  if (existsSync(arch.archivedHistory)) {
    try {
      // Strip the trailing `archived` event archiveTopic appended.
      // Best-effort — if the file shape is unexpected, skip the trim
      // and surface the file as-is (a stray `archived` line is less
      // bad than losing the history).
      const raw = readFileSync(arch.archivedHistory, 'utf-8');
      const lines = raw.split('\n').filter((l) => l.length > 0);
      let trimmed = raw;
      if (lines.length > 0) {
        try {
          const last = JSON.parse(lines[lines.length - 1] ?? '{}') as { kind?: string };
          if (last.kind === 'archived') {
            trimmed = lines.slice(0, -1).join('\n') + (lines.length > 1 ? '\n' : '');
          }
        } catch {
          // unparseable last line — leave as-is
        }
      }
      writeFileSync(arch.archivedHistory, trimmed, { mode: 0o600 });
      renameSync(arch.archivedHistory, arch.liveHistory);
    } catch (err) {
      console.error(`[handoff] restore: failed to move history back: ${(err as Error).message}`);
    }
  }
  if (existsSync(arch.archivedSnapshot)) {
    try {
      renameSync(arch.archivedSnapshot, arch.liveSnapshot);
    } catch (err) {
      console.error(`[handoff] restore: failed to move snapshot back: ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/**
 * Prune the archive dir down to the retention envelope.
 *   - keep the last N archives per topic (default 20)
 *   - drop archives older than M days (default 90)
 * Runs without holding any lock; archives are immutable.
 */
export type PruneOptions = {
  keepCount?: number;
  keepDays?: number;
};

export function pruneArchives(
  ws: WorkspaceInfo,
  options: PruneOptions = {}
): { removed: string[] } {
  const keepCount = options.keepCount ?? 20;
  const keepDays = options.keepDays ?? 90;
  const ageThresholdMs = keepDays * 24 * 60 * 60 * 1000;
  const dir = archiveDir(ws);
  if (!existsSync(dir)) return { removed: [] };

  const entries = readdirSync(dir).filter(
    (n) => n.endsWith('.json') || n.endsWith('.history.jsonl')
  );

  // Group by topic. Filename shape:
  //   `<topic>--<YYYYMMDDTHHMMSSZ>.json`
  //   `<topic>--<YYYYMMDDTHHMMSSZ>-<hex4>.json` (collision suffix)
  // Same suffix logic for `.history.jsonl`.
  const byTopic = new Map<string, Array<{ name: string; ts: number; group: string }>>();
  for (const name of entries) {
    const match = /^(.*?)--(\d{8}T\d{6}Z)(?:-([0-9a-f]{4}))?(?:\.history)?\.json(l)?$/.exec(name);
    if (!match) continue;
    const [, topic, tsStr, hexSuffix] = match;
    const ts = parseTsCompact(tsStr ?? '') ?? 0;
    if (!topic) continue;
    // Group key includes the optional hex suffix so a snapshot+history
    // pair stays bucketed regardless of whether they happened to land
    // in the same second as another archive.
    const group = hexSuffix ? `${topic}--${tsStr}-${hexSuffix}` : `${topic}--${tsStr}`;
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic)!.push({ name, ts, group });
  }

  const now = Date.now();
  const removed: string[] = [];

  for (const [, items] of byTopic) {
    // Newest first.
    items.sort((a, b) => b.ts - a.ts);
    // Bucket by group so snapshot+history pairs are kept/dropped together.
    const seenGroups = new Map<string, Array<{ name: string; ts: number }>>();
    for (const item of items) {
      if (!seenGroups.has(item.group)) seenGroups.set(item.group, []);
      seenGroups.get(item.group)!.push({ name: item.name, ts: item.ts });
    }
    let kept = 0;
    for (const [, group] of seenGroups) {
      const groupTs = group[0]?.ts ?? 0;
      const ageMs = now - groupTs;
      const tooOld = ageMs > ageThresholdMs;
      const overCount = kept >= keepCount;
      if (tooOld || overCount) {
        for (const f of group) {
          const fullPath = join(dir, f.name);
          try {
            rmSync(fullPath);
            removed.push(fullPath);
          } catch {
            /* swallow; another invocation may have raced us */
          }
        }
      } else {
        kept++;
      }
    }
  }

  return { removed };
}

/**
 * Trim each active topic's `<topic>.history.jsonl` down to the most
 * recent `keepLast` lines. Opt-in (the CLI default still keeps all
 * history); long-lived consult topics with thousands of rounds can
 * tighten this themselves to bound `handoff log` parse cost and disk
 * footprint.
 *
 * Per-topic lock for the rewrite — same lock domain as
 * `recordInvocation`, so a concurrent send waits its turn rather than
 * appending into a half-rewritten file.
 *
 * Returns one entry per topic actually trimmed (kept files unchanged
 * are excluded). Symmetric with `pruneArchives` so callers can render
 * both results uniformly.
 */
export type HistoryTrimResult = { topic: string; removed: number; kept: number };

export async function trimActiveHistories(
  ws: WorkspaceInfo,
  keepLast: number
): Promise<{ trimmed: HistoryTrimResult[] }> {
  if (!Number.isFinite(keepLast) || keepLast < 1) {
    throw new Error(`trimActiveHistories: keepLast must be ≥ 1, got ${keepLast}`);
  }
  const dir = workspaceDir(ws);
  if (!existsSync(dir)) return { trimmed: [] };

  const topics = readdirSync(dir)
    .filter((n) => n.endsWith('.history.jsonl'))
    .map((n) => n.slice(0, -'.history.jsonl'.length));

  const trimmed: HistoryTrimResult[] = [];
  for (const topic of topics) {
    try {
      validateTopic(topic);
    } catch {
      // History file with an invalid slug; skip rather than throwing —
      // pruning shouldn't blow up because of one stray file.
      continue;
    }
    await withLock(dir, topic, 'cli', async () => {
      const path = historyPath(ws, topic);
      if (!existsSync(path)) return;
      const raw = readFileSync(path, 'utf-8');
      const lines = raw.split('\n').filter((l) => l.length > 0);
      if (lines.length <= keepLast) return;
      const removed = lines.length - keepLast;
      const next = lines.slice(removed).join('\n') + '\n';
      writeFileSync(path, next, { mode: 0o600 });
      trimmed.push({ topic, removed, kept: keepLast });
    });
  }
  return { trimmed };
}

function parseTsCompact(ts: string): number | null {
  // YYYYMMDDTHHMMSSZ → Date
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(ts);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const d2 = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  const t = d2.getTime();
  return Number.isFinite(t) ? t : null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TopicAlreadyExistsError extends Error {
  constructor(readonly topic: string) {
    super(
      `Topic "${topic}" already exists. Use --resume to continue, or --archive-and-new to start fresh.`
    );
    this.name = 'TopicAlreadyExistsError';
  }
}

export class TopicNotFoundError extends Error {
  constructor(readonly topic: string) {
    super(`Topic "${topic}" not found in this workspace.`);
    this.name = 'TopicNotFoundError';
  }
}

// Re-exports for callers that want path access (CLI list/show)
export { snapshotPath, historyPath, workspaceDir };
