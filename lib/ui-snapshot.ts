import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readPointer } from './pointer.ts';
import { listRunning } from './running.ts';
import { listTopicSummaries, loadSnapshot, readHistory } from './registry.ts';
import { SCHEMA_VERSION, type AgentName, type EventV1, type Mode, type Verdict } from './schema/v1.ts';
import { resolveStateDir } from './state-dir.ts';
import { readTraces } from './trace.ts';
import { isToolTurn, resolveTranscriptTurns, type TranscriptTurn } from './transcripts.ts';
import { runtimeRepoRoot } from './runtime.ts';
import type { WorkspaceInfo } from './workspace.ts';

type UiVerdict = Verdict | 'unknown';
type UiTraceSpan = { name: string; kind: string; durationMs: number };
type UiAgentStep = { kind: string; label: string; text: string };
type UiTurn = {
  role: string;
  text: string;
  ts: string | null;
  name?: string;
  toolUseId?: string;
  toolName?: string;
  isError?: boolean;
};
type UiRound = {
  index: number;
  agent: AgentName;
  fromAgent: AgentName | null;
  mode: Mode | 'running';
  verdict: UiVerdict;
  startedAt: string;
  durationMs: number | null;
  sessionId: string | null;
  promptPreview: string;
  resultPreview: string;
  hasTrace: boolean;
  isRunning: boolean;
  traceSpans?: UiTraceSpan[];
  agentSteps?: UiAgentStep[];
};
type UiRun = {
  key: string;
  topicKey: string;
  topic: string;
  agent: AgentName;
  mode: Mode | 'running';
  pid: number;
  startedAt: string;
  elapsedMs: number;
  pidAlive: boolean;
  runId: string | null;
  parentRunId: string | null;
  workspace: UiWorkspaceSummary;
};
type UiWorkspaceSummary = {
  root: string;
  basename: string;
  hash: string;
  dirName: string;
};

