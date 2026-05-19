/**
 * Lifecycle thresholds — pin the two staleness windows separately.
 *
 * STALE_DAYS (30) — list/status presentation cutoff.
 * RESUME_CONFIRM_DAYS (7) — send-time safety prompt cutoff.
 *
 * They look similar; this test prevents a future "let's just unify
 * these" cleanup from collapsing the two distinct policies.
 */

import { describe, expect, it } from 'bun:test';
import {
  classify,
  RESUME_CONFIRM_DAYS,
  requiresResumeConfirmation,
  STALE_DAYS,
} from '../lib/lifecycle.ts';
import type { SnapshotV1 } from '../lib/schema/v1.ts';

function snap(daysAgo: number): SnapshotV1 {
  const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return {
    schema_version: 1,
    topic: 'thresh-test',
    summary: null,
    workspace: { resolvedRoot: '/x', basename: 'x', hash: 'a'.repeat(12), fromGit: false },
    sessions: {},
    round_count: 1,
    created_at: ts,
    last_used_at: ts,
  };
}

describe('staleness thresholds are independent', () => {
  it('exports both constants', () => {
    expect(STALE_DAYS).toBe(30);
    expect(RESUME_CONFIRM_DAYS).toBe(7);
  });

  it('1d old: active and no confirm needed', () => {
    const s = snap(1);
    expect(classify(s)).toBe('active');
    expect(requiresResumeConfirmation(s)).toBe(false);
  });

  it('8d old: active for listing but requires confirm to send (the gap that justifies two thresholds)', () => {
    const s = snap(8);
    expect(classify(s)).toBe('active');
    expect(requiresResumeConfirmation(s)).toBe(true);
  });

  it('31d old: stale and requires confirm', () => {
    const s = snap(31);
    expect(classify(s)).toBe('stale');
    expect(requiresResumeConfirmation(s)).toBe(true);
  });

  it('exactly RESUME_CONFIRM_DAYS old: no confirm yet (strict >)', () => {
    const s = snap(RESUME_CONFIRM_DAYS);
    // requiresResumeConfirmation uses strict `>`, so day == threshold → false.
    expect(requiresResumeConfirmation(s)).toBe(false);
  });

  it('malformed last_used_at: never blocks send', () => {
    const s = snap(1);
    s.last_used_at = 'not-a-date';
    expect(requiresResumeConfirmation(s)).toBe(false);
  });
});
