/**
 * Cursor `store.db` reader.
 *
 * Cursor doesn't write a JSONL transcript like claude/codex; it persists
 * each chat to a SQLite db with two tables:
 *
 *   blobs(id TEXT PK, data BLOB)
 *     Content-addressed JSON. Each turn is one row, keyed by sha256 of
 *     its serialized form. New turns insert new rows; the conversation
 *     timeline is reconstructed by following pointers from a root blob.
 *
 *   meta(key TEXT, value TEXT)
 *     `meta[0].value` is hex-encoded JSON describing the chat:
 *     `{ agentId, latestRootBlobId, name, createdAt, mode, ... }`.
 *
 * The root blob is a protobuf-like binary message whose repeated field
 * 1 (wire tag `0x0A`) holds a 32-byte blob id per turn, in conversation
 * order. We don't parse the full proto — we just walk the bytes and
 * pull every `0A 20 <32-byte>` triplet, which is enough to enumerate
 * the timeline.
 *
 * Each child blob is plain JSON: `{ role, content, ... }` where
 * `content` is a string OR an array of `{type, text, ...}` parts.
 * Same shape claude uses for arrays, so the shared transcript helpers
 * in `lib/transcripts.ts` handle them.
 *
 * Drift defense:
 *   - readMeta validates the value-row hex shape and the parsed JSON keys
 *   - readRootChildren validates that we found at least one child and
 *     that each is the correct length
 *   - parseTurnBlob validates that the parsed JSON has a recognized role
 *
 * Anything unrecognized is logged via `onWarn` and skipped, NOT thrown.
 * Partial transcripts are more useful than crashes when cursor's
 * format drifts.
 *
 * Dependency: the `sqlite3` CLI must be on `PATH`. Bun has a built-in
 * `bun:sqlite`, Node 22+ has `node:sqlite`, but using either would
 * complicate the Node bundle and pin a runtime version. The CLI
 * subprocess is slower (one spawn per query) but ubiquitous and
 * stable across runtimes.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export type CursorMeta = {
  agentId?: string;
  latestRootBlobId?: string;
  name?: string;
  createdAt?: number;
  mode?: string;
};

export type CursorTurn = {
  /** Source blob id — useful for deduping in incremental tail. */
  blobId: string;
  role: string;
  /** Unified text view of `content` (string or array of parts). */
  text: string;
  /** Raw JSON for callers that want everything. */
  raw: unknown;
};

export type CursorReadResult = {
  meta: CursorMeta;
  /** Root blob id at read time — store this and pass on next call to detect new turns. */
  rootBlobId: string | null;
  turns: CursorTurn[];
  /** Drift warnings that fired while reading. Empty on a clean read. */
  warnings: string[];
};

/**
 * Read all turns for a cursor `store.db`. Returns a snapshot — call
 * again to refresh. `rootBlobId` of the previous result can be passed
 * back as `sinceRootBlobId` for cheap "did anything change?" checks
 * without doing the full read; we still re-read everything if it
 * changed because cursor doesn't expose a per-blob ordering we can
 * resume from.
 */
export function readCursorChat(
  dbPath: string,
  options: { sinceRootBlobId?: string | null } = {}
): CursorReadResult {
  const warnings: string[] = [];
  if (!existsSync(dbPath)) {
    warnings.push(`store.db not found at ${dbPath}`);
    return { meta: {}, rootBlobId: null, turns: [], warnings };
  }
  if (!sqlite3Available()) {
    warnings.push('sqlite3 CLI not on PATH — install sqlite3 to read cursor chats');
    return { meta: {}, rootBlobId: null, turns: [], warnings };
  }

  const meta = readMeta(dbPath, warnings);
  const rootBlobId = meta.latestRootBlobId ?? null;
  if (!rootBlobId) {
    warnings.push('meta has no latestRootBlobId; chat may be empty or schema changed');
    return { meta, rootBlobId: null, turns: [], warnings };
  }
  if (options.sinceRootBlobId === rootBlobId) {
    // Caller already saw this version. Skip the rescan.
    return { meta, rootBlobId, turns: [], warnings };
  }

  const childIds = readRootChildren(dbPath, rootBlobId, warnings);
  const turns: CursorTurn[] = [];
  for (const id of childIds) {
    const blobHex = readBlobHex(dbPath, id);
    if (!blobHex) {
      warnings.push(`blob ${id.slice(0, 12)}… not found (referenced by root)`);
      continue;
    }
    const turn = parseTurnBlob(id, blobHex, warnings);
    if (turn) turns.push(turn);
  }
  return { meta, rootBlobId, turns, warnings };
}

/**
 * Exported for tests + doctor: do we have the CLI we need?
 */
