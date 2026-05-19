/**
 * Schema migration pipeline.
 *
 * Stub for v1 (current). When SCHEMA_VERSION is bumped, add a migrator
 * keyed by the source version. The pipeline runs every applicable migrator
 * in order until the input matches the latest shape, then validates and
 * returns. Each migrator is a pure function from older shape → newer shape;
 * no I/O, no defaults filled at write time, just type evolution.
 */

import { SCHEMA_VERSION, type SnapshotV1, type EventV1 } from './v1.ts';

type AnyVersionedRecord = { schema_version?: number };

export function migrateSnapshot(raw: unknown): SnapshotV1 {
  const obj = (raw ?? {}) as AnyVersionedRecord;
  const v = obj.schema_version;

  if (v === undefined) {
    throw new Error('Snapshot is missing schema_version.');
  }

  if (v === SCHEMA_VERSION) return raw as SnapshotV1;

  // Future: insert migrators here, e.g.
  // if (v === 1) raw = migrateV1ToV2(raw as SnapshotV1);
  // ...

  throw new Error(
    `Unknown snapshot schema_version ${v}; latest is ${SCHEMA_VERSION}. Was this file written by a newer agent-handoff?`
  );
}

export function migrateEvent(raw: unknown): EventV1 {
  const obj = (raw ?? {}) as AnyVersionedRecord;
  const v = obj.schema_version;

  if (v === undefined) {
    throw new Error('Event is missing schema_version.');
  }

  if (v === SCHEMA_VERSION) return raw as EventV1;

  throw new Error(
    `Unknown event schema_version ${v}; latest is ${SCHEMA_VERSION}.`
  );
}
