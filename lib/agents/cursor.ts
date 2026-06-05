/**
 * Cursor agent adapter.
 *
 * Wraps `cursor-agent --print --output-format json --trust --yolo <prompt>`.
 * Cursor exposes resumable sessions via `--resume <chatId>` and emits a
 * `session_id` field in its JSON envelope; we capture it on first
 * invocation and pass it back on subsequent rounds for topics whose
 * mode auto-resumes (or when the caller passes `--resume`).
 *
 * `--yolo` is always passed because handoff invocations are
 * non-interactive by design. Mirrors codex's `--full-auto` and
 * claude's `--dangerously-skip-permissions`. Mode is the contract that
 * scopes what the agent should do (read-only modes shouldn't write
 * regardless of permission flag); the bypass just removes the human-
 * in-the-loop prompts that would otherwise hang an unattended run.
 *
 * Verdict: cursor's JSON output has a `summary` and a `result` field, but
 * a `Verdict:` line in the body still wins. Otherwise we use the shared
 * exit-code / empty-output fallback.
 */

import { spawn } from 'node:child_process';
import type { AgentAdapter, AgentRequest, AgentResponse } from './base.ts';
import type { AgentInvocationDefaults } from '../model-defaults.ts';
import type { Mode, Verdict } from '../schema/v1.ts';
import { matchVerdictLine, resolveVerdict } from './base.ts';
import { sanitizeSessionId } from '../session-id.ts';

const SUPPORTED_MODES: readonly Mode[] = [
  'execute',
  'audit',
  'consult',
  'review',
  'debug',
] as const;

export const CURSOR_BUILTIN_MODEL_DEFAULT = 'composer-2.5-fast';

export const cursor: AgentAdapter = {
  name: 'cursor',
  supportsResume: true,
  supportedModes: SUPPORTED_MODES,

  async invoke(req: AgentRequest): Promise<AgentResponse> {
    const args = buildArgs(req.mode, req.workspaceRoot, req.prompt, req.sessionId, req.defaults ?? {});
    const t0 = Date.now();
    const result = await spawnCursor(args, req.workspaceRoot, req.onSpawn, req.env);
    const durationMs = Date.now() - t0;
    const extracted = extractSessionId(result.stdout);
    return {
      output: result.stdout,
      sessionId: extracted ? sanitizeSessionId('cursor', extracted) : undefined,
      verdict: extractVerdict(result.stdout, result.code),
      durationMs,
    };
  },
};

/**
 * Exported for unit tests. Translates a handoff request shape into the
 * cursor-agent argv. Pure, no I/O.
 */
export function buildCursorArgs(
  mode: Mode,
  workspace: string,
  prompt: string,
  sessionId: string | null = null,
  defaults: AgentInvocationDefaults = {},
): string[] {
  return buildArgs(mode, workspace, prompt, sessionId, defaults);
}

function buildArgs(
  mode: Mode,
  workspace: string,
  prompt: string,
  sessionId: string | null,
  defaults: AgentInvocationDefaults,
): string[] {
  // Mode scopes the prompt contract; cursor-agent's argv is currently
  // otherwise mode-independent.
  void mode;
  // cursor-agent CLI changes (post-2026.04.17): no `agent` subcommand,
  // prompt is a positional argument, no `--prompt` flag. The `--resume`
  // flag now takes its chatId in `--resume <chatId>` form (still
  // present, still optional).
  const args = ['--print', '--output-format', 'json', '--trust', '--workspace', workspace];
  args.push('--model', defaults.model ?? CURSOR_BUILTIN_MODEL_DEFAULT);
  args.push('--yolo');
  if (sessionId) args.push('--resume', sessionId);
  // Prompt must be the LAST argument (positional).
  args.push(prompt);
  return args;
}

type SpawnResult = { stdout: string; stderr: string; code: number | null };

function spawnCursor(
  args: string[],
  cwd: string,
  onSpawn?: (pid: number) => void,
  env: NodeJS.ProcessEnv = process.env
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('cursor-agent', args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (onSpawn && typeof child.pid === 'number') onSpawn(child.pid);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => {
      stdout += String(c);
    });
    child.stderr?.on('data', (c) => {
      stderr += String(c);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

/**
 * Pull `session_id` from cursor's JSON envelope. Stream-json emits one
 * JSON object per line; the final `result` line holds the canonical
 * session id. Walk lines from the end to find the first parseable
 * envelope with a `session_id`. If cursor stops emitting that field,
 * return undefined through the adapter response and let the registry
 * preserve the existing pointer.
 */
function extractSessionId(stdout: string): string | null {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || !line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as { session_id?: unknown };
      if (typeof parsed.session_id === 'string' && parsed.session_id) {
        return parsed.session_id;
      }
    } catch {
      // not JSON; keep scanning
    }
  }
  return null;
}

function extractVerdict(stdout: string, exitCode: number | null): Verdict {
  return resolveVerdict(stdout, exitCode, matchVerdictLine(stdout));
}
