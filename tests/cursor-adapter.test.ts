/**
 * Unit tests for the cursor adapter — argv shape and session-id parsing.
 * The actual spawn() is exercised by the smoke script outside the test
 * suite.
 */

import { describe, expect, it } from 'bun:test';
import { buildCursorArgs } from '../lib/agents/cursor.ts';

describe('cursor buildArgs', () => {
  it('execute mode passes --yolo for non-interactive write', () => {
    const args = buildCursorArgs('execute', '/tmp/work', 'do the thing');
    expect(args).toContain('--yolo');
    expect(args).toContain('--print');
    expect(args).toContain('--trust');
    expect(args).toContain('--workspace');
    expect(args).toContain('/tmp/work');
    expect(args).not.toContain('agent');
    expect(args).not.toContain('--prompt');
    expect(args.at(-1)).toBe('do the thing');
  });

  it('audit mode also passes --yolo (always bypass; handoff is non-interactive)', () => {
    const args = buildCursorArgs('audit', '/tmp/work', 'inspect this');
    expect(args).toContain('--yolo');
    expect(args).toContain('--print');
  });

  it('consult mode also passes --yolo', () => {
    const args = buildCursorArgs('consult', '/tmp/work', 'design review');
    expect(args).toContain('--yolo');
  });

  it('always passes --yolo regardless of mode', () => {
    for (const mode of ['execute', 'audit', 'consult', 'review', 'debug'] as const) {
      const args = buildCursorArgs(mode, '/tmp/x', 'p');
      expect(args).toContain('--yolo');
    }
  });

  it('always emits JSON output format', () => {
    const args = buildCursorArgs('execute', '/tmp/x', 'p');
    expect(args).toContain('--output-format');
    const idx = args.indexOf('--output-format');
    expect(args[idx + 1]).toBe('json');
  });

  it('always passes the workspace as an absolute path arg', () => {
    const args = buildCursorArgs('execute', '/Users/nick/code/foo', 'p');
    const idx = args.indexOf('--workspace');
    expect(args[idx + 1]).toBe('/Users/nick/code/foo');
  });

  it('omits --resume when no session id', () => {
    const args = buildCursorArgs('consult', '/tmp/work', 'p', null);
    expect(args).not.toContain('--resume');
  });

  it('passes --resume <chatId> when session id provided', () => {
    const id = 'd62a9493-a670-42a8-8cae-d6c7c02e21ef';
    const args = buildCursorArgs('consult', '/tmp/work', 'p', id);
    const idx = args.indexOf('--resume');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(id);
  });
});
