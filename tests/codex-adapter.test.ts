/**
 * Unit tests for the codex adapter — argv shape + session ID extraction.
 * Live invocation is exercised by smoke runs outside the test suite.
 */

import { describe, expect, it } from 'bun:test';
import { buildCodexArgs } from '../lib/agents/codex.ts';

describe('codex buildArgs', () => {
  it('new session: exec --full-auto <prompt>', () => {
    const args = buildCodexArgs(null, 'hi there');
    expect(args).toEqual(['exec', '--full-auto', 'hi there']);
  });

  it('resume: exec resume <id> --full-auto <prompt>', () => {
    const args = buildCodexArgs('019dd000-aaaa-7000-bbbb-cccccccccccc', 'continue');
    expect(args).toEqual([
      'exec',
      'resume',
      '019dd000-aaaa-7000-bbbb-cccccccccccc',
      '--full-auto',
      'continue',
    ]);
  });

  it('always passes --full-auto for non-interactive handoff', () => {
    expect(buildCodexArgs(null, 'p')).toContain('--full-auto');
    expect(buildCodexArgs('019dd000-aaaa-7000-bbbb-cccccccccccc', 'p')).toContain('--full-auto');
  });
});
