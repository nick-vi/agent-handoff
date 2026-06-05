# Changelog

## Versioning

Semantic-ish: `MAJOR.MINOR.PATCH`.

- **MAJOR** — schema_version bump in `lib/schema/v1.ts` (breaking
  state-dir format), CLI flag/subcommand rename, or removal of a
  documented feature.
- **MINOR** — new subcommand, new flag, new agent adapter, additive
  schema field with default.
- **PATCH** — bug fix, doc change, internal refactor with no surface
  change.

## [Unreleased]

- Removed `references/global-nudge.md` and `references/project-snippet.md`.
  Skill discovery is description-driven via the `description:` frontmatter
  on SKILL.md; the snippets only biased toward proactive use, didn't
  add discovery. Less to install per machine.
- README + troubleshooting paths updated to canonical
  `~/.agents/skills/agent-handoff/` after install move.
- **Worktree fix** — workspace key now derived from
  `git rev-parse --git-common-dir` (was `--show-toplevel`). Linked
  worktrees of the same repo share registry state as the docs
  always claimed. Catches a codex-flagged bug. Regression test
  pins it.
- **Cursor adapter resume** — cursor IS resumable via
  `--resume <chatId>`; adapter now passes the flag and parses
  `session_id` from the JSON envelope. Was incorrectly marked
  `supportsResume: false`.
- **Universal permission bypass** — claude gains
  `--dangerously-skip-permissions` always; cursor passes `--yolo`
  on every mode (was only `execute`). Mirrors codex's `--full-auto`.
  Mode is the contract; the bypass flag just removes the human-in-
  the-loop prompt that would hang an unattended run.
- **All modes available to all agents** — adapters declare all 5
  modes. `references/modes.md` shifted from yes/— gates to
  primary/viable recommendations + per-agent strengths heuristic.
- **Durable result traces** — full prompt + output are now persisted
  automatically per round, written to
  `traces/<topic>/<round>-<agent>.json` (0600). History.jsonl
  stays slim (categorical metadata only); `handoff result` retrieves
  complete bodies when stdout is previewed/truncated. `--store-trace`
  remains accepted as a compatibility no-op.
- **`handoff tail <topic>`** — stream new history events as they're
  appended. Polling-based (500ms), portable. `--from-start` to
  print existing events too.
- **`handoff log --since <duration>`** — time-ordered events across
  topics. `--all-workspaces` merges across every project's state.
  Duration grammar `<N>{m,h,d}`.
- **Silent-failure verdict guard** — zero-exit + empty stdout no
  longer reads as `ok`. Bug we hit live: claude under
  `--dangerously-skip-permissions` regression hit a permission
  prompt, sat for 127s, exited 0 with empty body, handoff logged
  `verdict=ok`. New `outputLooksEmpty` (16-char trim threshold) +
  `resolveVerdict` helper in `lib/agents/base.ts` flip that case
  to `error`. All three adapters route through the helper.
- **Plan artifacts** (`handoff plan <topic>`). Per-topic markdown plan
  stored in shared state at `<state-dir>/sessions/<workspace>/plans/
  <topic>.md`. Auto-injected into `handoff send` prompts with
  provenance header (`## handoff plan: <topic> (last edited <ago>)`)
  unless `--no-plan`. Subactions: `--edit`, `--path`, `--inspect`,
  `--history`, `--diff R1..R2`, `--export <path>`, `--set-file
  <path>`, `--set <text>`, `--delete`. Conceptual rule: plans are
  **execution scaffolding**, not project memory. Once execution
  lands, the git diff is the artifact; promote to repo via
  `--export` only when worth preserving. Round-stamped history
  snapshots opt-in via `--snapshot-plan-on-edit` (default off).
  Archive flow moves plan + history with the topic.
- **Argv-safety regression pin**: plan-injection header uses `##`
  not `---`. Codex's argv parser treats positional args starting
  with `--` as flag attempts and exits in ~10ms with the agent
  never running. Caught live, pinned in tests.

## [0.1.0] — Initial

First sealed-off design pass. Five rounds of codex review before
sign-off.

Surface:

- Subcommands: `send`, `list` (alias `ls`), `show`, `status`, `use`,
  `clear`, `archive`, `prune`, `doctor`, `alias`, `reset-session`
- Agents: `claude`, `codex`, `cursor`
- Modes: `execute`, `review`, `audit`, `debug`, `consult`
- Resume policy: `consult`/`debug` auto-resume; `review`/`audit`/
  `execute` start fresh unless `--resume`
- State at `${XDG_DATA_HOME:-~/.local/share}/agent-handoff/` with
  per-workspace dirs keyed by sha256-12 of `realpath(git toplevel ||
  cwd)`
- Project-local pointer at `<workspace>/.handoff/current.json`
  (auto-injected into `.git/info/exclude`)
- Lifecycle: active | stale (computed >30d) | archived
- Anti-recursion guard via `AGENT_HANDOFF_DEPTH` env
- Strict slug validation `^[a-z0-9](?:[a-z0-9-]{6,62}[a-z0-9])$` with
  blocklist
- 0600 file permissions on snapshot + history
- Schema versioning via `schema_version` field on every record

Tests: 32 cases across 9 files.

Known gaps at the 0.1.0 release:

- Auto-fallback on agent-side session expiry not implemented; manual
  workaround via `handoff reset-session`
- Cursor `--resume` not implemented; adapter is deliberately stateless
- `--store-trace` for forensic prompt/response persistence not
  implemented; privacy default is summaries + verdicts only

Some of these have since been addressed in `[Unreleased]`; this section
describes the original 0.1.0 surface only.