export function buildUiSnapshot(
  workspace: WorkspaceInfo,
  options: { allWorkspaces?: boolean; includeTopicKey?: string; includeTranscripts?: boolean } = {}
): unknown {
  const pointer = options.allWorkspaces ? null : readPointer(workspace);
  const workspaces = options.allWorkspaces ? listUiWorkspaces(workspace) : [workspace];
  const transcripts: Record<string, { sourcePath: string; turns: UiTurn[] }> = {};
  const running: UiRun[] = [];
  const topics = [];

  for (const ws of workspaces) {
    const wsSummary = workspaceSummary(ws);
    const wsRunning = listRunning(ws).map((run): UiRun => ({
      key: `${ws.dirName}/${run.topic}--${run.agent}--${run.run_id}`,
      topicKey: `${ws.dirName}/${run.topic}`,
      topic: run.topic,
      agent: run.agent,
      mode: run.mode ?? 'running',
      pid: run.pid,
      startedAt: run.started_at,
      elapsedMs: Date.now() - Date.parse(run.started_at),
      pidAlive: true,
      runId: run.run_id ?? null,
      parentRunId: run.parent_run_id ?? null,
      workspace: wsSummary,
    }));
    running.push(...wsRunning);

    const runningByTopic = new Map<string, UiRun[]>();
    for (const run of wsRunning) {
      const list = runningByTopic.get(run.topic) ?? [];
      list.push(run);
      runningByTopic.set(run.topic, list);
    }

    for (const summary of listTopicSummaries(ws)) {
      const currentTopicKey = `${ws.dirName}/${summary.topic}`;
      const shouldResolveTranscripts =
        options.includeTranscripts !== false
          && (!options.allWorkspaces || options.includeTopicKey === currentTopicKey);
      const snapshot = loadSnapshot(ws, summary.topic);
      const history = readHistory(ws, summary.topic);
      const traceByRound = new Map(
        readTraces(ws, summary.topic).map((trace) => [`${trace.round}:${trace.agent}`, trace])
      );
      const rounds: UiRound[] = [];

      for (const event of history) {
        if (event.kind !== 'created' && event.kind !== 'invocation') continue;
        const trace = traceByRound.get(`${event.round}:${event.agent}`);
        const sessionId = event.session_id ?? null;
        if (sessionId && shouldResolveTranscripts) {
          addTranscript(transcripts, event.agent, sessionId, ws.resolvedRoot);
        }
        rounds.push({
          index: event.round,
          agent: event.agent,
          fromAgent: event.caller_agent ?? null,
          mode: event.mode,
          verdict: event.kind === 'invocation' ? event.verdict : 'unknown',
          startedAt: event.ts,
          durationMs: event.kind === 'invocation' ? event.duration_ms : null,
          sessionId,
          promptPreview: trace ? preview(trace.prompt) : event.kind === 'created'
            ? summary.summary ?? 'Topic created'
            : `${event.agent}/${event.mode} invocation`,
          resultPreview: trace ? preview(trace.output) : event.kind === 'created'
            ? 'Topic created in handoff history'
            : `${event.verdict}; no trace body stored for this round`,
          hasTrace: Boolean(trace),
          isRunning: false,
          ...(trace ? { traceSpans: traceToSpans(trace) } : {}),
          agentSteps: eventToSteps(event, trace, sessionId),
        });
      }

      let nextSyntheticRound = Math.max(snapshot?.round_count ?? summary.roundCount, 0) + 1;
      for (const run of runningByTopic.get(summary.topic) ?? []) {
        const sessionId = snapshot?.sessions[run.agent] ?? null;
        if (sessionId && shouldResolveTranscripts) {
          addTranscript(transcripts, run.agent, sessionId, ws.resolvedRoot);
        }
        rounds.push({
          index: nextSyntheticRound++,
          agent: run.agent,
          fromAgent: null,
          mode: run.mode === 'running' ? 'running' : run.mode,
          verdict: 'unknown',
          startedAt: run.startedAt,
          durationMs: null,
          sessionId,
          promptPreview: 'Running handoff invocation',
          resultPreview: `pid ${run.pid} is still active`,
          hasTrace: false,
          isRunning: true,
          agentSteps: [
            { kind: 'process', label: 'Process alive', text: `pid ${run.pid} is still running.` },
            {
              kind: 'handoff',
              label: 'Awaiting durable event',
              text: 'The final history row is written after the child agent exits.',
            },
          ],
        });
      }

      rounds.sort((a, b) => a.index - b.index);
      topics.push({
        key: currentTopicKey,
        slug: summary.topic,
        workspace: wsSummary,
        summary: summary.summary,
        lifecycle: summary.lifecycle,
        roundCount: snapshot?.round_count ?? summary.roundCount,
        createdAt: snapshot?.created_at ?? summary.lastUsedAt,
        lastUsedAt: summary.lastUsedAt,
        sessions: {
          claude: summary.sessions.claude ?? null,
          codex: summary.sessions.codex ?? null,
          cursor: summary.sessions.cursor ?? null,
        },
        rounds,
      });
    }
  }

  topics.sort((a, b) => {
    const wsCmp = a.workspace.basename.localeCompare(b.workspace.basename);
    if (wsCmp !== 0) return wsCmp;
    return a.slug.localeCompare(b.slug);
  });

  const workspaceSummaries = workspaces.map(workspaceSummary);
  return {
    workspace: {
      root: options.allWorkspaces ? resolveStateDir() : workspace.resolvedRoot,
      basename: options.allWorkspaces ? 'all workspaces' : workspace.basename,
      hash: options.allWorkspaces ? String(workspaceSummaries.length).padStart(4, '0') : workspace.hash,
      dirName: options.allWorkspaces ? 'all' : workspace.dirName,
      scope: options.allWorkspaces ? 'all' : 'workspace',
      releaseVersion: handoffVersion(),
      schemaVersion: SCHEMA_VERSION,
      pointer: pointer?.current_topic ?? null,
      stateDir: resolveStateDir(),
      workspaces: workspaceSummaries,
    },
    running,
    topics,
    transcripts,
  };
}

export function listAllWorkspaceDirs(): string[] {
  const sessionsRoot = join(resolveStateDir(), 'sessions');
  try {
    return readdirSync(sessionsRoot).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}

function listUiWorkspaces(current: WorkspaceInfo): WorkspaceInfo[] {
  const byDir = new Map<string, WorkspaceInfo>();
  byDir.set(current.dirName, current);
  for (const dirName of listAllWorkspaceDirs()) {
    const ws = workspaceFromStateDir(dirName);
    if (ws) byDir.set(dirName, ws);
  }
  return [...byDir.values()].sort((a, b) => {
    const nameCmp = a.basename.localeCompare(b.basename);
    if (nameCmp !== 0) return nameCmp;
    return a.dirName.localeCompare(b.dirName);
  });
}

function workspaceFromStateDir(dirName: string): WorkspaceInfo | null {
  const dir = join(resolveStateDir(), 'sessions', dirName);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    if (name.endsWith('.history.jsonl')) continue;
    if (name.startsWith('.')) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as {
        workspace?: {
          resolvedRoot?: string;
          basename?: string;
          hash?: string;
          fromGit?: boolean;
        };
      };
      const ws = raw.workspace;
      if (!ws?.resolvedRoot || !ws.basename || !ws.hash) continue;
      return {
        resolvedRoot: ws.resolvedRoot,
        basename: ws.basename,
        hash: ws.hash,
        dirName,
        fromGit: Boolean(ws.fromGit),
        aliased: false,
        gitProbe: ws.fromGit ? 'ok' : 'not-a-repo',
      };
    } catch {
      continue;
    }
  }
  return null;
}

