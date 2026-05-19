/**
 * Crash-safe file operations using atomic write pattern.
 *
 * Writes to a temporary file first, then renames to target. Either the old
 * content or the new content exists at the target path; never a partial
 * write. Vendored from prophex-extractor/apps/api/src/utils/atomic-file.ts;
 * unmodified except for the file header.
 *
 * The tempfile lives in the same directory as the target so `rename(2)` is
 * atomic — a cross-filesystem rename degrades to copy+unlink and breaks
 * the atomicity guarantee.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class AtomicFile {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Read file contents. Returns null if file doesn't exist. */
  read(): string | null {
    try {
      return readFileSync(this.path, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /** Read and parse JSON. Returns null if file doesn't exist. Throws on invalid JSON. */
  readJson<T>(): T | null {
    const content = this.read();
    if (content === null) return null;
    return JSON.parse(content) as T;
  }

  /**
   * Write content atomically with `0600` permissions on the final file.
   *
   * `0600` is single-user-only — defense against multi-user boxes
   * where session IDs could leak via world-readable defaults. The temp
   * file inherits the same mode so a crashed write doesn't expose
   * content via the orphaned `.tmp`.
   */
  write(content: string): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

    const tempPath = this.generateTempPath();
    writeFileSync(tempPath, content, { encoding: 'utf-8', mode: 0o600 });

    try {
      renameSync(tempPath, this.path);
    } catch (error) {
      try {
        unlinkSync(tempPath);
      } catch {
        /* swallow secondary cleanup failure */
      }
      throw error;
    }
  }

  /** Write JSON atomically with optional indentation. */
  writeJson<T>(data: T, indent = 0): void {
    const content = indent > 0 ? JSON.stringify(data, null, indent) : JSON.stringify(data);
    this.write(content);
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  delete(): boolean {
    try {
      unlinkSync(this.path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  get filePath(): string {
    return this.path;
  }

  private generateTempPath(): string {
    return join(dirname(this.path), `.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  }
}
