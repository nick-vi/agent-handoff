#!/usr/bin/env bun
/**
 * agent-handoff CLI entry.
 *
 * Subcommands:
 *   send       — invoke an agent on a topic (creates or resumes)
 *   list       — list topics in current workspace
 *   show       — print snapshot + history for a topic
 *   archive    — move a topic to archive/
 *   prune      — clean archive/ down to retention envelope
 *   help       — print usage
 *
 * The CLI is intentionally one entry point dispatching by subcommand
 * rather than five separate scripts. Keeps PATH small, matches how
 * `npx skills` ships single-binary skills.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { listAliases, removeAlias, setAlias, suggestMovedWorkspaces } from '../lib/aliases.ts';
import { AGENTS, resolveAgent, UnknownAgentError } from '../lib/agents/index.ts';
import {
  archiveTopic,
  createTopic,
  getActiveTopics,
  listTopicSummaries,
  loadSnapshot,
  pruneArchives,
  readHistory,
  recordInvocation,
  resetSession,
  restoreArchivedTopic,
  trimActiveHistories,
  TopicAlreadyExistsError,
  TopicNotFoundError,
  workspaceDir,
  type ArchiveResult,
  type TopicSummary,
} from '../lib/registry.ts';
import {
  RESUME_CONFIRM_DAYS,
  requiresResumeConfirmation,
  shouldResumeAgentSession,
} from '../lib/lifecycle.ts';
import { clearPointer, readPointer, setPointer } from '../lib/pointer.ts';
import { readCursorChat, type CursorTurn } from '../lib/agents/cursor-sqlite.ts';
import { CURSOR_BUILTIN_MODEL_DEFAULT } from '../lib/agents/cursor.ts';
import { resolveLocalSession } from '../lib/local-sessions.ts';
import {
  cancelRunning,
  clearRunning,
  listRunning,
  markRunning,
} from '../lib/running.ts';
import { resolveStateDir } from '../lib/state-dir.ts';
import { TopicSlugError, validateTopic } from '../lib/slug.ts';
import { readTraces, traceFilePath, writeTrace } from '../lib/trace.ts';
import { parseSince } from '../lib/duration.ts';
import {
  composePromptWithPlan,
  formatAge,
  listPlanHistoryRounds,
  planPath,
  readPlan,
  readPlanSnapshot,
  snapshotPlanIfChanged,
  writePlan,
} from '../lib/plan.ts';
import { resolveWorkspace } from '../lib/workspace.ts';
import {
  agentDefaultsPath,
  envNamesForAgent,
  getStoredAgentDefaults,
  resolveAgentDefaults,
  setAgentDefaults,
  unsetAgentDefaults,
} from '../lib/model-defaults.ts';
import { startUiServer } from '../lib/ui-server.ts';
import { buildUiSnapshot, listAllWorkspaceDirs } from '../lib/ui-snapshot.ts';
import {
  cursorTurnToTranscript,
  isSystemTurn,
  isToolTurn,
  parseTurn,
  type TranscriptTurn,
} from '../lib/transcripts.ts';
import type { AgentAdapter } from '../lib/agents/base.ts';
import type { AgentName, EventV1, Mode } from '../lib/schema/v1.ts';
import {
  closeSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { AtomicFile } from '../lib/atomic-file.ts';

const NEST_DEPTH_VAR = 'AGENT_HANDOFF_DEPTH';
const NEST_TOKEN_VAR = 'AGENT_HANDOFF_TOKEN';
const CONTEXT_TOPIC_VAR = 'AGENT_HANDOFF_TOPIC';
const CONTEXT_WORKSPACE_ROOT_VAR = 'AGENT_HANDOFF_WORKSPACE_ROOT';
const CONTEXT_WORKSPACE_DIR_VAR = 'AGENT_HANDOFF_WORKSPACE_DIR';
const CONTEXT_RUN_ID_VAR = 'AGENT_HANDOFF_RUN_ID';
const CONTEXT_PARENT_RUN_ID_VAR = 'AGENT_HANDOFF_PARENT_RUN_ID';
const CONTEXT_CALLER_AGENT_VAR = 'AGENT_HANDOFF_CALLER_AGENT';
const DEFAULT_OUTPUT_PREVIEW_CHARS = 12_000;

/**
 * Per-run marker so the recursion guard can tell "actual nesting"
 * (handoff parent set this) from "stale env var" (some unrelated parent
 * shell exported `AGENT_HANDOFF_DEPTH=1` and never cleaned up). The
 * value isn't checked back — only its presence matters — so any
 * collision-resistant random string is fine.
 */
