/**
 * Unit tests for the Claude Code adapter.
 *
 * Live invocation is intentionally not exercised in the test suite
 * because spawning `claude` from inside an active Claude Code session
 * inherits environment variables that can confuse the child process.
 * The handoff's runtime path is the same module functions under test, so
 * argv + JSON-parse coverage is the meaningful guarantee here.
 */

import { describe, expect, it } from 'bun:test';
import {
  buildClaudeArgs,
  tryParseJsonResult,
} from '../lib/agents/claude.ts';

describe('claude buildArgs', () => {
  it('new session: --print --dangerously-skip-permissions --output-format json + prompt', () => {
    const args = buildClaudeArgs(null, 'hi there');
    expect(args).toEqual([
      '--print',
      '--dangerously-skip-permissions',
      '--output-format',
      'json',
      'hi there',
    ]);
  });

  it('resume: --print --dangerously-skip-permissions --output-format json --resume <id> + prompt', () => {
    const args = buildClaudeArgs('019dd000-aaaa-7000-bbbb-cccccccccccc', 'continue');
    expect(args).toEqual([
      '--print',
      '--dangerously-skip-permissions',
      '--output-format',
      'json',
      '--resume',
      '019dd000-aaaa-7000-bbbb-cccccccccccc',
      'continue',
    ]);
  });

  it('always passes --output-format json so session_id is in the envelope', () => {
    const args = buildClaudeArgs(null, 'p');
    const idx = args.indexOf('--output-format');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('json');
  });

  it('always passes --dangerously-skip-permissions (non-interactive)', () => {
    const args = buildClaudeArgs(null, 'p');
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('preserves prompt with newlines and special chars', () => {
    const prompt = 'multi\nline\nprompt with "quotes" and `backticks`';
    const args = buildClaudeArgs(null, prompt);
    expect(args[args.length - 1]).toBe(prompt);
  });
});

describe('claude tryParseJsonResult', () => {
  it('parses canonical claude --print --output-format json envelope', () => {
    // Real-shape envelope captured from `claude --print "hi" --output-format json`.
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      api_error_status: null,
      result: 'Hi.',
      session_id: '6989a01b-a788-482d-a121-57780ea123bf',
      permission_denials: [],
    });
    const parsed = tryParseJsonResult(stdout);
    expect(parsed).not.toBeNull();
    expect(parsed?.session_id).toBe('6989a01b-a788-482d-a121-57780ea123bf');
    expect(parsed?.is_error).toBe(false);
    expect(parsed?.result).toBe('Hi.');
  });

  it('handles trailing whitespace and newlines around the JSON', () => {
    const stdout = `\n\n${JSON.stringify({ session_id: 'abc', result: 'ok' })}\n`;
    const parsed = tryParseJsonResult(stdout);
    expect(parsed?.session_id).toBe('abc');
  });

  it('returns null for non-JSON stdout (e.g. login prompt)', () => {
    expect(tryParseJsonResult('Not logged in. Run /login.')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(tryParseJsonResult('{"session_id": "abc"')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(tryParseJsonResult('')).toBeNull();
  });
});
