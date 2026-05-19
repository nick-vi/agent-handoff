/**
 * Agent adapter contract — what every agent (claude / codex / cursor)
 * must implement so the handoff wrapper can speak to it uniformly.
 *
 * The adapter owns:
 *   - CLI invocation shape (binary, flags, env)
 *   - Session resume support (codex: yes; cursor: no; claude: yes)
 *   - Output parsing (extract verdict + new session id from stdout)
 *
 * The wrapper owns:
 *   - Brief assembly (objective/scope/etc)
 *   - Topic registry CRUD
 *   - Session decision (resume vs new)
 *
 * This split keeps agent-specific quirks isolated. Adding a new agent =
 * one file in this directory + one entry in the dispatcher table.
 */

import type { AgentName, Mode, Verdict } from '../schema/v1.ts';

/**
 * Inputs to an agent invocation. The wrapper builds this struct from the
 * brief + the registry's view of session state, then hands it to the
 * adapter's `invoke()`.
 */
export type AgentRequest = {
  topic: string;
  mode: Mode;
  workspaceRoot: string;
  /** Full prompt text (brief + any caller framing). */
  prompt: string;
  /**
   * Existing session ID to resume. Null means "new session". Adapters
   * for agents without resume support ignore this.
   */
  sessionId: string | null;
  /** Environment passed to the spawned child agent. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Optional callback the adapter MUST invoke immediately after
   * spawning the child process, passing the OS pid. The wrapper uses
   * this to register the round in the running-invocations dir so
   * `handoff cancel <topic>` (from another terminal) can find and signal
   * the process. Adapters that don't spawn (mocks in tests) may
   * ignore.
   */
  onSpawn?: (pid: number) => void;
};

/**
 * Outputs from an agent invocation. `sessionId` carries three-state
 * intent that the registry's merge logic distinguishes:
 *   - `string`     — extracted a session id; set it.
 *   - `null`       — adapter knows the prior session is gone; clear it.
 *   - `undefined`  — couldn't determine; preserve the prior snapshot value.
 *
 * Adapters that cannot extract a fresh session id should return
 * `undefined`, not the request's incoming `sessionId` — the registry
 * already holds that under the topic snapshot and preserving it there
 * is the merge's job.
 */
export type AgentResponse = {
  /** Raw stdout text from the agent (or summarized result for non-text agents). */
  output: string;
  /** Session id intent — see type doc above. */
  sessionId: string | null | undefined;
  /** Categorical outcome derived from the agent's response. */
  verdict: Verdict;
  /** Wall-clock duration of the invocation in ms. */
  durationMs: number;
};

export interface AgentAdapter {
  readonly name: AgentName;
  /** True if the agent supports `--session-id`-style resume. */
  readonly supportsResume: boolean;
  /** Modes this adapter handles. Wrapper rejects unsupported mode/agent pairs. */
  readonly supportedModes: readonly Mode[];
  invoke(req: AgentRequest): Promise<AgentResponse>;
}

/**
 * Helper used by adapters to convert raw spawn results into `AgentResponse`.
 * Exit-zero defaults to `advisory` — matches SKILL.md's output contract:
 * a missing Verdict line shouldn't claim more confidence than the agent
 * actually expressed.
 */
export function defaultVerdictFromExitCode(code: number | null): Verdict {
  if (code === 0) return 'advisory';
  if (code === null) return 'error';
  return 'error';
}

/**
 * Empty / nearly-empty output from a zero-exit run is the silent-failure
 * shape we keep getting bitten by: e.g. claude hits a permission prompt
 * with no human at the TTY, sits, exits 0 with nothing written. Without
 * this guard the adapter defaults to `ok` and the caller never knows
 * the run was a no-op.
 *
 * Threshold: post-trim length below this counts as "no useful work".
 * Picked conservatively — even a one-line "no findings" review verdict
 * has more chars than this. Tune if false positives appear.
 */
const EMPTY_OUTPUT_MAX_CHARS = 16;

export function outputLooksEmpty(output: string): boolean {
  return output.trim().length < EMPTY_OUTPUT_MAX_CHARS;
}

/**
 * Resolve a verdict from raw stdout + exit code. Handles three cases
 * in order:
 *   1. `Verdict: <x>` line in the body → take it verbatim
 *   2. Empty/tiny stdout on zero exit → `error` (silent-failure guard)
 *   3. Otherwise → exit-code default
 *
 * Adapters can pre-extract the verdict-line match if they have a custom
 * pattern (e.g. codex's variant); the helper takes the result.
 */
export function resolveVerdict(
  stdout: string,
  exitCode: number | null,
  bodyVerdict: Verdict | null,
): Verdict {
  if (bodyVerdict) return bodyVerdict;
  if (exitCode === 0 && outputLooksEmpty(stdout)) return 'error';
  return defaultVerdictFromExitCode(exitCode);
}

/**
 * Default Verdict regex used by claude + cursor adapters. Codex carries
 * its own copy because it's load-bearing for that adapter's tests; left
 * here as the canonical pattern other adapters can import.
 */
export const VERDICT_LINE = /^[\s\-*]*Verdict[:\s]+\s*(ok|advisory|blocked|error)\b/im;

export function matchVerdictLine(stdout: string): Verdict | null {
  const m = VERDICT_LINE.exec(stdout);
  if (m && m[1]) return m[1].toLowerCase() as Verdict;
  return null;
}