function mintNestToken(): string {
  return `r${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function mintRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function detectCallerAgent(): AgentName | null {
  const explicit = process.env[CONTEXT_CALLER_AGENT_VAR];
  if (explicit === 'claude' || explicit === 'codex' || explicit === 'cursor') return explicit;
  if (process.env.CODEX_THREAD_ID || process.env.CODEX_CI) return 'codex';
  if (process.env.CLAUDECODE || process.env.CLAUDE_AGENT_SDK_VERSION) return 'claude';
  if (process.env.CURSOR_AGENT || process.env.CURSOR_TRACE_ID) return 'cursor';
  return null;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    printUsage();
    return 0;
  }

  switch (sub) {
    case 'send':
      return await cmdSend(rest);
    case 'list':
    case 'ls':
      return cmdList(rest);
    case 'show':
      return cmdShow(rest);
    case 'result':
      return cmdResult(rest);
    case 'archive':
      return await cmdArchive(rest);
    case 'prune':
      return await cmdPrune(rest);
    case 'use':
      return cmdUse(rest);
    case 'clear':
      return cmdClear(rest);
    case 'status':
      return cmdStatus(rest);
    case 'doctor':
      return cmdDoctor(rest);
    case 'model':
    case 'models':
      return cmdModel(rest);
    case 'alias':
      return cmdAlias(rest);
    case 'reset-session':
      return await cmdResetSession(rest);
    case 'tail':
      return await cmdTail(rest);
    case 'log':
      return cmdLog(rest);
    case 'plan':
      return await cmdPlan(rest);
    case 'cancel':
      return cmdCancel(rest);
    case 'watch':
      return await cmdWatch(rest);
    case 'history':
      return cmdHistory(rest);
    case 'ui':
      return await cmdUi(rest);
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      printUsage();
      return 2;
  }
}

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

async function cmdSend(argv: string[]): Promise<number> {
  const args = parseFlags(argv, {
    string: ['agent', 'mode', 'topic', 'summary', 'workspace', 'prompt-file', 'prompt'],
    boolean: [
      'resume',
      'new-topic',
      'archive-and-new',
      'allow-nested',
      'current',
      'store-trace',
      'no-plan',
      'snapshot-plan-on-edit',
      'clean-env',
    ],
  });

  // Anti-recursion guard. Refuse only if BOTH the depth counter is set
  // AND a handoff-owned marker token is present — otherwise a stale
  // `AGENT_HANDOFF_DEPTH=1` left in a parent shell from a prior session
  // would block all direct user invocations.
  const depthRaw = process.env[NEST_DEPTH_VAR];
  const depth = depthRaw ? Number.parseInt(depthRaw, 10) : 0;
  const incomingToken = process.env[NEST_TOKEN_VAR];
  const trulyNested = depth >= 1 && Boolean(incomingToken);
  if (trulyNested && !boolFlag(args, 'allow-nested')) {
    console.error(
      `Refusing nested handoff invocation (${NEST_DEPTH_VAR}=${depth}). ` +
        `Pass --allow-nested if you really want this.`
    );
    return 3;
  }

  const agentName = strFlag(args, 'agent');
  const modeName = strFlag(args, 'mode');
  let topicSlug = strFlag(args, 'topic');
  if (!agentName) {
    console.error('Missing required --agent');
    return 2;
  }
  if (!modeName) {
    console.error('Missing required --mode');
    return 2;
  }

  const prompt = readPrompt(strFlag(args, 'prompt-file'), strFlag(args, 'prompt'));
  if (prompt === null) {
    console.error('Provide a prompt via --prompt or --prompt-file (or pipe stdin).');
    return 2;
  }

  let agent;
  try {
    agent = resolveAgent(agentName);
  } catch (err) {
    if (err instanceof UnknownAgentError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }

  const mode = modeName as Mode;
  if (!agent.supportedModes.includes(mode)) {
    console.error(
      `Mode "${mode}" not supported by agent "${agent.name}". ` +
        `Supported: ${agent.supportedModes.join(', ')}.`
    );
    return 2;
  }

  const cwd = strFlag(args, 'workspace') ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  const useCurrent = boolFlag(args, 'current');
  if (topicSlug && useCurrent) {
    console.error('Use either --topic <slug> or --current, not both.');
    return 2;
  }

  // Topic resolution:
  //   1. explicit --topic
  //   2. explicit --current opt-in to the project-local pointer
  //   3. inherited AGENT_HANDOFF_TOPIC from a parent handoff invocation
  //   4. hard error with active-topic guidance
  //
  // Implicit pointer fallback is intentionally avoided for parallel agents:
  // one shared .handoff/current.json could route unrelated process trees to
  // different topics depending on timing.
  if (!topicSlug) {
    if (useCurrent) {
      const pointer = readPointer(workspace);
      if (pointer?.current_topic) {
        topicSlug = pointer.current_topic;
        console.error(`[handoff] using current topic from .handoff/current.json: ${topicSlug}`);
      } else {
        const active = getActiveTopics(workspace);
        console.error('No current topic set in .handoff/current.json.');
        if (active.length > 0) {
          console.error('Active topics in this workspace:');
          printTopicList(active);
          console.error('');
          console.error('Pick one with `--topic <slug>` or set a default with `handoff use <slug>`.');
        } else {
          console.error('Pass `--topic <slug>` to create a topic.');
        }
        return 2;
      }
    } else if (process.env[CONTEXT_TOPIC_VAR]) {
      topicSlug = process.env[CONTEXT_TOPIC_VAR];
      console.error(`[handoff] using topic from ${CONTEXT_TOPIC_VAR}: ${topicSlug}`);
    } else {
      const active = getActiveTopics(workspace);
      if (active.length > 0) {
        console.error('No --topic given and no inherited AGENT_HANDOFF_TOPIC. Active topics:');
        printTopicList(active);
        console.error('');
        console.error('Pick one with `--topic <slug>`, inherit via AGENT_HANDOFF_TOPIC,');
        console.error('or explicitly use `.handoff/current.json` with `--current`.');
        console.error('For a fresh thread, pass `--new-topic --topic <fresh-slug>`.');
        return 2;
      }
      console.error(
        'Missing required topic. Pass --topic <slug>, inherit AGENT_HANDOFF_TOPIC, or pass --current.'
      );
      return 2;
    }
  }

  try {
    validateTopic(topicSlug);
  } catch (err) {
    if (err instanceof TopicSlugError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }

  const existing = loadSnapshot(workspace, topicSlug);
  let snapshot = existing;
  // Set when --archive-and-new clears a pointer that previously matched
  // this slug. After the new topic is successfully created, the pointer
  // is restored to the same slug. On create failure, the rollback path
  // restores everything in compensation.
  let restorePointerAfterCreate: string | null = null;
  // Set when --archive-and-new actually moved a topic to archive. If
  // the agent invocation succeeds but the subsequent `createTopic`
  // fails (lock timeout, FS error, schema migration regression, …),
  // we use this to roll the archive back so the brief that already
  // got sent has a topic to record against on the next attempt.
  let archivedForRollback: ArchiveResult | null = null;

  if (existing) {
    if (boolFlag(args, 'archive-and-new')) {
      // Pointer ordering: clear before the rename + agent call so a
      // crash mid-archive doesn't leave a pointer that aims at a
      // half-archived topic. After successful create below, restore
      // the pointer to the same slug if it had previously matched —
      // the new topic shares the slug and the user clearly meant for
      // it to be the cwd default.
      const ptrBefore = readPointer(workspace);
      const pointerWasAimedHere = ptrBefore?.current_topic === topicSlug;
      if (pointerWasAimedHere) clearPointer(workspace);
      archivedForRollback = await archiveTopic(workspace, topicSlug, 'archive_and_new');
      if (pointerWasAimedHere) {
        restorePointerAfterCreate = topicSlug;
      }
      snapshot = null;
    }
    // Topic-level continuity continues regardless; agent-side session
    // resume is mode-gated below via `shouldResumeAgentSession`. The
    // stale-confirmation check just ahead requires --resume on topics
    // inactive for >7d, independent of the per-mode session policy.
    if (snapshot && requiresResumeConfirmation(snapshot) && !boolFlag(args, 'resume')) {
      const ageHours = Math.round(
        (Date.now() - Date.parse(snapshot.last_used_at)) / 3_600_000
      );
      console.error(
        `Topic "${topicSlug}" last used ${ageHours}h ago (>${RESUME_CONFIRM_DAYS}d). ` +
          `Pass --resume to confirm intent, or --archive-and-new to start fresh.`
      );
      return 2;
    }
  } else {
    // New slug. Fail with list if active topics exist and caller didn't
    // explicitly opt in via --new-topic. Prevents fragmenting the
    // registry by typoing a near-miss of an existing slug.
    if (boolFlag(args, 'resume')) {
      console.error(
        `Cannot --resume: topic "${topicSlug}" does not exist yet. Drop the flag to create.`
      );
      return 2;
    }
    const active = getActiveTopics(workspace);
    if (active.length > 0 && !boolFlag(args, 'new-topic')) {
      console.error(
        `Topic "${topicSlug}" is new but this workspace has active topics already:`
      );
      printTopicList(active);
      console.error('');
      console.error(
        'If "${topicSlug}" is genuinely a new conceptual thread, pass --new-topic to confirm.'
          .replace('${topicSlug}', topicSlug)
      );
      console.error('Otherwise pick an existing slug above or `handoff use <slug>`.');
      return 2;
    }
  }

  // Resume policy lives in `lib/lifecycle.ts:shouldResumeAgentSession`
  // so production and tests both import the same predicate. The topic
  // itself threads continuity (round numbers, history) regardless of
  // whether the agent-side session is resumed; only the per-(topic, agent)
  // session ID pointer is gated.
  const wantResume = shouldResumeAgentSession(mode, boolFlag(args, 'resume'));
  const sessionId = wantResume ? (snapshot?.sessions[agent.name] ?? null) : null;
  const agentDefaults = resolveAgentDefaults(agent.name);

  // Plan auto-injection. Wraps the user prompt with a provenance
  // header so the receiving agent can see what context it was
  // handed and how fresh it is. `--no-plan` opts out; absence of a
  // plan file is silent (composePromptWithPlan returns the prompt
  // unchanged with injection=null).
  const noPlan = boolFlag(args, 'no-plan');
  const callerAgent = detectCallerAgent();
  const composed = noPlan
    ? { prompt, injection: null }
    : composePromptWithPlan(workspace, topicSlug, prompt);

  // Snapshot the env we're about to mutate so we can restore it after
  // the invoke. Without this, a parent shell's handoff env leftovers can
  // wedge subsequent direct user invocations or route them to the wrong
  // topic.
  const priorDepth = process.env[NEST_DEPTH_VAR];
  const priorToken = process.env[NEST_TOKEN_VAR];
  const priorTopic = process.env[CONTEXT_TOPIC_VAR];
  const priorWorkspaceRoot = process.env[CONTEXT_WORKSPACE_ROOT_VAR];
  const priorWorkspaceDir = process.env[CONTEXT_WORKSPACE_DIR_VAR];
  const priorRunId = process.env[CONTEXT_RUN_ID_VAR];
  const priorParentRunId = process.env[CONTEXT_PARENT_RUN_ID_VAR];
  const priorCallerAgent = process.env[CONTEXT_CALLER_AGENT_VAR];
  process.env[NEST_DEPTH_VAR] = String(depth + 1);
  process.env[NEST_TOKEN_VAR] = mintNestToken();
  process.env[CONTEXT_TOPIC_VAR] = topicSlug;
  process.env[CONTEXT_WORKSPACE_ROOT_VAR] = workspace.resolvedRoot;
  process.env[CONTEXT_WORKSPACE_DIR_VAR] = workspace.dirName;
  const runId = mintRunId();
  process.env[CONTEXT_RUN_ID_VAR] = runId;
  if (priorRunId) process.env[CONTEXT_PARENT_RUN_ID_VAR] = priorRunId;
  else delete process.env[CONTEXT_PARENT_RUN_ID_VAR];
  process.env[CONTEXT_CALLER_AGENT_VAR] = agent.name;
  const childEnv = buildChildEnv(boolFlag(args, 'clean-env'));

  // SIGINT handler: forward to the live child if there is one. Without
  // this, hitting Ctrl-C in the handoff parent kills the handoff process
  // but leaves the child orphaned (or, on macOS, kills it via the
  // process group anyway — but we want the controlled path).
  let livePid: number | null = null;
  const sigintForward = () => {
    if (livePid !== null) {
      try {
        process.kill(livePid, 'SIGINT');
      } catch {
        /* already dead */
      }
    }
  };
  process.on('SIGINT', sigintForward);

  let response;
  let wallMs: number;
  try {
    const t0 = Date.now();
    response = await agent.invoke({
      topic: topicSlug,
      mode,
      workspaceRoot: workspace.resolvedRoot,
      prompt: composed.prompt,
      sessionId,
      defaults: agentDefaults,
      env: childEnv,
      onSpawn: (pid) => {
        livePid = pid;
        const runOpts: { mode: Mode; runId: string; parentRunId?: string } = { mode, runId };
        if (process.env[CONTEXT_PARENT_RUN_ID_VAR]) {
          runOpts.parentRunId = process.env[CONTEXT_PARENT_RUN_ID_VAR];
        }
        markRunning(workspace, topicSlug, agent.name, pid, runOpts);
      },
    });
    wallMs = Date.now() - t0;
  } finally {
    process.off('SIGINT', sigintForward);
    livePid = null;
    clearRunning(workspace, topicSlug, agent.name, { runId });
    if (priorDepth === undefined) delete process.env[NEST_DEPTH_VAR];
    else process.env[NEST_DEPTH_VAR] = priorDepth;
    if (priorToken === undefined) delete process.env[NEST_TOKEN_VAR];
    else process.env[NEST_TOKEN_VAR] = priorToken;
    if (priorTopic === undefined) delete process.env[CONTEXT_TOPIC_VAR];
    else process.env[CONTEXT_TOPIC_VAR] = priorTopic;
    if (priorWorkspaceRoot === undefined) delete process.env[CONTEXT_WORKSPACE_ROOT_VAR];
    else process.env[CONTEXT_WORKSPACE_ROOT_VAR] = priorWorkspaceRoot;
    if (priorWorkspaceDir === undefined) delete process.env[CONTEXT_WORKSPACE_DIR_VAR];
    else process.env[CONTEXT_WORKSPACE_DIR_VAR] = priorWorkspaceDir;
    if (priorRunId === undefined) delete process.env[CONTEXT_RUN_ID_VAR];
    else process.env[CONTEXT_RUN_ID_VAR] = priorRunId;
    if (priorParentRunId === undefined) delete process.env[CONTEXT_PARENT_RUN_ID_VAR];
    else process.env[CONTEXT_PARENT_RUN_ID_VAR] = priorParentRunId;
    if (priorCallerAgent === undefined) delete process.env[CONTEXT_CALLER_AGENT_VAR];
    else process.env[CONTEXT_CALLER_AGENT_VAR] = priorCallerAgent;
  }

  // Persist outcome.
  if (snapshot === null) {
    try {
      await createTopic({
        workspace,
        topic: topicSlug,
        agent: agent.name,
        callerAgent,
        mode,
        summary: strFlag(args, 'summary') ?? null,
        promptForAutoSummary: prompt,
        initialSessionId: response.sessionId ?? null,
      });
      // Successful create. If --archive-and-new previously cleared a
      // matching pointer, restore it to the same slug — the user
      // clearly meant this slug to be the cwd default and the new
      // topic shares it.
      if (restorePointerAfterCreate) {
        setPointer(workspace, restorePointerAfterCreate);
      }
    } catch (err) {
      if (err instanceof TopicAlreadyExistsError) {
        // Lost race with another invocation. Treat as record-against-existing.
        await recordInvocation({
          workspace,
          topic: topicSlug,
          agent: agent.name,
          callerAgent,
          mode,
          sessionId: response.sessionId,
          verdict: response.verdict,
          durationMs: response.durationMs,
        });
      } else if (archivedForRollback) {
        // The agent already produced an artifact for the brief but
        // the new topic's snapshot couldn't be written. Roll the
        // archive back so the user (or a retry) has a topic to
        // record against. Without rollback, the brief was sent and
        // both the old AND new topic state is gone — pure data loss.
        console.error(
          `[handoff] createTopic failed after agent invocation; rolling archive back: ${(err as Error).message}`
        );
        restoreArchivedTopic(archivedForRollback);
        if (restorePointerAfterCreate) {
          setPointer(workspace, restorePointerAfterCreate);
        }
        throw err;
      } else {
        throw err;
      }
    }
  } else {
    await recordInvocation({
      workspace,
      topic: topicSlug,
      agent: agent.name,
      callerAgent,
      mode,
      sessionId: response.sessionId,
      verdict: response.verdict,
      durationMs: response.durationMs,
    });
  }

  const finalSnap = loadSnapshot(workspace, topicSlug);
  const round = finalSnap?.round_count ?? 1;

  // Store the full result before deciding how much to echo to stdout.
  let tracePathForRound: string | null = null;
  try {
    writeTrace(workspace, {
      schema_version: 1,
      topic: topicSlug,
      agent: agent.name,
      mode,
      round,
      ts: new Date().toISOString(),
      prompt: composed.prompt,
      output: response.output,
      session_id: response.sessionId ?? null,
      verdict: response.verdict,
      duration_ms: response.durationMs,
    });
    tracePathForRound = traceFilePath(workspace, topicSlug, round, agent.name);
  } catch (err) {
    console.error(
      `[handoff] warn: failed to write trace: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Optional plan snapshot — captures the plan as it was at this
  // round's content. Skipped when no plan exists, when plan content
  // hasn't changed since the last snapshot, or when --no-plan was
  // also passed (no point snapshotting a plan you intentionally
  // skipped this round). Default off; opt-in for forensic history.
  let planSnapshotPath: string | null = null;
  if (boolFlag(args, 'snapshot-plan-on-edit') && !noPlan) {
    try {
      const result = snapshotPlanIfChanged(workspace, topicSlug, round);
      if (result.snapshotted) planSnapshotPath = result.path;
    } catch (err) {
      console.error(
        `[handoff] warn: failed to snapshot plan: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Stdout: agent body + handoff footer.
  const resultCmd = `handoff result ${topicSlug} --round ${round} --agent ${agent.name} --part output`;
  writeAgentOutput(response.output, { tracePath: tracePathForRound, resultCmd });
  const planFooter = composed.injection
    ? ` plan=injected(${composed.injection.sizeBytes}B,${composed.injection.ageString})`
    : noPlan
      ? ' plan=skipped'
      : '';
  const snapFooter = planSnapshotPath ? ' plan-snapshot=written' : '';
  const envFooter = boolFlag(args, 'clean-env') ? ' env=clean' : '';
  const defaultsFooter = formatDefaultsFooter(agent.name, agentDefaults);
  const traceFooter = tracePathForRound ? ` trace=${tracePathForRound}` : ' trace=unavailable';
  console.log(
    `[handoff] topic=${topicSlug} agent=${agent.name} mode=${mode} ` +
      `session=${response.sessionId ?? 'none'} ` +
      `verdict=${response.verdict} duration_ms=${response.durationMs} wall_ms=${wallMs}` +
      defaultsFooter +
      traceFooter +
      planFooter +
      snapFooter +
      envFooter,
  );

  // Exit code mirrors verdict per codex's spec: ok/advisory → 0; blocked/error → nonzero.
  if (response.verdict === 'ok' || response.verdict === 'advisory') return 0;
  if (response.verdict === 'blocked') return 1;
  return 1;
}

// ---------------------------------------------------------------------------
// list / show / archive / prune
// ---------------------------------------------------------------------------

function cmdList(argv: string[]): number {
  const args = parseFlags(argv, { string: ['workspace'], boolean: ['stale', 'all'] });
  const cwd = strFlag(args, 'workspace') ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  const summaries = listTopicSummaries(workspace);
  const filter = boolFlag(args, 'stale')
    ? (s: TopicSummary) => s.lifecycle === 'stale'
    : boolFlag(args, 'all')
      ? () => true
      : (s: TopicSummary) => s.lifecycle === 'active';
  const visible = summaries.filter(filter);

  if (visible.length === 0) {
    console.log(`(no topics in ${workspace.dirName})`);
    if (summaries.length > 0 && !boolFlag(args, 'all')) {
      console.log(`Pass --all to include stale topics (${summaries.length} total).`);
    }
    return 0;
  }

  console.log(`workspace: ${workspace.resolvedRoot}`);
  console.log(`dir:       ${workspaceDir(workspace)}`);
  if (workspace.aliased) console.log(`(aliased)`);
  console.log('');
  printTopicList(visible);
  return 0;
}

function printTopicList(summaries: TopicSummary[]): void {
  for (const t of summaries) {
    const sessions =
      Object.entries(t.sessions)
        .filter(([, id]) => id)
        .map(([a, id]) => `${a}=${(id as string).slice(0, 8)}`)
        .join(', ') || 'none';
    const tag = t.lifecycle === 'stale' ? '[stale]' : '';
    console.log(
      `  ${t.topic.padEnd(36)} round=${t.roundCount} sessions=[${sessions}] last=${t.lastUsedAt.slice(0, 19)}Z ${tag}`
    );
    if (t.summary) console.log(`    ${t.summary}`);
  }
}

function cmdShow(argv: string[]): number {
  const args = parseFlags(argv, { string: ['workspace'], _: 'topic' });
  const topic = args.positional[0];
  if (!topic) {
    console.error('Usage: handoff show <topic>');
    return 2;
  }
  const cwd = strFlag(args, 'workspace') ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  const snap = loadSnapshot(workspace, topic);
  if (!snap) {
    console.error(`Topic "${topic}" not found in this workspace.`);
    return 1;
  }
  console.log(JSON.stringify(snap, null, 2));
  console.log('');
  console.log('--- history ---');
  for (const event of readHistory(workspace, topic)) {
    console.log(JSON.stringify(event));
  }
  return 0;
}

function cmdResult(argv: string[]): number {
  const args = parseFlags(argv, {
    string: ['workspace', 'round', 'agent', 'part'],
    boolean: ['latest', 'path', 'json'],
    _: 'topic',
  });
  const topic = args.positional[0];
  if (!topic) {
    console.error(
      'Usage: handoff result <topic> [--latest|--round N] [--agent <name>] ' +
        '[--part output|prompt|both|metadata] [--path|--json]'
    );
    return 2;
  }
  try {
    validateTopic(topic);
  } catch (err) {
    if (err instanceof TopicSlugError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }

  const agentRaw = strFlag(args, 'agent');
  let agent: AgentName | undefined;
  if (agentRaw !== undefined) {
    const parsed = parseAgentArg(agentRaw);
    if (!parsed) return 2;
    agent = parsed;
  }

  const roundRaw = strFlag(args, 'round');
  if (roundRaw && boolFlag(args, 'latest')) {
    console.error('Use either --latest or --round N, not both.');
    return 2;
  }
  let round: number | undefined;
  if (roundRaw) {
    round = Number.parseInt(roundRaw, 10);
    if (!Number.isFinite(round) || round < 1) {
      console.error(`--round must be a positive integer (got "${roundRaw}")`);
      return 2;
    }
  }

  const part = strFlag(args, 'part') ?? 'output';
  if (!['output', 'prompt', 'both', 'metadata'].includes(part)) {
    console.error(`--part must be output|prompt|both|metadata (got "${part}")`);
    return 2;
  }

  const cwd = strFlag(args, 'workspace') ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  const traces = readTraces(workspace, topic)
    .filter((trace) => (agent ? trace.agent === agent : true))
    .filter((trace) => (round ? trace.round === round : true));

  if (traces.length === 0) {
    const scope = [
      round ? `round ${round}` : 'latest round',
      agent ? `agent ${agent}` : null,
    ].filter(Boolean).join(', ');
    console.error(`No stored handoff result for topic "${topic}" (${scope}).`);
    return 1;
  }

  const trace = traces[traces.length - 1]!;
  if (boolFlag(args, 'path')) {
    console.log(traceFilePath(workspace, topic, trace.round, trace.agent));
    return 0;
  }
  if (boolFlag(args, 'json')) {
    console.log(JSON.stringify(trace, null, 2));
    return 0;
  }

  if (part === 'metadata') {
    const { prompt: _prompt, output: _output, ...metadata } = trace;
    console.log(JSON.stringify(metadata, null, 2));
    return 0;
  }
  if (part === 'prompt') {
    writeTextWithFinalNewline(trace.prompt);
    return 0;
  }
  if (part === 'both') {
    console.log('--- prompt ---');
    writeTextWithFinalNewline(trace.prompt);
    console.log('--- output ---');
    writeTextWithFinalNewline(trace.output);
    return 0;
  }

  writeTextWithFinalNewline(trace.output);
  return 0;
}

async function cmdArchive(argv: string[]): Promise<number> {
  const args = parseFlags(argv, { string: ['workspace'], _: 'topic' });
  const topic = args.positional[0];
  if (!topic) {
    console.error('Usage: handoff archive <topic>');
    return 2;
  }
  const cwd = strFlag(args, 'workspace') ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  try {
    const result = await archiveTopic(workspace, topic, 'manual');
    console.log(`archived: ${result.archivedSnapshot}`);
    console.log(`history:  ${result.archivedHistory}`);
    // If the cwd pointer was aimed at this topic, clear it. Otherwise
    // the next `handoff send --current` would route through a stale pointer
    // and recreate the archived slug as a new topic.
    const pointer = readPointer(workspace);
    if (pointer?.current_topic === topic) {
      clearPointer(workspace);
      console.log(`cleared:  .handoff/current.json (was pointing at ${topic})`);
    }
    return 0;
  } catch (err) {
    if (err instanceof TopicNotFoundError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
}

async function cmdPrune(argv: string[]): Promise<number> {
  const args = parseFlags(argv, {
    string: ['workspace', 'keep-count', 'keep-days', 'history-keep'],
  });
  const cwd = strFlag(args, 'workspace') ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  const opts: { keepCount?: number; keepDays?: number } = {};
  const keepCountStr = strFlag(args, 'keep-count');
  const keepDaysStr = strFlag(args, 'keep-days');
  if (keepCountStr) opts.keepCount = Number.parseInt(keepCountStr, 10);
  if (keepDaysStr) opts.keepDays = Number.parseInt(keepDaysStr, 10);
  const result = pruneArchives(workspace, opts);
  console.log(`removed ${result.removed.length} archive file(s)`);
  for (const path of result.removed) console.log(`  ${path}`);

  const histKeepStr = strFlag(args, 'history-keep');
  if (histKeepStr) {
    const keep = Number.parseInt(histKeepStr, 10);
    if (!Number.isFinite(keep) || keep < 1) {
      console.error(`--history-keep must be a positive integer (got "${histKeepStr}")`);
      return 2;
    }
    const { trimmed } = await trimActiveHistories(workspace, keep);
    const totalRemoved = trimmed.reduce((acc, t) => acc + t.removed, 0);
    console.log(`trimmed ${trimmed.length} history file(s), removed ${totalRemoved} line(s)`);
    for (const t of trimmed) console.log(`  ${t.topic}: removed ${t.removed}, kept ${t.kept}`);
  }
  return 0;
}

function cmdUse(argv: string[]): number {
  const args = parseFlags(argv, { string: ['workspace'], _: 'topic' });
  const topic = args.positional[0];
  if (!topic) {
    console.error('Usage: handoff use <topic>');
    return 2;
  }
  try {
    validateTopic(topic);
  } catch (err) {
    if (err instanceof TopicSlugError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  const cwd = strFlag(args, 'workspace') ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  // Don't require the topic to exist yet — `handoff use` ahead of
  // `send --current` is a valid pattern. But warn so a typo doesn't
  // silently stick.
  if (!loadSnapshot(workspace, topic)) {
    console.error(
      `Note: topic "${topic}" doesn't exist yet in this workspace. ` +
        `Pointer set anyway; first \`handoff send --current\` will create it.`
    );
  }
  setPointer(workspace, topic);
  console.log(`Current topic for ${workspace.basename}: ${topic}`);
  return 0;
}

function cmdClear(argv: string[]): number {
  const args = parseFlags(argv, { string: ['workspace'] });
  const cwd = strFlag(args, 'workspace') ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  clearPointer(workspace);
  console.log(`Cleared current topic pointer for ${workspace.basename}.`);
  return 0;
}

function cmdStatus(argv: string[]): number {
  const args = parseFlags(argv, { string: ['workspace'] });
  const cwd = strFlag(args, 'workspace') ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  const pointer = readPointer(workspace);
  const summaries = listTopicSummaries(workspace);
  const active = summaries.filter((s) => s.lifecycle === 'active');
  const stale = summaries.filter((s) => s.lifecycle === 'stale');

  console.log(`workspace: ${workspace.resolvedRoot}`);
  console.log(`dir:       ${workspaceDir(workspace)}${workspace.aliased ? ' (aliased)' : ''}`);
  console.log(`current:   ${pointer?.current_topic ?? '(none — set with `handoff use <slug>`)'}`);
  console.log('');
  if (active.length > 0) {
    console.log(`active topics (${active.length}):`);
    printTopicList(active);
  } else {
    console.log('(no active topics)');
  }
  if (stale.length > 0) {
    console.log('');
    console.log(`stale topics (${stale.length}):`);
    printTopicList(stale);
  }
  const running = listRunning(workspace);
  if (running.length > 0) {
    console.log('');
    console.log(`running rounds (${running.length}):`);
    for (const r of running) {
      console.log(
        `  ${r.topic.padEnd(36)} agent=${r.agent} pid=${r.pid} run=${r.run_id} started=${r.started_at}`
      );
    }
  }
  return 0;
}

function cmdDoctor(argv: string[]): number {
  const args = parseFlags(argv, { string: ['workspace'] });
  const cwd = strFlag(args, 'workspace') ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  const pointer = readPointer(workspace);
  const aliases = listAliases();

  console.log('agent-handoff doctor');
  console.log('==================');
  console.log('');
  console.log('binaries on PATH');
  for (const bin of ['bun', 'node', 'git', 'claude', 'codex', 'cursor-agent']) {
    const found = whichVersion(bin);
    console.log(
      `  ${bin.padEnd(14)} ${found ? `${found.path}  (${found.version})` : '(not found)'}`
    );
  }
  if (whichVersion('git') === null) {
    console.log(
      '  ⚠ git missing — every cwd inside a repo gets its own workspace hash. ' +
        'Topics fragment instead of sharing state across worktrees / subdirs.'
    );
  }
  console.log('');
  console.log('environment');
  console.log(`  cwd:                ${process.cwd()}`);
  console.log(`  AGENT_HANDOFF_DEPTH:  ${process.env[NEST_DEPTH_VAR] ?? '(unset)'}`);
  console.log(`  AGENT_HANDOFF_TOKEN:  ${process.env[NEST_TOKEN_VAR] ? '(set)' : '(unset)'}`);
  console.log(`  AGENT_HANDOFF_TOPIC:  ${process.env[CONTEXT_TOPIC_VAR] ?? '(unset)'}`);
  console.log(
    `  AGENT_HANDOFF_RUN_ID: ${process.env[CONTEXT_RUN_ID_VAR] ?? '(unset)'}`
  );
  console.log(`  XDG_DATA_HOME:      ${process.env.XDG_DATA_HOME ?? '(unset; using ~/.local/share)'}`);
  console.log(`  state dir:          ${resolveStateDir()}`);
  console.log('');
  console.log('workspace resolution');
  console.log(`  resolvedRoot:       ${workspace.resolvedRoot}`);
  console.log(`  basename:           ${workspace.basename}`);
  console.log(`  hash:               ${workspace.hash}`);
  console.log(`  dirName:            ${workspace.dirName}`);
  console.log(`  fromGit:            ${workspace.fromGit}`);
  console.log(`  gitProbe:           ${workspace.gitProbe}`);
  console.log(`  aliased:            ${workspace.aliased}`);
  console.log('');
  console.log('pointer');
  if (pointer) {
    console.log(`  set_at:             ${pointer.set_at}`);
    console.log(`  current_topic:      ${pointer.current_topic ?? '(null)'}`);
    console.log(`  workspace_hash:     ${pointer.workspace_hash}`);
  } else {
    console.log('  (no pointer file at .handoff/current.json)');
  }
  console.log('');
  console.log('aliases');
  if (Object.keys(aliases).length === 0) {
    console.log('  (none)');
  } else {
    for (const [path, hash] of Object.entries(aliases)) {
      console.log(`  ${path} → ${hash}`);
    }
  }
  console.log('');
  console.log('agent adapters');
  for (const [name, adapter] of Object.entries(AGENTS)) {
    console.log(
      `  ${name.padEnd(8)} resume=${adapter.supportsResume} modes=[${adapter.supportedModes.join(',')}]`
    );
  }
  console.log('');
  console.log('model defaults');
  printModelDefaults();
  return 0;
}

function cmdModel(argv: string[]): number {
  const args = parseFlags(argv, {
    string: ['model', 'effort', 'speed'],
    boolean: ['path', 'model-only', 'effort-only', 'speed-only'],
    _: 'action',
  });

  if (boolFlag(args, 'path')) {
    console.log(agentDefaultsPath());
    return 0;
  }

  const action = args.positional[0] ?? 'list';
  if (action === 'list') {
    printModelDefaults();
    console.log('');
    console.log(`path: ${agentDefaultsPath()}`);
    return 0;
  }

  if (action === 'set') {
    const agent = parseAgentArg(args.positional[1]);
    if (!agent) return 2;
    const positionalModel = args.positional[2];
    const model = strFlag(args, 'model') ?? positionalModel;
    const effort = strFlag(args, 'effort');
    let speed: 'fast' | 'default' | undefined;
    try {
      speed = normalizeSpeed(strFlag(args, 'speed'));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 2;
    }
    if (!model && !effort && !speed) {
      console.error('Usage: handoff model set <agent> <model> [--effort <level>] [--speed fast|default]');
      console.error('       handoff model set <agent> --model <model> [--effort <level>] [--speed fast|default]');
      return 2;
    }
    if (effort && agent === 'cursor') {
      console.error('Cursor Agent CLI does not expose a separate effort flag; set only --model.');
      return 2;
    }
    if (speed && agent === 'cursor') {
      console.error('Cursor Agent encodes speed in the model id; set --model composer-2.5-fast instead.');
      return 2;
    }
    const patch: { model?: string; effort?: string; speed?: 'fast' | 'default' } = {};
    if (model) patch.model = model;
    if (effort) patch.effort = effort;
    if (speed) patch.speed = speed;
    try {
      setAgentDefaults(agent, patch);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 2;
    }
    const resolved = resolveAgentDefaults(agent);
    console.log(formatModelLine(agent, resolved));
    console.log(`path: ${agentDefaultsPath()}`);
    return 0;
  }

  if (action === 'unset') {
    const agent = parseAgentArg(args.positional[1]);
    if (!agent) return 2;
    const unsetModel = boolFlag(args, 'model-only');
    const unsetEffort = boolFlag(args, 'effort-only');
    const unsetSpeed = boolFlag(args, 'speed-only');
    const fields =
      unsetModel || unsetEffort || unsetSpeed
        ? { model: unsetModel, effort: unsetEffort, speed: unsetSpeed }
        : { model: true, effort: true, speed: true };
    unsetAgentDefaults(agent, fields);
    console.log(formatModelLine(agent, resolveAgentDefaults(agent)));
    console.log(`path: ${agentDefaultsPath()}`);
    return 0;
  }

  console.error(
    'Usage:\n' +
      '  handoff model                         list defaults\n' +
      '  handoff model --path                  print backing JSON path\n' +
      '  handoff model set <agent> <model> [--effort <level>] [--speed fast|default]\n' +
      '  handoff model unset <agent> [--model-only|--effort-only|--speed-only]',
  );
  return 2;
}

function normalizeSpeed(raw: string | undefined): 'fast' | 'default' | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'fast') return 'fast';
  if (value === 'default' || value === 'standard') return 'default';
  throw new Error(`Unsupported speed "${raw}". Supported: fast, default.`);
}

