/**
 * Duration parsing tests. The grammar is intentionally tiny —
 * `<positive-int>(m|h|d)` — so the test surface is small but pins
 * the rejection cases to keep `handoff log --since` from silently
 * accepting weird input.
 */

import { describe, expect, it } from 'bun:test';
import { parseSince } from '../lib/duration.ts';

describe('parseSince', () => {
  it('parses minutes / hours / days', () => {
    expect(parseSince('30m')).toBe(30 * 60_000);
    expect(parseSince('2h')).toBe(2 * 3_600_000);
    expect(parseSince('7d')).toBe(7 * 86_400_000);
  });

  it('rejects invalid grammar', () => {
    expect(parseSince('')).toBeNull();
    expect(parseSince('1')).toBeNull();
    expect(parseSince('1s')).toBeNull(); // seconds not supported
    expect(parseSince('1y')).toBeNull(); // years not supported
    expect(parseSince('1h30m')).toBeNull(); // composite not supported
    expect(parseSince('1.5h')).toBeNull(); // fractional not supported
    expect(parseSince('-1h')).toBeNull(); // negative
    expect(parseSince('0h')).toBeNull(); // zero (would mean "since now")
    expect(parseSince('h')).toBeNull(); // missing number
  });

  it('trims whitespace', () => {
    expect(parseSince('  2h  ')).toBe(2 * 3_600_000);
  });
});
