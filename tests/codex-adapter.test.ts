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

  it('passes configured model and reasoning effort before prompt', () => {
    const args = buildCodexArgs(null, 'p', { model: 'gpt-5.5', effort: 'xhigh' });
    expect(args).toEqual([
      'exec',
      '--model',
      'gpt-5.5',
      '-c',
      'model_reasoning_effort="xhigh"',
      '--full-auto',
      'p',
    ]);
  });

  it('passes configured fast speed tier before prompt', () => {
    const args = buildCodexArgs(null, 'p', { model: 'gpt-5.5', speed: 'fast' });
    expect(args).toEqual([
      'exec',
      '--model',
      'gpt-5.5',
      '-c',
      'features.fast_mode=true',
      '-c',
      'service_tier="fast"',
      '--full-auto',
      'p',
    ]);
  });

  it('can force the default speed tier before prompt', () => {
    const args = buildCodexArgs(null, 'p', { speed: 'default' });
    expect(args).toEqual([
      'exec',
      '-c',
      'service_tier="default"',
      '--full-auto',
      'p',
    ]);
  });

  it('passes configured model and reasoning effort on resume', () => {
    const args = buildCodexArgs('019dd000-aaaa-7000-bbbb-cccccccccccc', 'p', {
      model: 'gpt-5.4-mini',
      effort: 'medium',
    });
    expect(args).toEqual([
      'exec',
      'resume',
      '019dd000-aaaa-7000-bbbb-cccccccccccc',
      '--model',
      'gpt-5.4-mini',
      '-c',
      'model_reasoning_effort="medium"',
      '--full-auto',
      'p',
    ]);
  });
});