export function sqlite3Available(): boolean {
  const r = spawnSync('sqlite3', ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return r.status === 0;
}

/**
 * Exported for tests: validate that `data` (hex-encoded blob bytes)
 * looks like a cursor root blob — i.e. starts with at least one
 * repeated field-1 entry. Returns true on success.
 */
export function validateRootBlobShape(hex: string): boolean {
  // First entry must be `0A 20` (tag=field1, length=32) followed by
  // 64 hex chars of blob id. Anything else is drift.
  return /^0a20[0-9a-f]{64}/i.test(hex);
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function runSqlite(dbPath: string, sql: string): string | null {
  const r = spawnSync('sqlite3', [dbPath, sql], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

function readMeta(dbPath: string, warnings: string[]): CursorMeta {
  const hexValue = runSqlite(dbPath, "SELECT value FROM meta WHERE key='0';");
  if (!hexValue) {
    warnings.push("meta key '0' not found in store.db");
    return {};
  }
  // value is hex-encoded JSON string. Decode → parse.
  if (!/^[0-9a-f]+$/i.test(hexValue) || hexValue.length % 2 !== 0) {
    warnings.push(`meta value not hex (got ${hexValue.length} chars); schema drift`);
    return {};
  }
  let json: string;
  try {
    json = Buffer.from(hexValue, 'hex').toString('utf-8');
  } catch (err) {
    warnings.push(`meta value hex-decode failed: ${(err as Error).message}`);
    return {};
  }
  try {
    const parsed = JSON.parse(json) as CursorMeta;
    if (typeof parsed !== 'object' || parsed === null) {
      warnings.push('meta json not an object');
      return {};
    }
    return parsed;
  } catch (err) {
    warnings.push(`meta json parse failed: ${(err as Error).message}`);
    return {};
  }
}

function readBlobHex(dbPath: string, blobId: string): string | null {
  // Sanitize id for SQL — blob ids are already hex of sha256 so this
  // is defense-in-depth against caller-supplied garbage.
  if (!/^[0-9a-f]{64}$/i.test(blobId)) return null;
  const hex = runSqlite(dbPath, `SELECT hex(data) FROM blobs WHERE id='${blobId}';`);
  if (!hex) return null;
  return hex.toLowerCase();
}

function readRootChildren(dbPath: string, rootId: string, warnings: string[]): string[] {
  const hex = readBlobHex(dbPath, rootId);
  if (!hex) {
    warnings.push(`root blob ${rootId.slice(0, 12)}… not found`);
    return [];
  }
  if (!validateRootBlobShape(hex)) {
    warnings.push(
      `root blob shape unexpected (does not start with 0A 20 …); cursor format drift?`
    );
    return [];
  }
  return extractField1BlobIds(hex);
}

/**
 * Walk a hex-encoded protobuf-like blob, pulling every `0A 20 <64-hex>`
 * triplet. Stops at the first non-field-1 tag; cursor's root blob lays
 * the child ids contiguously at the start, with envelope metadata
 * (tags 0x2A, 0x42, 0x4A, …) following. Exported for tests.
 */
export function extractField1BlobIds(hex: string): string[] {
  const ids: string[] = [];
  let i = 0;
  while (i + 4 + 64 <= hex.length) {
    const tag = hex.slice(i, i + 2);
    const len = hex.slice(i + 2, i + 4);
    if (tag !== '0a' || len !== '20') break;
    ids.push(hex.slice(i + 4, i + 4 + 64));
    i += 4 + 64;
  }
  return ids;
}

type RawTurnJson = {
  role?: string;
  content?: unknown;
  providerOptions?: unknown;
};

const KNOWN_ROLES = new Set(['system', 'user', 'assistant', 'tool', 'developer']);

function parseTurnBlob(blobId: string, hex: string, warnings: string[]): CursorTurn | null {
  // Try clean-JSON path first: most child blobs decode straight to UTF-8 JSON.
  const utf8 = Buffer.from(hex, 'hex').toString('utf-8');
  const trimmed = utf8.trim();
  if (trimmed.startsWith('{')) {
    return tryParse(blobId, trimmed, warnings);
  }
  // Envelope blob: protobuf header followed by an embedded JSON object.
  // Find the first `{` and try to parse from there to the matching brace.
  const firstBrace = utf8.indexOf('{');
  if (firstBrace === -1) {
    // Pure binary metadata blob (no JSON at all). Skip silently — these
    // are graph plumbing, not user-visible turns.
    return null;
  }
  return tryParse(blobId, utf8.slice(firstBrace), warnings);
}

function tryParse(blobId: string, json: string, warnings: string[]): CursorTurn | null {
  // Greedy: extract the largest balanced JSON object starting at byte 0.
  const balanced = extractBalancedJson(json);
  if (!balanced) {
    warnings.push(`blob ${blobId.slice(0, 12)}…: could not find balanced JSON object`);
    return null;
  }
  let parsed: RawTurnJson;
  try {
    parsed = JSON.parse(balanced);
  } catch (err) {
    warnings.push(`blob ${blobId.slice(0, 12)}…: json parse failed (${(err as Error).message})`);
    return null;
  }
  const role = parsed.role;
  if (!role || typeof role !== 'string') {
    // Not a turn — could be a metadata blob in JSON form.
    return null;
  }
  if (!KNOWN_ROLES.has(role)) {
    warnings.push(
      `blob ${blobId.slice(0, 12)}…: unknown role "${role}" — added since this adapter shipped?`
    );
    // Don't skip — emit anyway so partial drift still produces output.
  }
  const text = stringifyContent(parsed.content);
  return { blobId, role, text, raw: parsed };
}

function extractBalancedJson(s: string): string | null {
  if (s[0] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(0, i + 1);
    }
  }
  return null;
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const p = {
      ...(part as { type?: string; text?: unknown; data?: unknown; name?: unknown; input?: unknown; arguments?: unknown; content?: unknown }),
    };
    if (typeof p.text === 'string') parts.push(p.text);
    else if (p.type === 'redacted-reasoning') parts.push('<redacted-reasoning>');
    else if (p.type === 'tool_use' && p.name) {
      const args = toolArgsText(p.input ?? p.arguments);
      parts.push(`<tool: ${String(p.name)}>${args ? `\n${args}` : ''}`);
    }
    else if (p.type === 'tool_result') {
      const result = typeof p.content === 'string'
        ? p.content
        : stringifyContent(p.content);
      parts.push(`<tool_result>${result ? `\n${result}` : ''}`);
    }
    else if (p.type) parts.push(`<${p.type}>`);
  }
  return parts.join(' ').trim();
}

function toolArgsText(value: unknown): string {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
