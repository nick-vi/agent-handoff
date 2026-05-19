/**
 * Codex CLI adapter.
 *
 * Codex exposes durable sessions via `codex exec resume <uuid> [PROMPT]`.
 * New sessions use `codex exec [PROMPT]`. Both accept `--full-auto` to
 * bypass interactive approval prompts; we always pass it because handoff
 * invocations are non-interactive by design.
 *
 * Session ID is parsed back from stdout. Codex emits a banner line near
 * the end of the run that includes the thread UUID; the regex below
 * captures it. If extraction misses, the adapter returns `undefined`
 * and the registry preserves the existing topic session pointer.
 *
 * Verdict is parsed from the wrapper's expected output contract:
 *   `Verdict: ok | advisory | blocked | error`
 * If the body doesn't include a Verdict line, we default to `advisory`.
 */

import { spawn } from 'node:child_process';
import type { AgentAdapter, AgentRequest, AgentResponse } from './base.ts';
import type { Mode } from '../schema/v1.ts';
import { matchVerdictLine, resolveVerdict } from './base.ts';
import { sanitizeSessionId } from '../session-id.ts';

const SUPPORTED_MODES: readonly Mode[] = ['review', 'audit', 'debug', 'consult', 'execute'] as const;

// Codex thread IDs are uuidv7: 8-4-4-4-12 hex.
const SESSION_ID_PATTERN = /\b([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

export const codex: AgentAdapter = {
  name: 'codex',
  supportsResume: true,
  supportedModes: SUPPORTED_MODES,

  async invoke(req: AgentRequest): Promise<AgentResponse> {
    const args = buildCodexArgs(req.sessionId, req.prompt);

    const t0 = Date.now();
    const result = await spawnCodex(args, req.workspaceRoot, req.onSpawn, req.env);
    const durationMs = Date.now() - t0;

    const extracted = extractSessionId(`${result.stdout}\n${result.stderr}`);
    return {
      output: result.stdout,
      sessionId: extracted ? sanitizeSessionId('codex', extracted) : undefined,
      verdict: resolveVerdict(result.stdout, result.code, matchVerdictLine(result.stdout)),
      durationMs,
    };
  },
};

/**
 * Exported for unit tests. `codex exec [resume <id>] --full-auto <prompt>`.
 * Pure; no I/O.
 */
export function buildCodexArgs(sessionId: string | null, prompt: string): string[] {
  const args: string[] = ['exec'];
  if (sessionId) {
    args.push('resume', sessionId);
  }
  args.push('--full-auto');
  args.push(prompt);
  return args;
}

type SpawnResult = { stdout: string; stderr: string; code: number | null };

function spawnCodex(
  args: string[],
  cwd: string,
  onSpawn?: (pid: number) => void,
  env: NodeJS.ProcessEnv = process.env
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (onSpawn && typeof child.pid === 'number') onSpawn(child.pid);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

function extractSessionId(stdout: string): string | null {
  // Codex prints the thread UUID multiple times. Take the last occurrence
  // because it reflects the final session state — earlier matches may
  // refer to the prior session being resumed before any continuation
  // mutations.
  let last: string | null = null;
  let match: RegExpExecArray | null;
  const re = new RegExp(SESSION_ID_PATTERN, 'gi');
  while ((match = re.exec(stdout)) !== null) {
    last = match[1] ?? null;
  }
  return last;
}
