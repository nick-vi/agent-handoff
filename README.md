# agent-handoff

Hand work between CLI agents (cursor, codex, claude) with topic-pinned
session continuity. Bidirectional — any agent can use the skill to
reach any other.

## Requirements

- **[Bun](https://bun.sh) ≥ 1.0** (preferred, ~22ms cold start)
  **or Node.js ≥ 22** (fallback via prebuilt bundle, ~65ms). The
  launcher at `bin/agent-handoff` picks Bun when on `PATH`, otherwise execs
  `node runtime/cli.js`. Bun stays the source-of-truth runtime; the
  generated skill runtime is refreshed by `bun run build`.
- The agent CLIs you want to dispatch to: `claude`, `codex`,
  `cursor-agent` — each on `PATH`. Adapters error gracefully if a
  binary is missing.

## Install

Install from GitHub with the `skills` CLI:

```bash
npx skills add nick/agent-handoff -g
```

The skill is compatible with `skills.sh` / `npx skills add` because the
repo root contains `SKILL.md` and all install-time runtime assets are
committed: `bin/agent-handoff`, `runtime/cli.js`, and `runtime/ui/`.
The CLI command is `handoff`; if your installer only links the skill
directory into agent discovery paths, add the PATH symlink below.

Local install before publishing:

```bash
git clone <this repo> ~/.agents/skills/agent-handoff
cd ~/.agents/skills/agent-handoff
bun install
```

Symlinks into each agent's discovery dir make the SKILL.md visible to
that agent, but they do **not** put `handoff` on `$PATH`. Two install
patterns:

```bash
# 1. Skill discovery — each agent reads SKILL.md from its own dir
ln -s ~/.agents/skills/agent-handoff ~/.claude/skills/agent-handoff
ln -s ~/.agents/skills/agent-handoff ~/.codex/skills/agent-handoff
# cursor uses .cursor/rules — copy agent-handoff.md if needed

# 2. CLI on PATH — symlink the launcher (NOT agent-handoff.ts) into $PATH
ln -s ~/.agents/skills/agent-handoff/bin/agent-handoff ~/.local/bin/handoff
```

The launcher is a POSIX shell script that prefers `bun` and falls back
to `node runtime/cli.js`. Symlinking `bin/agent-handoff.ts` directly works only
if Bun is installed.

Without step 2, agents that read SKILL.md and then try to invoke
`handoff send ...` will fail with "command not found". The `skills`
CLI installs skill directories that contain `SKILL.md`; verify your
installer also links the command, or add the symlink above manually.

## Quick start

```bash
# from any project root
handoff status

handoff send \
  --agent codex --mode review \
  --topic openfigi-plan \
  --new-topic \
  --summary "OpenFIGI CUSIP→ticker reverse mapping" \
  --prompt-file plan.md

# optional human shortcut for later terminal use
handoff use openfigi-plan

# read actual handoff state in a local browser UI
handoff ui
handoff ui --all-workspaces
```

Every handoff should carry a self-contained brief: objective, scope,
constraints, validation, and non-goals. The receiving agent should end
with `Verdict: ok | advisory | blocked | error` so the registry can
categorize the round.

Useful daily commands:

- `handoff status` / `handoff list` — discover existing topics before
  creating a new one.
- `handoff send --topic <slug> --new-topic ...` — start a fresh topic
  when other active topics already exist.
- `handoff send --topic <slug> --resume ...` — confirm a stale topic
  resume, or force agent-side session resume for one-shot modes.
- `handoff reset-session <topic> --agent <name> --reason expired` —
  clear a dead agent session while preserving topic history.
- `handoff plan <topic> --set-file plan.md` — attach temporary
  execution scaffolding that is auto-injected into sends unless
  `--no-plan` is passed.
- `handoff result <topic> --latest --agent <name>` — retrieve the full
  stored output for a completed round when stdout only showed a preview.
- `handoff tail`, `handoff log`, `handoff watch`, `handoff history`,
  and `handoff cancel` — inspect or control live and historical rounds.

## Docs

- [SKILL.md](./SKILL.md) — full skill contract
- [references/methodology.md](./references/methodology.md) — when to handoff vs inline
- [references/sessions.md](./references/sessions.md) — registry schema, slug rules
- [references/modes.md](./references/modes.md) — mode → agent capability matrix
- [references/agents/](./references/agents/) — per-agent quirks

## State

Runtime state lives in `${XDG_DATA_HOME:-~/.local/share}/agent-handoff/`,
not in this repo. Override via `AGENT_HANDOFF_STATE_DIR=/some/path`.
Every completed handoff stores the exact prompt sent to the child agent
and the full output under
`<state>/sessions/<workspace>/traces/<topic>/<round>-<agent>.json`.
For large responses, stdout is a preview and prints a `handoff result`
command before the preview so another agent can fetch the complete body.

## UI

`handoff ui` starts a read-only local server for the current workspace.
It serves the inspector UI at `http://127.0.0.1:17345/` by default and
backs it with actual handoff state:

- topic snapshots and history JSONL
- running invocation files
- durable trace files with exact prompts and full outputs
- native transcript resolvers for claude, codex, and cursor

Use `handoff ui --port 0` to ask the OS for a free port, or
`handoff ui --workspace <path>` to inspect another workspace.
Use `handoff ui --all-workspaces` to aggregate every workspace bucket
under the handoff state dir. In that mode each topic carries its
workspace key so duplicate slugs in different projects stay distinct.
The UI refuses non-loopback hosts unless `--unsafe-host` is passed.
On unsafe hosts, native transcripts are disabled unless
`--include-transcripts` is explicit. Use `--no-transcripts` to keep the
UI on metadata-only mode even on localhost.

The UI is shipped as generated static assets under `runtime/ui/`, and the data API is
served by the running `handoff` binary. Version compatibility follows the
binary: the server reads state through the same schema migrators used
by the CLI and exposes the running package version plus schema version
in `/api/snapshot`.

The UI reloads data manually by default so reading a timeline does not
jump while new state arrives. The **Auto on** toggle polls every 15
seconds and preserves pane scroll positions plus expanded iteration
details.

## Security

Handoff is intentionally non-interactive: adapters pass the target
agent's unattended permission-bypass flag (`--full-auto`, `--yolo`,
or Claude's equivalent). Treat `handoff send` like asking that agent to
act in the selected workspace without another approval prompt.

By default child agents inherit the current environment. Pass
`--clean-env` on `handoff send` to restrict the child to PATH, HOME,
shell/user/temp/locale/XDG variables, and `AGENT_HANDOFF_*` context.
Runtime state is written outside the repo under
`${XDG_DATA_HOME:-~/.local/share}/agent-handoff/` with private file modes
for new files.

## Release

Before publishing, run:

```bash
bun run release:check
```

`bun run build` regenerates the install-time runtime bundle and copies
the static UI into `runtime/`, matching the packaging pattern used by
OpenCanon.

`bun run release:check` runs typecheck, Bun tests, Node fallback smoke
tests, and the runtime asset guard.

`bun run runtime:check` rebuilds the runtime and fails if `runtime/`
differs from the committed assets. The GitHub CI workflow runs the same
guard on push and pull request, so source changes that affect runtime
must include the regenerated bundle before release.

## License

(unset; private)