function workspaceSummary(ws: WorkspaceInfo): UiWorkspaceSummary {
  return {
    root: ws.resolvedRoot,
    basename: ws.basename,
    hash: ws.hash,
    dirName: ws.dirName,
  };
}

function handoffVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(runtimeRepoRoot(import.meta.url), 'package.json'), 'utf-8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function addTranscript(
  out: Record<string, { sourcePath: string; turns: UiTurn[] }>,
  agent: AgentName,
  sessionId: string,
  workspaceRoot: string
): void {
  const key = `${agent}:${sessionId}`;
  if (out[key]) return;
  const resolved = resolveTranscriptTurns(agent, sessionId, workspaceRoot);
  if (!resolved) return;
  out[key] = {
    sourcePath: resolved.sourcePath,
    turns: resolved.turns.slice(-200).map(turnToUi),
  };
}

function turnToUi(turn: TranscriptTurn): UiTurn {
  const meta = toolMeta(turn.raw);
  const name = meta.toolName ?? (isToolTurn(turn) ? (/^([\w.-]+)/.exec(turn.text)?.[1] ?? turn.role) : undefined);
  return {
    role: turn.role,
    text: turn.text,
    ts: turn.ts,
    ...(name ? { name } : {}),
    ...(meta.toolUseId ? { toolUseId: meta.toolUseId } : {}),
    ...(meta.toolName ? { toolName: meta.toolName } : {}),
    ...(meta.isError !== undefined ? { isError: meta.isError } : {}),
  };
}

function toolMeta(raw: unknown): { toolUseId?: string; toolName?: string; isError?: boolean } {
  if (!raw || typeof raw !== 'object') return {};
  const envelope = raw as {
    message?: { content?: unknown };
    payload?: { type?: string; name?: string; id?: string; call_id?: string };
  };
  if (envelope.payload?.type === 'function_call') {
    const meta: { toolUseId?: string; toolName?: string; isError?: boolean } = {};
    const id = envelope.payload.call_id ?? envelope.payload.id;
    if (id) meta.toolUseId = id;
    if (envelope.payload.name) meta.toolName = envelope.payload.name;
    return meta;
  }
  const content = envelope.message?.content;
  if (!Array.isArray(content)) return {};
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as {
      type?: string;
      id?: string;
      tool_use_id?: string;
      name?: string;
      is_error?: boolean;
    };
    if (p.type === 'tool_use') {
      const meta: { toolUseId?: string; toolName?: string; isError?: boolean } = {};
      if (p.id) meta.toolUseId = p.id;
      if (p.name) meta.toolName = p.name;
      return meta;
    }
    if (p.type === 'tool_result') {
      const meta: { toolUseId?: string; toolName?: string; isError?: boolean } = {};
      if (p.tool_use_id) meta.toolUseId = p.tool_use_id;
      if (p.is_error !== undefined) meta.isError = p.is_error;
      return meta;
    }
  }
  return {};
}

function traceToSpans(trace: { prompt: string; output: string; duration_ms: number | null }): UiTraceSpan[] {
  return [
    { kind: 'trace', name: 'prompt captured', durationMs: Math.min(trace.prompt.length, 1000) },
    { kind: 'agent', name: 'agent runtime', durationMs: trace.duration_ms ?? 0 },
    { kind: 'trace', name: 'output captured', durationMs: Math.min(trace.output.length, 1000) },
  ];
}

function eventToSteps(
  event: Extract<EventV1, { kind: 'created' | 'invocation' }>,
  trace: { prompt: string; output: string } | undefined,
  sessionId: string | null
): UiAgentStep[] {
  const steps: UiAgentStep[] = [
    {
      kind: event.kind,
      label: event.kind === 'created' ? 'Topic created' : 'Invocation recorded',
      text: `Handoff stored round ${event.round} for ${event.agent}/${event.mode}.`,
    },
  ];
  steps.push(
    sessionId
      ? { kind: 'session', label: 'Session pointer captured', text: sessionId }
      : { kind: 'session', label: 'No session pointer', text: 'Native chat cannot be resolved for this round.' }
  );
  steps.push(
    trace
      ? { kind: 'trace', label: 'Trace body stored', text: 'Prompt and output are available from handoff trace storage.' }
      : { kind: 'trace', label: 'No trace body', text: 'Only categorical history metadata is available for this round.' }
  );
  if (event.kind === 'invocation') {
    steps.push({
      kind: 'verdict',
      label: `Verdict ${event.verdict}`,
      text: event.duration_ms === null ? 'No duration recorded.' : `Completed in ${event.duration_ms}ms.`,
    });
  }
  return steps;
}

function preview(text: string, max = 220): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}...` : compact;
}
