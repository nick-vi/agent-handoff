/**
 * Strict flag rejection. CLI must error on unknown flags rather than
 * silently coerce them to bool — typos like `--workspce` were
 * previously falling through to default cwd resolution, masking the
 * user's intent.
 */

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const HANDOFF_BIN = join(__dirname, '..', 'bin', 'agent-handoff.ts');

function run(...argv: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('bun', [HANDOFF_BIN, ...argv], { encoding: 'utf-8' });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

describe('strict unknown-flag rejection', () => {
  it('rejects --workspce typo with exit 2 and a suggestion', () => {
    const r = run('list', '--workspce', '/tmp');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Unknown flag --workspce');
    expect(r.stderr).toContain('Did you mean --workspace?');
  });

  it('rejects --topcs (suggests --topic, distance 2)', () => {
    const r = run('send', '--agent', 'codex', '--mode', 'review', '--topcs', 'foo');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Unknown flag --topcs');
    expect(r.stderr).toContain('Did you mean --topic?');
  });

  it('rejects --completelybogus without suggestion (no close match)', () => {
    const r = run('list', '--completelybogus');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Unknown flag --completelybogus');
    // No "Did you mean" because edit distance > 2 from any known flag.
    expect(r.stderr).not.toContain('Did you mean');
  });

  it('accepts known flags without error', () => {
    const r = run('list', '--workspace', '/tmp');
    expect(r.stderr).not.toContain('Unknown flag');
  });
});
