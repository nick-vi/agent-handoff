/**
 * Cursor sqlite reader — fixture-based round-trip + drift detection.
 *
 * Fixture is a real `store.db` from a "say hi briefly" / "what did you
 * just say?" session captured 2026-05-02. If cursor changes their
 * blob format and our adapter can no longer decode this fixture, the
 * regression surfaces here.
 *
 * To refresh after a cursor release, copy a fresh `~/.cursor/chats/.../
 * store.db` into `tests/fixtures/cursor-store-sample.db` and update
 * the expected counts below.
 */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  extractField1BlobIds,
  readCursorChat,
  sqlite3Available,
  validateRootBlobShape,
} from '../lib/agents/cursor-sqlite.ts';

const FIXTURE = join(__dirname, 'fixtures', 'cursor-store-sample.db');

describe('cursor-sqlite reader', () => {
  it.skipIf(!sqlite3Available())('reads meta + ordered turns from fixture', () => {
    const result = readCursorChat(FIXTURE);
    expect(result.warnings).toEqual([]);
    expect(result.meta.agentId).toBe('d62a9493-a670-42a8-8cae-d6c7c02e21ef');
    expect(result.meta.latestRootBlobId).toBe(
      '959d2b9ccd10b7c491587d3504be71f6df895f89b0cd8989c4ba5eab5c39fb02'
    );
    expect(result.rootBlobId).toBe(result.meta.latestRootBlobId ?? null);
    // Six turns in the captured session: system, user (workspace ctx),
    // user (q1), assistant (a1), user (q2), assistant (a2).
    expect(result.turns.length).toBe(6);
    expect(result.turns.map((t) => t.role)).toEqual([
      'system',
      'user',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    // Spot-check the visible content survives extraction.
    expect(result.turns[2]!.text).toContain('say hi briefly');
    expect(result.turns[4]!.text).toContain('what did you just say');
  });

  it.skipIf(!sqlite3Available())('sinceRootBlobId short-circuits when root unchanged', () => {
    const first = readCursorChat(FIXTURE);
    const second = readCursorChat(FIXTURE, { sinceRootBlobId: first.rootBlobId });
    expect(second.turns).toEqual([]);
    expect(second.rootBlobId).toBe(first.rootBlobId);
  });
});

describe('cursor-sqlite drift detection', () => {
  it('validateRootBlobShape accepts the canonical 0A 20 prefix', () => {
    expect(validateRootBlobShape('0a208ccdb2a9dd7da4c877a1d2ad065c1dcb2cdf6dc5e86498b7d8a4f2b7bdc437d4'))
      .toBe(true);
  });

  it('validateRootBlobShape rejects junk that isnt a field-1 entry', () => {
    expect(validateRootBlobShape('')).toBe(false);
    expect(validateRootBlobShape('abcdef')).toBe(false);
    expect(validateRootBlobShape('0a1f' + 'aa'.repeat(31))).toBe(false); // wrong length byte
    expect(validateRootBlobShape('0820' + 'aa'.repeat(32))).toBe(false); // wrong tag
  });

  it('extractField1BlobIds stops at first non-field-1 tag', () => {
    // Two valid entries followed by a tag-0x2A (envelope metadata).
    const hex =
      '0a20' +
      'aa'.repeat(32) +
      '0a20' +
      'bb'.repeat(32) +
      '2a08' + // tag 5 wire type 2, length 8 — should terminate
      '0102030405060708';
    expect(extractField1BlobIds(hex)).toEqual(['aa'.repeat(32), 'bb'.repeat(32)]);
  });

  it('readCursorChat returns warnings (not throws) when db missing', () => {
    const result = readCursorChat('/tmp/agent-handoff-no-such-db.db');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.turns).toEqual([]);
  });
});
