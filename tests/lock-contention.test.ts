/**
 * Lock contention test — exercises `withLock` under N concurrent
 * mutations to verify the registry serializes round increments without
 * losing any.
 *
 * Synthetic: no agent calls. Each "invocation" just bumps a counter
 * inside the locked region. If the lock works, final counter equals the
 * number of invocations and the JSONL history file has exactly that
 * many lines.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../lib/event-log.ts';
import { withLock } from '../lib/lock.ts';
import { AtomicFile } from '../lib/atomic-file.ts';

type Counter = { value: number };

describe('withLock concurrency', () => {
  it('serializes N parallel mutations without lost updates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-handoff-lock-test-'));
    try {
      mkdirSync(root, { recursive: true });
      const counterFile = new AtomicFile(join(root, 'counter.json'));
      const log = new EventLog<{ round: number; ts: number }>(
        join(root, 'history.jsonl')
      );
      counterFile.writeJson<Counter>({ value: 0 });

      const N = 32;
      const tasks = Array.from({ length: N }, (_, i) =>
        withLock(root, 'lock-test-topic', 'codex', async () => {
          // Read-modify-write under lock. Without the lock, parallel
          // RMW would overwrite siblings.
          const cur = counterFile.readJson<Counter>() ?? { value: 0 };
          const next = { value: cur.value + 1 };
          // Tiny artificial delay widens the race window so a broken
          // lock would visibly fail.
          await new Promise((r) => setTimeout(r, 1));
          counterFile.writeJson(next);
          log.append({ round: next.value, ts: Date.now() });
          return i;
        })
      );

      await Promise.all(tasks);
      log.close();

      const final = counterFile.readJson<Counter>();
      expect(final?.value).toBe(N);

      const lines = readFileSync(join(root, 'history.jsonl'), 'utf-8')
        .split('\n')
        .filter((l) => l.length > 0);
      expect(lines.length).toBe(N);

      // Round numbers in history should be 1..N inclusive (any order is
      // acceptable since lock acquisition order isn't deterministic, but
      // the SET of rounds is exact).
      const rounds = lines.map((l) => JSON.parse(l).round as number).sort((a, b) => a - b);
      expect(rounds).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('clears stale lock and recovers when prior holder crashed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-handoff-lock-stale-'));
    try {
      mkdirSync(root, { recursive: true });
      // Manually plant a stale lock dir attributed to a non-existent PID
      // and an old mtime.
      const lockDir = join(root, 'staletop.lock');
      mkdirSync(lockDir);
      const dummyInfo = {
        pid: 999_999_999, // unlikely-live pid
        hostname: require('node:os').hostname(),
        agent: 'codex',
        topic: 'staletop',
        acquiredAt: '2020-01-01T00:00:00.000Z',
      };
      require('node:fs').writeFileSync(
        join(lockDir, 'info.json'),
        JSON.stringify(dummyInfo, null, 2),
        'utf-8'
      );
      // Backdate mtime well past the 30s stale threshold.
      const oldStat = require('node:fs').statSync(lockDir);
      require('node:fs').utimesSync(
        lockDir,
        oldStat.atime,
        new Date(Date.now() - 60_000)
      );

      // Now try to acquire — should detect stale and recover.
      let ran = false;
      await withLock(root, 'staletop', 'codex', async () => {
        ran = true;
      });
      expect(ran).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});