function parseAgentArg(raw: string | undefined): AgentName | null {
  if (raw === 'claude' || raw === 'codex' || raw === 'cursor') return raw;
  console.error(raw ? `Unknown agent "${raw}". Supported: claude, codex, cursor.` : 'Missing agent.');
  return null;
}

function printModelDefaults(): void {
  for (const agent of ['claude', 'codex', 'cursor'] as const) {
    console.log(formatModelLine(agent, resolveAgentDefaults(agent)));
  }
}

function formatModelLine(agent: AgentName, resolved: ReturnType<typeof resolveAgentDefaults>): string {
  const stored = getStoredAgentDefaults(agent);
  const envNames = envNamesForAgent(agent);
  const modelText = resolved.model
    ? `${resolved.model} (${resolved.modelSource})`
    : agent === 'cursor'
      ? `${CURSOR_BUILTIN_MODEL_DEFAULT} (built-in)`
      : '(agent CLI default)';
  const effortText = resolved.effort
    ? `${resolved.effort} (${resolved.effortSource})`
    : agent === 'cursor'
      ? '(unsupported)'
      : '(agent CLI default)';
  const speedText = agent === 'cursor'
    ? '(model id)'
    : resolved.speed
      ? `${resolved.speed} (${resolved.speedSource})`
      : '(agent CLI default)';
  const storedText =
    stored.model || stored.effort || stored.speed
      ? ` stored=${[
          stored.model ? `model:${stored.model}` : null,
          stored.effort ? `effort:${stored.effort}` : null,
          stored.speed ? `speed:${stored.speed}` : null,
        ]
          .filter(Boolean)
          .join(',')}`
      : '';
  const envText =
    agent === 'cursor'
      ? envNames.model
      : `${envNames.model}, ${envNames.effort}, ${envNames.speed}`;
  return (
    `  ${agent.padEnd(8)} model=${modelText.padEnd(32)} effort=${effortText}` +
    ` speed=${speedText}` +
    ` env=[${envText}]` +
    storedText
  );
}

