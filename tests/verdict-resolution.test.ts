/**
 * Verdict resolution tests — pin the silent-failure guard.
 *
 * Bug we shipped without and got bitten by: claude hits a permission
 * prompt with no human at the TTY, sits, exits 0 with empty stdout.
 * Old logic defaulted to `ok` via exit code; caller never noticed.
 *
 * New logic: empty stdout + zero exit → `error`. Pin both directions
 * (empty fails, normal output passes) and the body-verdict precedence
 * (a Verdict line wins regardless of output length).
 */

import { describe, expect, it } from 'bun:test';
import {
  matchVerdictLine,
  outputLooksEmpty,
  resolveVerdict,
} from '../lib/agents/base.ts';

describe('outputLooksEmpty', () => {
  it('treats empty string as empty', () => {
    expect(outputLooksEmpty('')).toBe(true);
  });

  it('treats whitespace-only as empty', () => {
    expect(outputLooksEmpty('   \n\t  ')).toBe(true);
  });

  it('treats short permission-prompt-style strings as empty', () => {
    // 16-char threshold — below counts as no useful work.
    expect(outputLooksEmpty('approve?')).toBe(true);
  });

  it('treats normal multi-paragraph output as not empty', () => {
    expect(
      outputLooksEmpty(
        'Findings\n- nothing major\nVerdict: ok\n',
      ),
    ).toBe(false);
  });
});

describe('matchVerdictLine', () => {
  it('extracts ok', () => {
    expect(matchVerdictLine('body\nVerdict: ok\n')).toBe('ok');
  });

  it('extracts blocked from leading dash bullet', () => {
    expect(matchVerdictLine('- Verdict: blocked')).toBe('blocked');
  });

  it('returns null when absent', () => {
    expect(matchVerdictLine('no verdict here')).toBeNull();
  });

  it('case-insensitive', () => {
    expect(matchVerdictLine('VERDICT: ERROR')).toBe('error');
  });
});

describe('resolveVerdict', () => {
  it('body verdict wins over everything', () => {
    expect(resolveVerdict('Verdict: blocked', 0, 'blocked')).toBe('blocked');
    expect(resolveVerdict('', 0, 'ok')).toBe('ok');
  });

  it('empty stdout + zero exit + no body verdict → error (silent-failure guard)', () => {
    expect(resolveVerdict('', 0, null)).toBe('error');
    expect(resolveVerdict('   \n  ', 0, null)).toBe('error');
  });

  it('non-empty stdout + zero exit + no body verdict → advisory (matches SKILL.md contract)', () => {
    expect(resolveVerdict('Implemented the change across two files.\n', 0, null)).toBe('advisory');
  });

  it('non-zero exit always → error', () => {
    expect(resolveVerdict('Failed with stack trace ...', 1, null)).toBe('error');
    expect(resolveVerdict('', 1, null)).toBe('error');
    expect(resolveVerdict('', null, null)).toBe('error');
  });
});
