/**
 * Mode-specific resume policy.
 *
 * Codex's signed-off rule from round 3:
 *   - consult / debug → auto-resume the prior agent session
 *   - review / audit / execute → start fresh agent session unless
 *     --resume is explicit
 *
 * The handoff enforces this in `bin/agent-handoff.ts:cmdSend`. We can't easily
 * test the CLI's resume-or-not decision without spawning agents, but
 * we CAN exercise the rule's predicate so a regression in policy logic
 * shows up at unit-test time.
 */

import { describe, expect, it } from 'bun:test';
import { shouldResumeAgentSession as shouldResume } from '../lib/lifecycle.ts';

describe('mode-specific resume policy', () => {
  it('consult auto-resumes', () => {
    expect(shouldResume('consult', false)).toBe(true);
  });

  it('debug auto-resumes', () => {
    expect(shouldResume('debug', false)).toBe(true);
  });

  it('review does NOT auto-resume', () => {
    expect(shouldResume('review', false)).toBe(false);
  });

  it('audit does NOT auto-resume', () => {
    expect(shouldResume('audit', false)).toBe(false);
  });

  it('execute does NOT auto-resume', () => {
    expect(shouldResume('execute', false)).toBe(false);
  });

  it('--resume forces resume on every mode', () => {
    for (const mode of ['consult', 'debug', 'review', 'audit', 'execute'] as const) {
      expect(shouldResume(mode, true)).toBe(true);
    }
  });
});
