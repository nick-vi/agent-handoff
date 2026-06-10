/**
 * Claude Code adapter.
 *
 * Claude Code supports session resume via `claude --resume <session-id>`
 * and `--continue`. For non-interactive handoff we use `claude --print
 * --output-format json` to get a structured envelope: the `session_id`,
 * the model's `result` text, and error/permission signals all surface
 * in the same JSON object instead of having to be regex'd out of a
 * banner. Reference: https://code.claude.com/docs/en/headless
 *
 */

import { spawn } from 'node:child_process';
import type { AgentAdapter, AgentRequest, AgentResponse } from './base.ts';
import type { AgentInvocationDefaults } from '../model-defaults.ts';
import type { Mode, Verdict } from '../schema/v1.ts';
import { matchVerdictLine, resolveVerdict } from './base.ts';
import { sanitizeSessionId } from '../session-id.ts';

const SUPPORTED_MODES: readonly Mode[] = [
  'consult',
  'audit',
  'review',
  'debug',
  'execute',
] as const;

type ClaudeJsonResult = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  api_error_status?: string | null;
  result?: string;
  session_id?: string;
  permission_denials?: unknown[];
};

export const claude: AgentAdapter = {
  name: 'claude',
  supportsResume: true,
  supportedModes: SUPPORTED_MODES,

  async invoke(req: AgentRequest): Promise<AgentResponse> {
    const args = buildClaudeArgs(req.sessionId, req.prompt, req.defaults);
    const t0 = Date.now();
    const result = await spawnClaude(args, req.workspaceRoot, req.onSpawn, req.env);
    const durationMs = Date.now() - t0;

    const parsed = tryParseJsonResult(result.stdout);

    if (parsed) {
      const denialCount = Array.isArray(parsed.permission_denials)
        ? parsed.permission_denials.length
        : 0;
      const body = parsed.result ?? '';
      const output = denialCount > 0
        ? `[handoff] claude reported ${denialCount} permission denial${denialCount === 1 ? '' : 's'}\n\n${body}`
        : body;
      // is_error + non-zero exit + permission denials all force `error`,
      // otherwise fall through to the shared verdict resolver so a
      // Verdict line in the result body still wins.
      const verdict: Verdict =
        parsed.is_error === true || denialCount > 0
          ? 'error'
          : resolveVerdict(body, result.code, matchVerdictLine(body));
      return {
        output,
        sessionId: typeof parsed.session_id === 'string'
          ? sanitizeSessionId('claude', parsed.session_id)
          : undefined,
        verdict,
        durationMs,
      };
    }

    const output = result.stdout.trim()
      ? result.stdout
      : result.stderr.trim()
        ? result.stderr
        : 'Claude did not return a JSON result envelope.';
    return {
      output,
      sessionId: undefined,
      verdict: 'error',
      durationMs,
    };
  },
};

/**
 * Exported for unit tests. Translates handoff request shape into the
 * `claude --print --dangerously-skip-permissions --output-format json
 * [--model <model>] [--fallback-model <models>] [--effort <level>]
 * [--settings <json>] [--resume <id>]` argv.
 * Pure, no I/O.
 *
 * `--dangerously-skip-permissions` is always passed because handoff
 * invocations are non-interactive by design — there's no human at the
 * TTY to approve write/shell prompts, and a sitting-and-waiting claude
 * looks indistinguishable from a slow run. Mirrors codex's `--full-auto`
 * and cursor's `--yolo`.
 *
 * `--output-format json` is always passed so we get a structured
 * `session_id` instead of regex-scraping a banner. Without this flag
 * claude has no obligation to emit the session id at all.
 */
export function buildClaudeArgs(
  sessionId: string | null,
  prompt: string,
  defaults: AgentInvocationDefaults = {},
): string[] {
  const args: string[] = ['--print', '--dangerously-skip-permissions', '--output-format', 'json'];
  if (defaults.model) {
    args.push('--model', defaults.model);
  }
  if (defaults.fallbackModel) {
    args.push('--fallback-model', defaults.fallbackModel);
  }
  if (defaults.effort) {
    args.push('--effort', defaults.effort);
  }
  if (defaults.speed === 'fast') {
    args.push('--settings', JSON.stringify({ fastMode: true }));
  } else if (defaults.speed === 'default') {
    args.push('--settings', JSON.stringify({ fastMode: false }));
  }
  if (sessionId) {
    args.push('--resume', sessionId);
  }
  args.push(prompt);
  return args;
}

/**
 * Exported for unit tests. Parses claude's `--output-format json`
 * envelope. Returns null if stdout isn't a single JSON object — caller
 * treats that as an adapter error.
 */
export function tryParseJsonResult(stdout: string): ClaudeJsonResult | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as ClaudeJsonResult;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

type SpawnResult = { stdout: string; stderr: string; code: number | null };

function spawnClaude(
  args: string[],
  cwd: string,
  onSpawn?: (pid: number) => void,
  env: NodeJS.ProcessEnv = process.env
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
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
