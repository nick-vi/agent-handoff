/**
 * Trace storage — persistence of full prompt+response bodies per round,
 * separate from the JSONL event log.
 *
 * History (`<topic>.history.jsonl`) stores categorical metadata
 * (round, agent, mode, verdict, duration) suitable for fast indexing.
 * Trace files store the heavy bodies (prompt text, full agent output).
 * Splitting them keeps the event log scannable for `handoff log` /
 * `handoff tail` while guaranteeing full output is recoverable when stdout
 * is previewed or an upstream agent truncates what it observed.
 *
 * Layout:
 *   `<state-dir>/sessions/<workspace>/traces/<topic>/<round>-<agent>.json`
 *
 * One file per (topic, round, agent) tuple. Same lock-free read pattern
 * as snapshots — each round writes its own file, no contention. 0600
 * permissions inherit from the AtomicFile primitive.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AtomicFile } from './atomic-file.ts';
import type { AgentName, Mode, Verdict } from './schema/v1.ts';
import type { WorkspaceInfo } from './workspace.ts';
import { ensureStateDir } from './state-dir.ts';

const TRACES_DIRNAME = 'traces';

export type TraceV1 = {
  schema_version: 1;
  topic: string;
  agent: AgentName;
  mode: Mode;
  round: number;
  ts: string;
  prompt: string;
  output: string;
  session_id: string | null;
  verdict: Verdict;
  duration_ms: number | null;
};

function tracesDir(ws: WorkspaceInfo): string {
  return join(ensureStateDir(), 'sessions', ws.dirName, TRACES_DIRNAME);
}

function topicTracesDir(ws: WorkspaceInfo, topic: string): string {
  return join(tracesDir(ws), topic);
}

function tracePath(ws: WorkspaceInfo, topic: string, round: number, agent: AgentName): string {
  // Zero-pad round to 6 digits for natural lexical sort in `ls`.
  const padded = String(round).padStart(6, '0');
  return join(topicTracesDir(ws, topic), `${padded}-${agent}.json`);
}

/**
 * Write a trace file for a single round. Idempotent on the (topic,
 * round, agent) key — overwrites on collision (duplicate round numbers
 * shouldn't happen but if they do, last write wins). 0600.
 */
export function writeTrace(ws: WorkspaceInfo, trace: TraceV1): void {
  const file = new AtomicFile(tracePath(ws, trace.topic, trace.round, trace.agent));
  file.writeJson(trace, 2);
}

/**
 * Read all traces for a topic in round-ascending order. Returns empty
 * array if traces dir doesn't exist.
 */
export function readTraces(ws: WorkspaceInfo, topic: string): TraceV1[] {
  const dir = topicTracesDir(ws, topic);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: TraceV1[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const file = new AtomicFile(join(dir, name));
    const raw = file.readJson<TraceV1>();
    if (raw && raw.schema_version === 1) out.push(raw);
  }
  out.sort((a, b) => a.round - b.round);
  return out;
}

/** Path helper used by `handoff result --path` and tests. */
export function traceFilePath(
  ws: WorkspaceInfo,
  topic: string,
  round: number,
  agent: AgentName,
): string {
  return tracePath(ws, topic, round, agent);
}
