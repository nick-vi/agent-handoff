/**
 * Append-only event log backed by a JSONL file.
 *
 * Forked from prophex-extractor/apps/api/src/utils/checkpoint-log.ts. The
 * original stores opaque keys as a `Set<string>`; this fork stores typed
 * event objects, one JSON object per line, ordered by append time.
 *
 * Append uses an open file descriptor so each `append` is one O(1) write
 * with no full-file rewrite. Reads tolerate a trailing partial line — a
 * crash mid-append leaves the prior line intact and the partial line is
 * silently dropped on the next read. Recovery semantics, not corruption.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class EventLog<T> {
  private fd: number | null = null;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Append one event. Opens the file descriptor on first call. */
  append(event: T): void {
    const fd = this.openWrite();
    appendFileSync(fd, `${JSON.stringify(event)}\n`);
  }

  /**
   * Read all events. Tolerates trailing partial line from crash mid-append.
   * Lines that fail to parse are dropped silently with no error — the only
   * realistic cause is a torn write at the tail, and the next append will
   * resume cleanly because we always write `\n`-terminated.
   */
  read(): T[] {
    if (!existsSync(this.path)) return [];
    const content = readFileSync(this.path, 'utf-8');
    const lines = content.split('\n');
    const out: T[] = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        /* tolerate trailing partial line */
      }
    }
    return out;
  }

  /** Close the open file descriptor, if any. Safe to call multiple times. */
  close(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        /* swallow; fd may already be closed */
      }
      this.fd = null;
    }
  }

  get filePath(): string {
    return this.path;
  }

  private openWrite(): number {
    if (this.fd !== null) return this.fd;
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    // `a` mode + 0o600 keeps the log single-user; the mode is a no-op
    // on existing files (kernel preserves their existing mode), but
    // first-create gets the tight default.
    this.fd = openSync(this.path, 'a', 0o600);
    return this.fd;
  }
}
