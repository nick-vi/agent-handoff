/**
 * Schema v1 — current shape of registry snapshots and event-log entries.
 *
 * Every snapshot and every event line carries `schema_version`. Migration
 * logic (`./migrate.ts`) keys off that field; older versions are upgraded
 * on read so the in-memory shape always matches the latest definition.
 *
 * Treat this file as append-only. Adding optional fields → bump SCHEMA_VERSION
 * AND add a migrator that fills defaults. Removing or renaming fields →
 * bump and write the migrator.
 */

export const SCHEMA_VERSION = 1;

export type AgentName = 'claude' | 'codex' | 'cursor';

export type Mode = 'execute' | 'review' | 'audit' | 'debug' | 'consult';

export type Verdict = 'ok' | 'advisory' | 'blocked' | 'error';

/**
 * Snapshot — one file per active topic.
 *
 * Stored at `<state-dir>/sessions/<workspace>/<topic>.json`. Replaced
 * atomically on every relevant mutation; the atomic-file primitive ensures
 * the file always reflects either the prior or the new state, never a
 * torn half.
 */
export type SnapshotV1 = {
  schema_version: 1;
  topic: string;
  summary: string | null;
  workspace: {
    resolvedRoot: string;
    basename: string;
    hash: string;
    fromGit: boolean;
  };
  /** Most-recent session ID per agent. Null for agents never used on this topic. */
  sessions: Partial<Record<AgentName, string | null>>;
  round_count: number;
  created_at: string;
  last_used_at: string;
};

/**
 * Event — one line per handoff invocation in the topic's history.
 *
 * Append-only via JSONL. Stored at
 * `<state-dir>/sessions/<workspace>/<topic>.history.jsonl`.
 */
export type EventV1 =
  | {
      schema_version: 1;
      kind: 'created';
      ts: string;
      agent: AgentName;
      caller_agent?: AgentName | null;
      mode: Mode;
      round: 1;
      session_id: string | null;
      summary: string | null;
    }
  | {
      schema_version: 1;
      kind: 'invocation';
      ts: string;
      agent: AgentName;
      caller_agent?: AgentName | null;
      mode: Mode;
      round: number;
      session_id: string | null;
      verdict: Verdict;
      duration_ms: number | null;
    }
  | {
      schema_version: 1;
      kind: 'archived';
      ts: string;
      reason: 'manual' | 'archive_and_new';
    }
  | {
      schema_version: 1;
      kind: 'session_reset';
      ts: string;
      agent: AgentName;
      /** The session ID that was nulled out. Recorded for audit; not resumable after reset. */
      previous_session_id: string | null;
      reason: 'manual' | 'expired' | 'crashed';
    };