function cmdAlias(argv: string[]): number {
  const args = parseFlags(argv, {
    string: ['path', 'hash'],
    boolean: ['list', 'remove', 'suggest'],
    _: 'action',
  });

  if (boolFlag(args, 'suggest')) {
    const candidates = suggestMovedWorkspaces();
    if (candidates.length === 0) {
      console.log('(no moved-workspace candidates detected)');
      return 0;
    }
    console.log('Workspaces with topics whose recorded path no longer exists.');
    console.log('Candidates for `handoff alias <new-path> <hash>`:');
    console.log('');
    for (const c of candidates) {
      console.log(`  hash=${c.hash}  topics=${c.topicCount}  last=${c.lastUsedAt ?? '?'}`);
      console.log(`    recorded root: ${c.recordedRoot}`);
      console.log(`    suggested:     handoff alias <new-resolved-path> ${c.hash}`);
      console.log('');
    }
    return 0;
  }

  if (boolFlag(args, 'list') || args.positional.length === 0) {
    const aliases = listAliases();
    if (Object.keys(aliases).length === 0) {
      console.log('(no aliases)');
      return 0;
    }
    for (const [path, hash] of Object.entries(aliases)) {
      console.log(`${path} → ${hash}`);
    }
    return 0;
  }

  if (boolFlag(args, 'remove')) {
    const path = args.positional[0];
    if (!path) {
      console.error('Usage: handoff alias --remove <resolved-path>');
      return 2;
    }
    const removed = removeAlias(path);
    console.log(removed ? `removed alias for ${path}` : `(no alias for ${path})`);
    return 0;
  }

  // alias <resolved-path> <hash>
  const path = args.positional[0];
  const hash = args.positional[1];
  if (!path || !hash) {
    console.error(
      'Usage:\n' +
        '  handoff alias <resolved-path> <workspace-hash>   add\n' +
        '  handoff alias --list                             list\n' +
        '  handoff alias --remove <resolved-path>           remove'
    );
    return 2;
  }
  if (!/^[0-9a-f]{12}$/i.test(hash)) {
    console.error(`Invalid hash "${hash}" — must be 12 hex chars.`);
    return 2;
  }
  setAlias(path, hash.toLowerCase());
  console.log(`alias: ${path} → ${hash.toLowerCase()}`);
  return 0;
}

