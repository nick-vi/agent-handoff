/**
 * Topic lifecycle classification + mode-specific resume policy.
 *
 * Lifecycle: `active` and `archived` are persisted states; archived
 * topics live in `archive/` with an explicit timestamp suffix. `stale`
 * is computed, never written: it's the last-used age crossing a
 * threshold while the topic is otherwise active. Computing it on read
 * keeps the registry append-light and avoids a background sweeper.
 *
 * Resume policy: a single source of truth for "should the agent
 * receive the prior session ID for this round". Production code AND
 * tests both import this; the predicate cannot drift between the two.
 */

import type { Mode, SnapshotV1 } from './schema/v1.ts';

export type Lifecycle = 'active' | 'stale' | 'archived';

/**
 * `STALE_DAYS` and `RESUME_CONFIRM_DAYS` look similar but serve different
 * purposes — keep them named separately rather than collapsing them:
 *
 *   - `STALE_DAYS` (30): list/status presentation. A topic untouched
 *     this long is hidden from default `handoff list` output, but is
 *     still resumable without ceremony.
 *   - `RESUME_CONFIRM_DAYS` (7): safety prompt at send time. A topic
 *     untouched this long requires explicit `--resume` so the caller
 *     consciously confirms they meant the *same* thread, not a similar
 *     slug from weeks ago. Tighter than the lifecycle threshold on
 *     purpose: the cost of accidentally resuming a wrong long-idle
 *     thread (poisoned context) is higher than the cost of one extra
 *     keystroke.
 */
export const STALE_DAYS = 30;
export const RESUME_CONFIRM_DAYS = 7;

const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;
const RESUME_CONFIRM_MS = RESUME_CONFIRM_DAYS * 24 * 60 * 60 * 1000;

export function classify(snapshot: SnapshotV1): Lifecycle {
  const lastUsedMs = Date.parse(snapshot.last_used_at);
  if (!Number.isFinite(lastUsedMs)) return 'active';
  const ageMs = Date.now() - lastUsedMs;
  return ageMs > STALE_MS ? 'stale' : 'active';
}

/**
 * True when the snapshot has been idle long enough that send should
 * require explicit `--resume` confirmation before continuing the topic.
 * Independent of the lifecycle classification — a topic can require
 * confirmation while still being `active` for listing purposes.
 */
export function requiresResumeConfirmation(snapshot: SnapshotV1, now: Date = new Date()): boolean {
  const lastUsedMs = Date.parse(snapshot.last_used_at);
  if (!Number.isFinite(lastUsedMs)) return false;
  return now.getTime() - lastUsedMs > RESUME_CONFIRM_MS;
}

/**
 * Modes that auto-resume the prior agent session when one exists.
 * `consult` and `debug` carry server-side context across rounds;
 * `review`, `audit`, `execute` produce one-shot artifacts and should
 * start fresh unless `--resume` is explicit.
 */
const AUTO_RESUME_MODES: ReadonlySet<Mode> = new Set(['consult', 'debug']);

/**
 * Decide whether the handoff should pass the prior session ID to the
 * agent for this round. The single source of truth for the policy;
 * tested via the same export it's used at.
 */
export function shouldResumeAgentSession(mode: Mode, explicitResumeFlag: boolean): boolean {
  return explicitResumeFlag || AUTO_RESUME_MODES.has(mode);
}
