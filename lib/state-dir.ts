/**
 * Resolve the on-disk root for runtime state.
 *
 * Precedence:
 *   1. `AGENT_HANDOFF_STATE_DIR` env (explicit override; absolute path expected)
 *   2. `${XDG_DATA_HOME}/agent-handoff`
 *   3. `~/.local/share/agent-handoff`
 *
 * State always lives outside the skill's installed location: the skill is
 * symlinked into each agent's discovery dir by `npx skills add`, and any
 * update can wipe or replace that target. Personal session bookkeeping
 * cannot live there.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_NAME = 'agent-handoff';

export function resolveStateDir(): string {
  const override = process.env.AGENT_HANDOFF_STATE_DIR;
  if (override && override.length > 0) return override;

  const xdgDataHome = process.env.XDG_DATA_HOME;
  if (xdgDataHome && xdgDataHome.length > 0) {
    return join(xdgDataHome, APP_NAME);
  }

  return join(homedir(), '.local', 'share', APP_NAME);
}

/** Ensure the state dir exists with mode 0700. Idempotent. */
export function ensureStateDir(): string {
  const dir = resolveStateDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}
