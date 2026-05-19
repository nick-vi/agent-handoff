import { describe, expect, it } from 'bun:test';
import { migrateEvent, migrateSnapshot } from '../lib/schema/migrate.ts';
import { SCHEMA_VERSION, type EventV1, type SnapshotV1 } from '../lib/schema/v1.ts';

describe('migrateSnapshot', () => {
  it('returns v1 input unchanged', () => {
    const v1: SnapshotV1 = {
      schema_version: 1,
      topic: 'example-topic',
      summary: 'first round',
      workspace: {
        resolvedRoot: '/tmp/example',
        basename: 'example',
        hash: 'a1b2c3d4e5f6',
        fromGit: true,
      },
      sessions: { codex: '019dd000-aaaa-7000-bbbb-cccccccccccc' },
      round_count: 1,
      created_at: '2026-04-30T00:00:00.000Z',
      last_used_at: '2026-04-30T00:00:00.000Z',
    };
    const out = migrateSnapshot(v1);
    expect(out).toEqual(v1);
    expect(out.schema_version).toBe(SCHEMA_VERSION);
  });

  it('throws on unknown future schema_version', () => {
    expect(() =>
      migrateSnapshot({
        schema_version: 999,
        topic: 'from-the-future',
      })
    ).toThrow(/schema_version 999/);
  });

  it('throws when schema_version is missing', () => {
    expect(() =>
      migrateSnapshot({
        topic: 'unversioned',
      })
    ).toThrow(/missing schema_version/);
  });
});

describe('migrateEvent', () => {
  it('returns v1 invocation event unchanged', () => {
    const e: EventV1 = {
      schema_version: 1,
      kind: 'invocation',
      ts: '2026-04-30T00:00:00.000Z',
      agent: 'codex',
      mode: 'review',
      round: 2,
      session_id: '019dd000-aaaa-7000-bbbb-cccccccccccc',
      verdict: 'advisory',
      duration_ms: 1234,
    };
    expect(migrateEvent(e)).toEqual(e);
  });

  it('throws on unknown event schema_version', () => {
    expect(() => migrateEvent({ schema_version: 42, kind: 'invocation' })).toThrow(
      /schema_version 42/
    );
  });

  it('throws when event schema_version is missing', () => {
    expect(() => migrateEvent({ kind: 'invocation' })).toThrow(/missing schema_version/);
  });
});