async function cmdResetSession(argv: string[]): Promise<number> {
  const args = parseFlags(argv, {
    string: ['agent', 'workspace', 'reason'],
    _: 'topic',
  });
  const topic = args.positional[0];
  if (!topic) {
    console.error('Usage: handoff reset-session <topic> --agent <name> [--reason manual|expired|crashed]');
    return 2;
  }
  const agentName = strFlag(args, 'agent');
  if (!agentName) {
    console.error('Missing required --agent');
    return 2;
  }
  if (agentName !== 'claude' && agentName !== 'codex' && agentName !== 'cursor') {
    console.error(`Unknown agent "${agentName}". Supported: claude, codex, cursor.`);
    return 2;
  }
  const reasonStr = strFlag(args, 'reason') ?? 'manual';
  if (reasonStr !== 'manual' && reasonStr !== 'expired' && reasonStr !== 'crashed') {
    console.error(`Invalid --reason "${reasonStr}". Must be manual | expired | crashed.`);
    return 2;
  }
  const cwd = strFlag(args, 'workspace') ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  try {
    const result = await resetSession(workspace, topic, agentName, reasonStr);
    if (result.previousSessionId === null) {
      console.log(`(${agentName} session for ${topic} was already null; no-op)`);
    } else {
      console.log(
        `reset ${agentName} session for ${topic} (was ${result.previousSessionId.slice(0, 8)}…)`
      );
      console.log(`Next consult/debug round will mint a fresh session.`);
    }
    return 0;
  } catch (err) {
    if (err instanceof TopicNotFoundError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// tail / log
// ---------------------------------------------------------------------------

/**
 * `handoff tail <topic>` — stream new history events as they're appended.
 *
 * Starts at EOF by default (or byte 0 with --from-start), then polls for
 * appended bytes. Each new line is parsed as an EventV1 and pretty-printed.
 *
 * Exits on SIGINT. Polling is deliberate because fs.watch is inconsistent
 * for append-only writes across platforms.
 */
async function cmdTail(argv: string[]): Promise<number> {
  const args = parseFlags(argv, {
    string: ['workspace'],
    boolean: ['from-start'],
  });
  const topic = args.positional[0];
  if (!topic) {
    console.error('Usage: handoff tail <topic> [--from-start]');
    return 2;
  }
  try {
    validateTopic(topic);
  } catch (err) {
    if (err instanceof TopicSlugError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  const cwd = strFlag(args, 'workspace') ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  const file = join(workspaceDir(workspace), `${topic}.history.jsonl`);

  let offset = 0;
  if (boolFlag(args, 'from-start')) {
    offset = 0;
  } else {
    try {
      offset = statSync(file).size;
    } catch {
      offset = 0;
    }
  }

  // Initial flush — print everything from `offset` to current EOF.
  offset = await tailFlush(file, offset);

  console.error(`[handoff] tailing ${topic} (Ctrl-C to stop)`);

  // Polling loop — simple and portable. fs.watch fires inconsistently
  // for append-only writes on macOS / Linux, so we poll size + read
  // delta. 500ms is the sweet spot for human responsiveness vs CPU.
  let stop = false;
  process.on('SIGINT', () => {
    stop = true;
  });
  while (!stop) {
    await new Promise((r) => setTimeout(r, 500));
    offset = await tailFlush(file, offset);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

/**
 * `handoff cancel <topic> [--agent <name>] [--run-id <id>] [--signal SIG]` —
 * send a signal to a live child for the topic. Default signal is
 * SIGINT (graceful "Ctrl-C as if the human hit it"); pass `--signal
 * SIGTERM` for a harder stop. The handoff process holding the lock
 * will see the child close, run its `finally`, and clear the running
 * file.
 *
 * If filters match exactly one running entry, that one is cancelled.
 * If multiple entries match, the call refuses with the list to
 * disambiguate.
 */
function cmdCancel(argv: string[]): number {
  const args = parseFlags(argv, { string: ['agent', 'run-id', 'signal', 'workspace'] });
  const topic = args.positional[0];
  if (!topic) {
    console.error('Usage: handoff cancel <topic> [--agent <name>] [--run-id <id>] [--signal SIGINT|SIGTERM|SIGKILL]');
    return 2;
  }
  try {
    validateTopic(topic);
  } catch (err) {
    if (err instanceof TopicSlugError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  const cwd = strFlag(args, 'workspace') ?? process.cwd();
  const workspace = resolveWorkspace(cwd);

  const sigRaw = strFlag(args, 'signal') ?? 'SIGINT';
  const allowedSignals = ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP'] as const;
  if (!(allowedSignals as readonly string[]).includes(sigRaw)) {
    console.error(`--signal must be one of ${allowedSignals.join(', ')} (got "${sigRaw}")`);
    return 2;
  }
  const signal = sigRaw as (typeof allowedSignals)[number];

  const explicitAgent = strFlag(args, 'agent');
  const runIdFilter = strFlag(args, 'run-id');
  let target: { agent: AgentName; pid: number; runId: string };
  const runningForTopic = listRunning(workspace).filter((r) => r.topic === topic);
  if (explicitAgent) {
    let resolved: AgentAdapter;
    try {
      resolved = resolveAgent(explicitAgent);
    } catch (err) {
      if (err instanceof UnknownAgentError) {
        console.error(err.message);
        return 2;
      }
      throw err;
    }
    const matches = runningForTopic.filter(
      (r) => r.agent === resolved.name && (!runIdFilter || r.run_id === runIdFilter)
    );
    const selected = selectRunningTarget(matches, topic, runIdFilter);
    if (!selected) return matches.length > 1 ? 2 : 1;
    target = { agent: selected.agent, pid: selected.pid, runId: selected.run_id };
  } else {
    const matches = runningForTopic.filter((r) => !runIdFilter || r.run_id === runIdFilter);
    const selected = selectRunningTarget(matches, topic, runIdFilter);
    if (!selected) return matches.length > 1 ? 2 : 1;
    target = { agent: selected.agent, pid: selected.pid, runId: selected.run_id };
  }

  const result = cancelRunning(workspace, topic, target.agent, signal, { runId: target.runId });
  if (!result.delivered) {
    console.error(`Failed to deliver ${signal} to ${target.agent} pid=${target.pid}.`);
    return 1;
  }
  console.log(`Sent ${signal} to ${target.agent} pid=${target.pid} run=${target.runId} (topic=${topic}).`);
  return 0;
}

function selectRunningTarget(
  matches: ReturnType<typeof listRunning>,
  topic: string,
  runIdFilter: string | undefined
): ReturnType<typeof listRunning>[number] | null {
  if (matches.length === 0) {
    console.error(
      runIdFilter
        ? `No running round for "${topic}" with run_id=${runIdFilter}.`
        : `No running rounds for "${topic}".`
    );
    return null;
  }
  if (matches.length > 1) {
    console.error(`Multiple running rounds for "${topic}":`);
    for (const r of matches) {
      console.error(
        `  ${r.agent.padEnd(8)} pid=${r.pid} run=${r.run_id} started=${r.started_at}`
      );
    }
    console.error('Pass --agent <name> and/or --run-id <id> to disambiguate.');
    return null;
  }
  return matches[0]!;
}

// ---------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------

/**
 * `handoff watch <topic>` — tail each agent's local conversation file
 * for the topic's recorded sessions. Lets the user observe a live
 * round's progress (which tool calls, which messages) without
 * interrupting the run.
 *
 * Per-agent file layouts live in `lib/local-sessions.ts`. Cursor uses
 * SQLite and is not tailable; the watcher prints a one-line note and
 * skips it.
 */
async function cmdWatch(argv: string[]): Promise<number> {
  const args = parseFlags(argv, {
    string: ['workspace', 'agent'],
    boolean: ['from-start'],
  });
  const topic = args.positional[0];
  if (!topic) {
    console.error('Usage: handoff watch <topic> [--agent <name>] [--from-start]');
    return 2;
  }
  try {
    validateTopic(topic);
  } catch (err) {
    if (err instanceof TopicSlugError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  const cwd = strFlag(args, 'workspace') ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  const snapshot = loadSnapshot(workspace, topic);
  if (!snapshot) {
    console.error(`Topic "${topic}" not found in this workspace.`);
    return 1;
  }

  const filterAgent = strFlag(args, 'agent');
  const targets: Array<{ agent: AgentName; path: string; kind: 'file' | 'sqlite-cursor' }> = [];
  for (const [agentName, sessionId] of Object.entries(snapshot.sessions) as Array<
    [AgentName, string | null | undefined]
  >) {
    if (filterAgent && agentName !== filterAgent) continue;
    if (!sessionId) {
      console.error(`[handoff] ${agentName}: no session id recorded for "${topic}"`);
      continue;
    }
    const res = resolveLocalSession(agentName, sessionId, workspace.resolvedRoot);
    if (res.kind === 'file') {
      console.error(`[handoff] ${agentName}: tailing ${res.path}`);
      targets.push({ agent: agentName, path: res.path, kind: 'file' });
    } else if (res.kind === 'sqlite-cursor') {
      console.error(`[handoff] ${agentName}: polling sqlite ${res.path}`);
      targets.push({ agent: agentName, path: res.path, kind: 'sqlite-cursor' });
    } else {
      console.error(`[handoff] ${agentName}: ${res.reason}`);
    }
  }

  if (targets.length === 0) {
    console.error('Nothing to tail.');
    return 1;
  }

  const offsets = new Map<string, number>();
  const cursorRoots = new Map<string, string | null>();
  for (const t of targets) {
    if (t.kind === 'file') {
      let size = 0;
      try {
        size = boolFlag(args, 'from-start') ? 0 : statSync(t.path).size;
      } catch {
        size = 0;
      }
      offsets.set(t.path, size);
    } else {
      // sqlite-cursor: track last-seen root blob id for incremental polls.
      cursorRoots.set(t.path, boolFlag(args, 'from-start') ? null : 'PRIME');
    }
  }

  for (const t of targets) {
    if (t.kind === 'file') {
      const next = await tailRaw(t.path, offsets.get(t.path) ?? 0, t.agent);
      offsets.set(t.path, next);
    } else {
      // PRIME means "first poll: skip what's there, just snap the root".
      if (cursorRoots.get(t.path) === 'PRIME') {
        const r = readCursorChat(t.path);
        cursorRoots.set(t.path, r.rootBlobId);
      } else {
        const r = readCursorChat(t.path);
        for (const w of r.warnings) console.error(`[handoff] ${t.agent}: ${w}`);
        for (const turn of r.turns) printCursorTurn(t.agent, turn);
        cursorRoots.set(t.path, r.rootBlobId);
      }
    }
  }

  console.error('[handoff] watching (Ctrl-C to stop)');
  let stop = false;
  process.on('SIGINT', () => {
    stop = true;
  });
  while (!stop) {
    await new Promise((r) => setTimeout(r, 500));
    for (const t of targets) {
      if (t.kind === 'file') {
        const next = await tailRaw(t.path, offsets.get(t.path) ?? 0, t.agent);
        offsets.set(t.path, next);
      } else {
        const seenRoot = cursorRoots.get(t.path) ?? null;
        const r = readCursorChat(t.path, { sinceRootBlobId: seenRoot });
        if (r.rootBlobId !== seenRoot) {
          for (const w of r.warnings) console.error(`[handoff] ${t.agent}: ${w}`);
          // sinceRootBlobId tracking gates the rescan, so r.turns
          // contains the full new transcript when the root changed.
          // Emit only turns we haven't shown — easy proxy: skip turns
          // whose blobId hash was already in the prior list. Simpler
          // first cut: just print all of them.
          for (const turn of r.turns) printCursorTurn(t.agent, turn);
          cursorRoots.set(t.path, r.rootBlobId);
        }
      }
    }
  }
  return 0;
}

function printCursorTurn(agent: AgentName, turn: CursorTurn): void {
  const text = turn.text.length > 200 ? `${turn.text.slice(0, 197)}…` : turn.text;
  console.log(`[${agent}] ${turn.role.padEnd(10)} ${text || '(no body)'}`);
}

/**
 * Tail a JSONL file, printing each new line prefixed with the agent
 * name + a coarse summary. Falls back to the raw line if the JSON
 * doesn't have a recognized shape — different agents emit different
 * envelopes and we'd rather show something than silently swallow.
 */
async function tailRaw(file: string, fromOffset: number, agent: AgentName): Promise<number> {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return fromOffset;
  }
  if (size <= fromOffset) return fromOffset;
  const fd = openSync(file, 'r');
  try {
    const length = size - fromOffset;
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, fromOffset);
    const text = buf.toString('utf-8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      printAgentTranscriptLine(agent, trimmed);
    }
    return size;
  } finally {
    closeSync(fd);
  }
}

function printAgentTranscriptLine(agent: AgentName, line: string): void {
  const turn = parseTurn(line);
  if (!turn) return;
  const ts = turn.ts ? `${turn.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}  ` : '';
  const text = turn.text.length > 200 ? `${turn.text.slice(0, 197)}…` : turn.text;
  console.log(`[${agent}] ${ts}${turn.role.padEnd(10)} ${text || '(no body)'}`);
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

/**
 * `handoff history <topic> [--agent <name>] [--last N] [--full]
 *                       [--format compact|json|raw]` — read the
 * resolved local conversation file(s) and print a compact view.
 *
 * Goal: let a calling agent (or the user) inspect what an agent
 * actually said without paying the token cost of slurping the full
 * conversation envelope. Default format strips system prompt,
 * caching headers, tool-call payloads down to a one-liner per turn.
 *
 * `--last N` (default 20) keeps the most recent N turns. `--full`
 * is shorthand for "no truncation, full message bodies." `--format
 * raw` dumps the source file unmodified — useful when the compact
 * view loses something you need.
 */
function cmdHistory(argv: string[]): number {
  const args = parseFlags(argv, {
    string: ['workspace', 'agent', 'last', 'format'],
    boolean: ['full', 'no-tools', 'skip-system', 'stats'],
  });
  const topic = args.positional[0];
  if (!topic) {
    console.error(
      'Usage: handoff history <topic> [--agent <name>] [--last N] [--full]\n' +
        '                          [--format compact|json|raw] [--no-tools]\n' +
        '                          [--skip-system] [--stats]'
    );
    return 2;
  }
  try {
    validateTopic(topic);
  } catch (err) {
    if (err instanceof TopicSlugError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  const cwd = strFlag(args, 'workspace') ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  const snapshot = loadSnapshot(workspace, topic);
  if (!snapshot) {
    console.error(`Topic "${topic}" not found in this workspace.`);
    return 1;
  }
  const last = Number.parseInt(strFlag(args, 'last') ?? '20', 10);
  if (!Number.isFinite(last) || last < 1) {
    console.error(`--last must be a positive integer (got "${strFlag(args, 'last')}")`);
    return 2;
  }
  const formatRaw = strFlag(args, 'format') ?? (boolFlag(args, 'full') ? 'json' : 'compact');
  if (!['compact', 'json', 'raw'].includes(formatRaw)) {
    console.error(`--format must be compact|json|raw (got "${formatRaw}")`);
    return 2;
  }
  const format = formatRaw as 'compact' | 'json' | 'raw';

  const filterAgent = strFlag(args, 'agent');
  const sessions = Object.entries(snapshot.sessions) as Array<
    [AgentName, string | null | undefined]
  >;
  let exitCode = 0;
  for (const [agentName, sessionId] of sessions) {
    if (filterAgent && agentName !== filterAgent) continue;
    if (!sessionId) {
      console.log(`# ${agentName}: (no session id recorded)\n`);
      continue;
    }
    const res = resolveLocalSession(agentName, sessionId, workspace.resolvedRoot);
    if (res.kind === 'unsupported' || res.kind === 'missing') {
      console.log(`# ${agentName} (${sessionId}): ${res.reason}\n`);
      continue;
    }
    console.log(`# ${agentName} (${sessionId})`);
    console.log(`# ${res.path}`);
    console.log('');
    let turns: TranscriptTurn[];
    if (res.kind === 'sqlite-cursor') {
      const result = readCursorChat(res.path);
      for (const w of result.warnings) console.error(`[handoff] cursor: ${w}`);
      if (format === 'raw') {
        for (const t of result.turns) console.log(JSON.stringify(t.raw));
        console.log('');
        continue;
      }
      turns = result.turns.map(cursorTurnToTranscript);
    } else {
      // res.kind === 'file' — JSONL agents (claude/codex)
      if (format === 'raw') {
        try {
          process.stdout.write(readFileSync(res.path, 'utf-8'));
        } catch (err) {
          console.error(`failed to read ${res.path}: ${(err as Error).message}`);
          exitCode = 1;
        }
        continue;
      }
      let lines: string[];
      try {
        lines = readFileSync(res.path, 'utf-8').split('\n').filter((l) => l.length > 0);
      } catch (err) {
        console.error(`failed to read ${res.path}: ${(err as Error).message}`);
        exitCode = 1;
        continue;
      }
      turns = lines.map((l) => parseTurn(l)).filter((t): t is TranscriptTurn => t !== null);
    }
    const filtered = turns.filter((t) => {
      if (boolFlag(args, 'no-tools') && isToolTurn(t)) return false;
      if (boolFlag(args, 'skip-system') && isSystemTurn(t)) return false;
      return true;
    });
    if (boolFlag(args, 'stats')) {
      printStats(filtered);
      console.log('');
      continue;
    }
    const tail = filtered.slice(-last);
    for (const turn of tail) {
      printTurn(turn, format, boolFlag(args, 'full'));
    }
    console.log('');
  }
  return exitCode;
}

function printStats(turns: TranscriptTurn[]): void {
  const byRole = new Map<string, number>();
  const byTool = new Map<string, number>();
  for (const t of turns) {
    byRole.set(t.role, (byRole.get(t.role) ?? 0) + 1);
    if (isToolTurn(t)) {
      // Tool name precedes the first `(` in the compact body.
      const m = /^([\w.-]+)\s*\(/.exec(t.text);
      const name = m?.[1] ?? '(unknown)';
      byTool.set(name, (byTool.get(name) ?? 0) + 1);
    }
  }
  const total = turns.length;
  console.log(`turns: ${total}`);
  for (const [role, n] of [...byRole.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${role.padEnd(12)} ${n}`);
  }
  if (byTool.size > 0) {
    const top = [...byTool.entries()].sort((a, b) => b[1] - a[1]);
    const summary = top.map(([name, n]) => `${name}×${n}`).join(', ');
    console.log(`tool calls: ${summary}`);
  }
}

function printTurn(turn: TranscriptTurn, format: 'compact' | 'json', full: boolean): void {
  if (format === 'json') {
    console.log(JSON.stringify(turn.raw));
    return;
  }
  const ts = turn.ts ? `${turn.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}  ` : '';
  const limit = full ? Number.POSITIVE_INFINITY : 200;
  const body =
    turn.text.length > limit ? `${turn.text.slice(0, limit - 1)}…` : turn.text || '(no body)';
  console.log(`${ts}${turn.role.padEnd(10)} ${body}`);
}

async function tailFlush(file: string, fromOffset: number): Promise<number> {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return fromOffset;
  }
  if (size <= fromOffset) return fromOffset;
  const fd = openSync(file, 'r');
  try {
    const length = size - fromOffset;
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, fromOffset);
    const text = buf.toString('utf-8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as EventV1;
        printEvent(event);
      } catch {
        // Mid-write line; the next flush will re-read from the same
        // offset because we only advance on full-line success.
      }
    }
    return size;
  } finally {
    closeSync(fd);
  }
}

function printEvent(e: EventV1): void {
  const ts = e.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  if (e.kind === 'invocation') {
    console.log(
      `${ts}  round=${e.round} agent=${e.agent} mode=${e.mode} ` +
        `verdict=${e.verdict} duration=${e.duration_ms ?? '?'}ms ` +
        `session=${e.session_id ?? 'none'}`,
    );
  } else if (e.kind === 'created') {
    console.log(
      `${ts}  CREATED agent=${e.agent} mode=${e.mode} ` +
        `session=${e.session_id ?? 'none'} summary=${e.summary ?? '(none)'}`,
    );
  } else if (e.kind === 'archived') {
    console.log(`${ts}  ARCHIVED reason=${e.reason}`);
  } else if (e.kind === 'session_reset') {
    console.log(
      `${ts}  RESET agent=${e.agent} reason=${e.reason} ` +
        `was=${e.previous_session_id ?? 'none'}`,
    );
  }
}

/**
 * `handoff log [--since 1h|1d|7d] [--all-workspaces]` — time-ordered
 * cross-topic history.
 *
 * Default: events from the current workspace, last 24h. Pass
 * `--all-workspaces` to merge across every workspace under the state
 * dir (useful for "what did I do across all projects").
 */
function cmdLog(argv: string[]): number {
  const args = parseFlags(argv, {
    string: ['since', 'workspace'],
    boolean: ['all-workspaces'],
  });
  const sinceFlag = strFlag(args, 'since') ?? '1d';
  const cutoffMs = parseSince(sinceFlag);
  if (cutoffMs === null) {
    console.error(`Invalid --since "${sinceFlag}". Format: <N>{m,h,d} (e.g. 30m, 2h, 7d).`);
    return 2;
  }
  const cutoff = Date.now() - cutoffMs;

  const cwd = strFlag(args, 'workspace') ?? process.cwd();
  const allWorkspaces = boolFlag(args, 'all-workspaces');

  type Entry = { event: EventV1; topic: string; workspace: string };
  const entries: Entry[] = [];

  const workspaceDirs = allWorkspaces ? listAllWorkspaceDirs() : [resolveWorkspace(cwd).dirName];
  const sessionsRoot = join(resolveStateDir(), 'sessions');

  for (const wsDirName of workspaceDirs) {
    const dir = join(sessionsRoot, wsDirName);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.history.jsonl')) continue;
      const topic = name.slice(0, -'.history.jsonl'.length);
      const path = join(dir, name);
      let raw: string;
      try {
        raw = readFileSync(path, 'utf-8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as EventV1;
          if (Date.parse(event.ts) >= cutoff) {
            entries.push({ event, topic, workspace: wsDirName });
          }
        } catch {
          // skip malformed line
        }
      }
    }
  }

  entries.sort((a, b) => Date.parse(a.event.ts) - Date.parse(b.event.ts));

  if (entries.length === 0) {
    console.log(`(no events in last ${sinceFlag})`);
    return 0;
  }

  for (const { event, topic, workspace } of entries) {
    const ts = event.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
    const wsTag = allWorkspaces ? `${workspace}/` : '';
    if (event.kind === 'invocation') {
      console.log(
        `${ts}  ${wsTag}${topic}  round=${event.round} ${event.agent}/${event.mode} ` +
          `verdict=${event.verdict} ${event.duration_ms ?? '?'}ms`,
      );
    } else if (event.kind === 'created') {
      console.log(`${ts}  ${wsTag}${topic}  CREATED by ${event.agent}/${event.mode}`);
    } else if (event.kind === 'archived') {
      console.log(`${ts}  ${wsTag}${topic}  ARCHIVED (${event.reason})`);
    } else if (event.kind === 'session_reset') {
      console.log(`${ts}  ${wsTag}${topic}  RESET ${event.agent} (${event.reason})`);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// ui
// ---------------------------------------------------------------------------

async function cmdUi(argv: string[]): Promise<number> {
  const args = parseFlags(argv, {
    string: ['workspace', 'host', 'port'],
    boolean: ['open', 'all-workspaces', 'unsafe-host', 'no-transcripts', 'include-transcripts'],
  });
  const cwd = strFlag(args, 'workspace') ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  const allWorkspaces = boolFlag(args, 'all-workspaces');
  const host = strFlag(args, 'host') ?? '127.0.0.1';
  const portRaw = strFlag(args, 'port') ?? '17345';
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    console.error(`--port must be 0..65535 (got "${portRaw}")`);
    return 2;
  }

  return startUiServer({
    workspace,
    allWorkspaces,
    host,
    port,
    open: boolFlag(args, 'open'),
    unsafeHost: boolFlag(args, 'unsafe-host'),
    noTranscripts: boolFlag(args, 'no-transcripts'),
    includeTranscripts: boolFlag(args, 'include-transcripts'),
    buildSnapshot: (options) => buildUiSnapshot(workspace, options),
  });
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

/**
 * `handoff plan <topic>` — view, edit, and inspect a topic's plan.
 *
 * Plans are execution scaffolding stored in shared state at
 * `<state-dir>/sessions/<workspace>/plans/<topic>.md`. Auto-injected
 * into `handoff send` prompts (with provenance header) unless
 * `--no-plan` is passed.
 *
 * Subactions (mutually exclusive):
 *   (default)        cat current plan to stdout
 *   --edit           open in $EDITOR; create file if missing
 *   --path           print absolute path
 *   --inspect        print exactly what would be injected on next send
 *                    (header + body + footer)
 *   --history        list round numbers that have snapshotted plans
 *   --diff R1..R2    diff two snapshots
 *   --export <path>  copy current plan to <path> (e.g. into the repo)
 *   --set <text>     write inline content (caller supplies via shell)
 *   --set-file <p>   read content from file (handier than --set)
 *   --delete         remove the plan file (history snapshots untouched)
 */
async function cmdPlan(argv: string[]): Promise<number> {
  const args = parseFlags(argv, {
    string: ['workspace', 'diff', 'export', 'set', 'set-file'],
    boolean: ['edit', 'path', 'inspect', 'history', 'delete'],
  });
  const topic = args.positional[0];
  if (!topic) {
    console.error(
      'Usage: handoff plan <topic> [--edit | --path | --inspect | --history | ' +
        '--diff R1..R2 | --export <path> | --set <text> | --set-file <path> | --delete]',
    );
    return 2;
  }
  try {
    validateTopic(topic);
  } catch (err) {
    if (err instanceof TopicSlugError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  const cwd = strFlag(args, 'workspace') ?? process.cwd();
  const workspace = resolveWorkspace(cwd);

  // Mutating actions first (--edit, --set, --set-file, --delete, --export).
  if (boolFlag(args, 'edit')) {
    return cmdPlanEdit(workspace, topic);
  }
  const setText = strFlag(args, 'set');
  if (typeof setText === 'string') {
    writePlan(workspace, topic, setText.endsWith('\n') ? setText : `${setText}\n`);
    console.error(`[handoff] wrote plan: ${planPath(workspace, topic)}`);
    return 0;
  }
  const setFile = strFlag(args, 'set-file');
  if (setFile) {
    if (!existsSync(setFile)) {
      console.error(`File not found: ${setFile}`);
      return 2;
    }
    const body = readFileSync(setFile, 'utf-8');
    writePlan(workspace, topic, body);
    console.error(`[handoff] wrote plan: ${planPath(workspace, topic)} (from ${setFile})`);
    return 0;
  }
  if (boolFlag(args, 'delete')) {
    const path = planPath(workspace, topic);
    if (existsSync(path)) {
      unlinkSync(path);
      console.error(`[handoff] deleted plan: ${path}`);
    } else {
      console.error(`(no plan to delete at ${path})`);
    }
    return 0;
  }
  const exportPath = strFlag(args, 'export');
  if (exportPath) {
    const state = readPlan(workspace, topic);
    if (state.content === null) {
      console.error(`(no plan exists for topic ${topic})`);
      return 1;
    }
    new AtomicFile(exportPath).write(state.content);
    console.error(`[handoff] exported plan to ${exportPath}`);
    return 0;
  }

  // Read-only actions.
  if (boolFlag(args, 'path')) {
    process.stdout.write(`${planPath(workspace, topic)}\n`);
    return 0;
  }
  if (boolFlag(args, 'history')) {
    const rounds = listPlanHistoryRounds(workspace, topic);
    if (rounds.length === 0) {
      console.log('(no plan history; pass --snapshot-plan-on-edit to handoff send to capture)');
      return 0;
    }
    for (const r of rounds) {
      console.log(`round ${r}`);
    }
    return 0;
  }
  const diffSpec = strFlag(args, 'diff');
  if (diffSpec) {
    const m = /^(\d+)\.\.(\d+)$/.exec(diffSpec);
    if (!m) {
      console.error(`--diff format: <round>..<round>, got ${diffSpec}`);
      return 2;
    }
    const r1 = Number.parseInt(m[1]!, 10);
    const r2 = Number.parseInt(m[2]!, 10);
    const a = readPlanSnapshot(workspace, topic, r1);
    const b = readPlanSnapshot(workspace, topic, r2);
    if (a === null || b === null) {
      console.error(`one or both snapshots missing: r1=${r1} r2=${r2}`);
      return 1;
    }
    // Defer to git diff for nice output if available; else just dump
    // both with separators. Most users will want git diff.
    const tmp1 = `/tmp/handoff-plan-${topic}-${r1}.md`;
    const tmp2 = `/tmp/handoff-plan-${topic}-${r2}.md`;
    writeFileSync(tmp1, a, 'utf-8');
    writeFileSync(tmp2, b, 'utf-8');
    spawnSync('git', ['--no-pager', 'diff', '--no-index', '--', tmp1, tmp2], {
      stdio: 'inherit',
    });
    return 0;
  }
  if (boolFlag(args, 'inspect')) {
    const state = readPlan(workspace, topic);
    if (state.content === null) {
      console.log(`(no plan to inject for topic ${topic})`);
      return 0;
    }
    const composed = composePromptWithPlan(workspace, topic, '<USER_PROMPT_GOES_HERE>');
    process.stdout.write(composed.prompt);
    if (!composed.prompt.endsWith('\n')) process.stdout.write('\n');
    return 0;
  }

  // Default: cat current plan.
  const state = readPlan(workspace, topic);
  if (state.content === null) {
    console.log(
      `(no plan for topic ${topic}; create with --edit or --set or --set-file)`,
    );
    return 0;
  }
  process.stdout.write(state.content);
  if (!state.content.endsWith('\n')) process.stdout.write('\n');
  console.error(
    `[handoff] ${planPath(workspace, topic)} (last edited ${formatAge(state.lastModified!)})`,
  );
  return 0;
}

function cmdPlanEdit(workspace: ReturnType<typeof resolveWorkspace>, topic: string): number {
  const path = planPath(workspace, topic);
  // Ensure parent dir + at-least-empty file so $EDITOR doesn't fail
  // on a non-existent path.
  if (!existsSync(path)) {
    writePlan(workspace, topic, '');
  }
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'vi';
  const result = spawnSync(editor, [path], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`[handoff] editor exited with code ${result.status}`);
    return result.status ?? 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readPrompt(file: string | undefined, inline: string | undefined): string | null {
  if (inline && inline.length > 0) return inline;
  if (file && existsSync(file)) return readFileSync(file, 'utf-8');
  // Fall back to stdin if anything was piped.
  if (!process.stdin.isTTY) {
    try {
      return readFileSync(0, 'utf-8');
    } catch {
      return null;
    }
  }
  return null;
}

const CLEAN_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'WINDIR',
]);

function buildChildEnv(clean: boolean): NodeJS.ProcessEnv {
  if (!clean) return process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('AGENT_HANDOFF_') || key.startsWith('LC_') || CLEAN_ENV_KEYS.has(key)) {
      env[key] = value;
    }
  }
  return env;
}

function writeAgentOutput(
  output: string,
  opts: { tracePath: string | null; resultCmd: string },
): void {
  const limit = outputPreviewLimit();
  if (!opts.tracePath || output.length <= limit) {
    writeTextWithFinalNewline(output);
    return;
  }

  console.log(`[handoff] full output stored: ${opts.tracePath}`);
  console.log(`[handoff] retrieve: ${opts.resultCmd}`);
  console.log(`[handoff] output preview: first ${limit} of ${output.length} chars`);
  writeTextWithFinalNewline(output.slice(0, limit));
  console.log('[handoff] stdout preview truncated; use the retrieve command above for complete output.');
}

function writeTextWithFinalNewline(text: string): void {
  process.stdout.write(text);
  if (!text.endsWith('\n')) process.stdout.write('\n');
}

function outputPreviewLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENT_HANDOFF_OUTPUT_PREVIEW_CHARS;
  if (!raw) return DEFAULT_OUTPUT_PREVIEW_CHARS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_OUTPUT_PREVIEW_CHARS;
  return parsed;
}

function formatDefaultsFooter(
  agent: AgentName,
  defaults: ReturnType<typeof resolveAgentDefaults>,
): string {
  const parts: string[] = [];
  if (defaults.model) {
    parts.push(`model=${defaults.model}(${defaults.modelSource})`);
  } else if (agent === 'cursor') {
    parts.push(`model=${CURSOR_BUILTIN_MODEL_DEFAULT}(built-in)`);
  }
  if (defaults.effort && agent !== 'cursor') {
    parts.push(`effort=${defaults.effort}(${defaults.effortSource})`);
  }
  if (defaults.speed && agent !== 'cursor') {
    parts.push(`speed=${defaults.speed}(${defaults.speedSource})`);
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

type FlagSpec = {
  string?: readonly string[];
  boolean?: readonly string[];
  /** When set, positional args after flags collect into `.positional`. */
  _?: string;
};

type ParsedFlags = {
  flags: Record<string, string | boolean | undefined>;
  positional: string[];
};

/** Read a string-typed flag. Returns undefined if absent or non-string. */
function strFlag(p: ParsedFlags, key: string): string | undefined {
  const v = p.flags[key];
  return typeof v === 'string' ? v : undefined;
}

/** Read a boolean-typed flag. Returns false unless explicitly true. */
function boolFlag(p: ParsedFlags, key: string): boolean {
  return p.flags[key] === true;
}

/** Thrown when an unknown flag is encountered — caught by main() for clean exit. */
export class UnknownFlagError extends Error {
  constructor(readonly flag: string, readonly known: string[]) {
    const suggestion = closest(flag, known);
    const hint = suggestion ? ` Did you mean --${suggestion}?` : '';
    super(`Unknown flag --${flag}.${hint}`);
    this.name = 'UnknownFlagError';
  }
}

/**
 * Strict flag parser. Unknown flags throw rather than coercing to bool —
 * silent typos like `--workspce` would otherwise fall through to the
 * default cwd, masking the user's intent. Hard error makes typos
 * actionable at the CLI boundary.
 */
function parseFlags(argv: string[], spec: FlagSpec): ParsedFlags {
  const flags: Record<string, string | boolean | undefined> = {};
  const positional: string[] = [];
  const stringSet = new Set(spec.string ?? []);
  const boolSet = new Set(spec.boolean ?? []);
  const known = [...stringSet, ...boolSet];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    if (token.startsWith('--')) {
      const eqIdx = token.indexOf('=');
      const key = eqIdx >= 0 ? token.slice(2, eqIdx) : token.slice(2);
      const valueInline = eqIdx >= 0 ? token.slice(eqIdx + 1) : null;
      if (boolSet.has(key)) {
        flags[key] = valueInline === null ? true : valueInline !== 'false';
      } else if (stringSet.has(key)) {
        if (valueInline !== null) {
          flags[key] = valueInline;
        } else {
          const next = argv[i + 1];
          if (next !== undefined && !next.startsWith('--')) {
            flags[key] = next;
            i++;
          }
        }
      } else {
        throw new UnknownFlagError(key, known);
      }
    } else {
      positional.push(token);
    }
  }

  return { flags, positional };
}

/**
 * Closest-match for typo suggestions. Returns the candidate within
 * Levenshtein distance ≤ 2 of `target`, or null. Cheap edit-distance
 * implementation — flag count per command is tiny.
 */
function closest(target: string, candidates: string[]): string | null {
  let best: { name: string; dist: number } | null = null;
  for (const c of candidates) {
    const d = levenshtein(target, c);
    if (d > 2) continue;
    if (best === null || d < best.dist) best = { name: c, dist: d };
  }
  return best?.name ?? null;
}

/**
 * Resolve a binary on `PATH` and read its `--version` output. Used by
 * `handoff doctor` to surface tooling-side problems before they surface
 * as opaque handoff failures. `--version` is not always reliable across
 * agents; we capture stdout and stderr and trim. Empty version field
 * means binary exists but didn't speak `--version`.
 */
function whichVersion(bin: string): { path: string; version: string } | null {
  const which = spawnSync('which', [bin], { encoding: 'utf-8' });
  if (which.status !== 0) return null;
  const path = which.stdout.trim();
  if (!path) return null;
  const ver = spawnSync(bin, ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const version = (ver.stdout || ver.stderr).split('\n')[0]?.trim() ?? '';
  return { path, version: version || '(no --version output)' };
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      dp[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, dp[j]!, dp[j - 1]!);
      prev = tmp;
    }
  }
  return dp[n]!;
}

function printUsage(): void {
  console.log(`agent-handoff — hand work between CLI agents with topic-pinned continuity

Usage:
  handoff send --agent <name> --mode <mode> [--topic <slug>|--current] [options]
  handoff list [--all|--stale] [--workspace <path>]
  handoff show <topic> [--workspace <path>]
  handoff result <topic> [--latest|--round N] [--agent <name>] [--workspace <path>]
                 [--part output|prompt|both|metadata] [--path|--json]
  handoff status [--workspace <path>]
  handoff use <topic> [--workspace <path>]
  handoff clear [--workspace <path>]
  handoff archive <topic> [--workspace <path>]
  handoff reset-session <topic> --agent <name> [--reason ...]
  handoff prune [--keep-count N] [--keep-days N] [--workspace <path>]
  handoff model [set <agent> <model> [--effort <level>] [--speed fast|default] | unset <agent> | --path]
  handoff alias <resolved-path> <hash> | --list | --remove <path> | --suggest
  handoff doctor [--workspace <path>]
  handoff ui [--workspace <path>] [--all-workspaces]
           [--host 127.0.0.1] [--port 17345] [--no-transcripts]
  handoff tail <topic> [--from-start] [--workspace <path>]
  handoff log [--since 1d] [--all-workspaces] [--workspace <path>]
  handoff watch <topic> [--agent <name>] [--from-start] [--workspace <path>]
  handoff history <topic> [--agent <name>] [--last N] [--full|--stats]
  handoff cancel <topic> [--agent <name>] [--run-id <id>]
               [--signal SIGINT|SIGTERM|SIGKILL]
  handoff plan <topic> [--edit|--path|--inspect|--history|--diff R1..R2|
                      --export <path>|--set-file <path>|--delete]

Send options:
  --agent <claude|codex|cursor>  Target agent.
  --mode <execute|review|audit|debug|consult>
                                 Mode of work; agent must support it.
  --topic <slug>                 Topic slug. Top-level agent workflows should
                                 pass this explicitly.
  --current                      Opt into .handoff/current.json. Intended for
                                 human terminal convenience, not parallel
                                 agent routing.
  --summary "<text>"             One-line description (set on create).
  --prompt "<text>"              Inline prompt.
  --prompt-file <path>           Read prompt from file. (Or pipe stdin.)
  --workspace <path>             Override cwd.
  --resume                       Confirm intent to resume a stale topic.
  --new-topic                    Confirm intent to create a fresh slug
                                 when other active topics exist.
  --archive-and-new              Archive existing snapshot+history; create fresh.
  --allow-nested                 Override nested-call refusal.
  --store-trace                  Compatibility no-op. Handoff now always
                                 stores full prompt+output as a trace file
                                 under traces/<topic>/<round>-<agent>.json.
  --no-plan                      Skip auto-injection of the topic's plan.
  --snapshot-plan-on-edit        After send, snapshot plan to history if
                                 content changed since last snapshot.
  --clean-env                    Spawn the child with a minimal environment:
                                 PATH/HOME/shell/locale/temp/XDG plus
                                 AGENT_HANDOFF_* context only.

Discovery:
  handoff use <topic>              Set the per-cwd default topic for --current.
  handoff status                   Show current pointer + active/stale topics.
  handoff list                     List active topics (use --all for all).
  handoff result <topic>           Print a stored full prompt/output result.
  handoff model                    View or set skill-owned model defaults.
  handoff doctor                   Print resolution diagnostic.

Live monitoring:
  handoff tail <topic>             Stream new history events for one topic.
                                 Pass --from-start to print existing events too.
  handoff log --since 24h          Time-ordered events across topics in this
                                 workspace. Pass --all-workspaces to merge
                                 across every workspace under the state dir.
                                 Duration formats: 30m, 2h, 7d.
  handoff ui                       Start a read-only local browser UI over
                                 topics, rounds, running files, traces, and
                                 native transcripts for this workspace.
                                 Pass --all-workspaces to aggregate every
                                 workspace bucket under the state dir.
                                 Non-loopback --host requires --unsafe-host.
                                 On unsafe hosts, transcripts are disabled
                                 unless --include-transcripts is explicit.
  handoff watch <topic>            Tail native agent transcript files.
  handoff history <topic>          Print compact native transcript history.
  handoff cancel <topic>           Signal a live child agent process. Use
                                 --run-id when multiple matching runs exist.

Plan artifacts (execution scaffolding, NOT project memory):
  handoff plan <topic>             View / manage the per-topic plan. Plans
                                 live in shared state and are auto-injected
                                 into send prompts (with provenance header)
                                 unless --no-plan. They are throwaway —
                                 once execution lands, the git diff is the
                                 artifact. Promote to repo via --export
                                 when worth preserving.

State dir:    ${resolveStateDir()}

Topic resolution for send:
  --topic wins. --current explicitly reads .handoff/current.json. Otherwise,
  handoff uses inherited AGENT_HANDOFF_TOPIC from a parent handoff invocation.
`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
main(argv)
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof UnknownFlagError) {
      console.error(err.message);
      process.exit(2);
    }
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  });
