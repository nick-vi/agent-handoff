---
name: agent-handoff
description: Hand work between CLI agents (cursor, codex, claude) with topic-pinned session continuity. Bidirectional — any agent can use this skill to reach any other. Use when an independent agent should produce an artifact (review, audit, debug diagnosis, executed diff) and the work spans multiple rounds. Topic identifies the conceptual thread; the registry tracks which agent owns which session per topic.
---

# Agent Handoff

## When to use, when not to

Hand off when you want an **independent artifact** from a different agent —
an external reviewer's findings, an executor's diff, a debugger's diagnosis.

Stay inline when the work is **collaborative** — iterating on a plan,
narrowing a question, refining wording.

Rule: **handoff for independent artifact, inline for collaboration.**

See `references/methodology.md` for worked examples.

## Glossary

- **Topic**: machine slug threading continuity across rounds and across agents.
- **Round**: one invocation against a topic. Round count increments on every send.
- **Session**: an agent's resumable thread. Tracked per (topic, agent).
- **Registry**: persistent state at `${XDG_DATA_HOME:-~/.local/share}/agent-handoff/`.
- **Snapshot**: current state for a topic (`<topic>.json`).
- **History**: append-only event log (`<topic>.history.jsonl`).

## Quick start

```bash
# Discover prior state in this workspace BEFORE starting fresh.
handoff status

# First round — codex review of a plan in the current repo
handoff send --agent codex --mode review \
  --topic openfigi-plan \
  --summary "OpenFIGI CUSIP→ticker reverse mapping plan" \
  --prompt-file plan.md

# Optional human shortcut: pin this topic as the cwd default for --current
handoff use openfigi-plan

# Resume same topic for a follow-up round (agents should still pass --topic)
handoff send --agent codex --mode consult \
  --topic openfigi-plan \
  --prompt "Pushback on schema choice — see commit abc123"

# Hand work to cursor for execution
handoff send --agent cursor --mode execute \
  --topic openfigi-plan \
  --prompt-file brief.md

# Inspect
handoff status              # current pointer + active + stale
handoff list                # active topics only
handoff list --all          # include stale
handoff show <topic>        # snapshot + full history
handoff doctor              # resolution diagnostic
handoff result <topic> --latest --agent codex     # full stored output

# Live monitoring
handoff tail <topic>        # stream new history events as they're written
handoff log --since 24h     # time-ordered events across topics in this workspace
handoff log --since 7d --all-workspaces   # merge across every project

# Inspect / cancel a live agent round
handoff watch <topic>                              # tail each agent's local conversation file
handoff watch <topic> --agent codex                # tail just one
handoff history <topic> --last 20                  # compact view of recent turns
handoff history <topic> --no-tools                 # drop tool_call rows
handoff history <topic> --skip-system              # drop system + <user_info>/<environment_context>
handoff history <topic> --stats                    # role counts + tool-name breakdown only
handoff history <topic> --format json              # one envelope per line
handoff history <topic> --format raw               # source file unmodified
handoff cancel <topic>                             # SIGINT the live child for the topic
handoff cancel <topic> --signal SIGTERM --agent codex
handoff cancel <topic> --run-id <id>               # disambiguate parallel runs
handoff ui                                         # local read-only browser UI
handoff ui --all-workspaces                        # aggregate every workspace bucket
handoff ui --port 0                                # pick a free port
handoff ui --no-transcripts                        # metadata-only local UI

# Durable output capture (automatic)
handoff send --agent codex --mode review --topic foo \
  --prompt-file plan.md
# Persists exact prompt + full output as
#   <state-dir>/sessions/<workspace>/traces/<topic>/000001-codex.json
# Retrieve it with:
handoff result foo --round 1 --agent codex --part output
# History.jsonl stays slim (categorical metadata only). Very large stdout
# is previewed, with the retrieval command printed before the preview.

# Harden child environment when desired
handoff send --agent codex --mode review --topic foo \
  --prompt-file plan.md --clean-env
# Child receives PATH/HOME/shell/user/temp/locale/XDG + AGENT_HANDOFF_* only.

# Skill-owned model defaults (stored under the handoff state dir)
handoff model                                      # list effective defaults
# Example pins; update as provider model names change.
handoff model set codex gpt-5.5 --effort xhigh --speed fast
handoff model set claude opus --effort max --speed fast
handoff model set cursor composer-2.5-fast         # Cursor model
handoff model unset codex --speed-only             # remove one setting

# Plan artifacts (per-topic execution scaffolding)
handoff plan auth-redesign --set-file design.md   # seed the plan
handoff plan auth-redesign --edit                 # open in $EDITOR
handoff plan auth-redesign                         # cat current
handoff plan auth-redesign --inspect               # show what gets injected
handoff send --agent codex --mode consult --topic auth-redesign \
  --prompt "round 4: address SSO gap"
# → handoff auto-prepends `## handoff plan: auth-redesign (last edited 2h ago)`
#   header + plan body + footer to the prompt. `--no-plan` to skip.
```

## Plans are execution scaffolding, NOT project memory

Plans live in shared state because their lifecycle matches the
topic's: while work is in flight, the plan is the canonical "what
we're doing"; once execution lands, the git diff is the artifact and
the plan is throwaway. They are **not** specs, ADRs, or
documentation. If a plan becomes worth preserving, promote it
deliberately: `handoff plan <topic> --export apps/foo/docs/plan.md`,
then `git add` the result.

This is the conceptual rule that justifies the lifecycle alignment
(plans archive with topics, prune with archives). Drift on this rule
and shared-state-by-default starts to hurt — durable artifacts don't
belong in `~/.local/share/`.

## Discovery — start every workspace session here

When you (a calling agent) enter a workspace where handoff state may
already exist, **run `handoff status` or `handoff list` first.** Active
topics surface with summaries; resume the right one by slug.

Topic routing order for `handoff send`:

1. `--topic <slug>` wins and is preferred for agent workflows.
2. `--current` explicitly reads `.handoff/current.json`.
3. If neither is present, an inherited `AGENT_HANDOFF_TOPIC` from a
   parent handoff invocation is used.
4. Otherwise the command fails with active-topic guidance.

The CLI also guards new slugs: `handoff send` with a `--topic` slug that
doesn't match any existing topic AND active topics exist requires
`--new-topic` to confirm. This prevents accidental registry
fragmentation.

`handoff use <topic>` sets the per-cwd default used only by `--current`.
`.handoff/current.json` is the pointer file (auto-injected into
`.git/info/exclude`; never committed). Treat it as a human terminal
shortcut, not agent-safe routing state.

When handoff invokes a child agent, it automatically propagates
`AGENT_HANDOFF_TOPIC`, `AGENT_HANDOFF_WORKSPACE_ROOT`,
`AGENT_HANDOFF_WORKSPACE_DIR`, `AGENT_HANDOFF_RUN_ID`, and
`AGENT_HANDOFF_PARENT_RUN_ID` (when nested). Intentional nested handoff
calls are still subject to the anti-recursion guard below and must pass
`--allow-nested`.

## Brief contract (universal)

Every send carries a brief with these fields, regardless of agent:

- **Objective** — what success looks like
- **Scope** — files, branch, diff, or specific question
- **Constraints** — must-honor rules
- **Validation** — how the calling agent decides the result is acceptable
- **Non-goals** — explicitly out of scope

The brief shape is enforced by convention (caller composes the prompt);
the handoff does not parse or rewrite it. See `references/methodology.md`.

## Output contract (universal)

Receiving agent's response must include:

- Body (mode-specific shape)
- `Verdict: ok | advisory | blocked | error` line
- Open questions

The handoff parses the Verdict line to set the categorical outcome in the
registry. If absent, defaults to `advisory` on exit zero, `error`
otherwise.

Exit codes: `ok`/`advisory` → 0; `blocked`/`error` → 1.

## Modes

All five modes work with all three agents. The labels below mark the
default/primary recommendation; the others are viable with the
trade-offs noted in `references/modes.md`.

- `execute` — write code (cursor primary; claude for multi-file
  reasoning; codex fallback)
- `review` — find problems in a diff or proposal (codex primary;
  claude for prose-heavy review)
- `audit` — assess a path or module without changes (codex primary;
  claude or cursor viable)
- `debug` — diagnose a failure (codex or claude primary)
- `consult` — multi-round design review (codex or claude primary)

See `references/modes.md` for which agents support which modes and how.

### Resume policy per mode

| Mode | Default session behavior | Reason |
|---|---|---|
| `consult` | auto-resume prior agent session | multi-round design carries server-side context |
| `debug` | auto-resume prior agent session | follow-on diagnoses ride on prior root-cause work |
| `review` | new session unless `--resume` | one-shot artifact; shouldn't inherit unrelated context |
| `audit` | new session unless `--resume` | same — read-only assessment of fresh scope |
| `execute` | new session unless `--resume` | bounded execution; brief carries everything needed |

The topic itself threads continuity (round numbers, history) regardless
of whether the agent-side session is resumed. Only the per-(topic, agent)
session ID pointer is gated.

## Agents

- `claude` — Claude Code CLI; `--print --resume <id>` for non-interactive resume
- `codex` — Codex CLI; `codex exec resume <uuid>` for durable threads
- `cursor` — `cursor-agent --print --output-format json --trust --yolo [--resume <chatId>] <prompt>`

See `references/agents/<name>.md` for per-agent quirks and output parsing
notes.

## Sessions

Topics are keyed by `<workspace>:<slug>`. Workspace is the resolved
git repo root (derived from `--git-common-dir` so all linked worktrees
of the same repo share state), or realpath cwd outside a repo. Slug
is `[a-z0-9-]{8,64}`, strict; see `references/sessions.md` for full
rules and collision behavior.

Per-agent session IDs persist in the snapshot. Whether the handoff
passes the prior session ID to the agent depends on the **mode**:
`consult`/`debug` auto-resume; `review`/`audit`/`execute` start fresh
unless `--resume` is explicit. Topic-level continuity (round numbers,
history) is independent — every send increments the topic's round
count regardless of agent-side session policy.

`handoff archive <topic>` moves snapshot + history to `archive/`.
`handoff prune` enforces retention (default: keep 20 archives or 90 days).
Pass `handoff prune --history-keep <N>` to also trim each active topic's
`<topic>.history.jsonl` to the last N events. Opt-in: long-lived
consult topics with thousands of rounds bound their disk + `handoff log`
parse cost; everyone else can ignore it.

### Two staleness thresholds

`STALE_DAYS` (30) and `RESUME_CONFIRM_DAYS` (7) live in
`lib/lifecycle.ts` and are deliberately separate:

- **30d (lifecycle)** — topics untouched this long are hidden from
  default `handoff list` output. Resume still works without ceremony.
- **7d (resume confirm)** — `handoff send` against a topic untouched
  this long requires explicit `--resume`. Tighter than the lifecycle
  threshold because the cost of accidentally resuming a stale thread
  (poisoned context) is higher than the cost of one extra keystroke.

## Anti-recursion

The handoff sets `AGENT_HANDOFF_DEPTH=1` and `AGENT_HANDOFF_TOKEN=<random>`
on every invocation, then restores both after the agent returns. A
nested call with **both** vars set refuses unless `--allow-nested` is
explicit. The token guards against false-positive blocks: a stale
`AGENT_HANDOFF_DEPTH=1` exported by some unrelated parent shell won't
wedge direct user invocations because the token won't match.

### Intentional bidirectional chains

Handoff flows that *want* to chain — codex hands work to cursor for
execution, cursor hands a debug back to codex — pass `--allow-nested`
on the inner call. If the nested leg is an independent artifact or
calls the same agent again, give it a different `--topic`; otherwise
omitting `--topic` inherits `AGENT_HANDOFF_TOPIC` from the parent handoff
process. Example brief the calling agent might produce:

```bash
# Outer: claude asks codex to design
handoff send --agent codex --mode consult \
  --topic auth-redesign \
  --prompt "Design X. If you need cursor to verify the API shape, run:
handoff send --agent cursor --mode execute \
  --topic auth-redesign-spike \
  --allow-nested \
  --prompt-file /tmp/spike-brief.md"
```

Why a different topic can matter: each topic has its own
session-id-per-agent slot. If an inner call uses the same topic and the
same agent as the outer call, its session ID can clobber the outer's
mid-flight, breaking resume on the next round. Different-agent handoffs
can share the parent topic when that is the intended conceptual thread.


## Acceptance

Treat handoff output as advisory until accepted by the calling workflow.
Always:

- read the body
- inspect referenced files directly
- run targeted validation outside the handoff
- check that the brief's constraints and non-goals were honored

The Verdict line is a hint, not a verdict.

## Failure handling

- Output malformed → tighten brief, rerun
- Task too broad → split into smaller handoffs with narrower briefs
- Validation fails → narrower follow-up handoff, not "fix everything"
- Agent-side session expired (codex thread expired server-side, claude
  transcript deleted, etc) → the handoff records the agent's error and
  keeps the prior session ID in the snapshot; next round will pass the
  same (now-dead) ID and the agent will likely error again. Workaround:
  `handoff archive <topic>` then send fresh with `--topic <topic>`, or
  pass `--archive-and-new` on the next send. Auto-fallback is **not**
  implemented; documented to manage expectations.

## Files

```
SKILL.md                          this file
bin/agent-handoff.ts                      CLI entry
lib/                              storage + agent adapters
references/
  methodology.md                  when to handoff vs inline
  modes.md                        mode → agent capability matrix
  sessions.md                     registry schema, slug rules, TTLs
  model-defaults.md               skill-owned per-agent model defaults
  glossary.md                     terms used across docs
  troubleshooting.md              common failure modes
  agents/
    claude.md
    codex.md
    cursor.md
```

## Discoverability

Agents discover this skill via the `description:` frontmatter at the
top of this file when the skill is registered (symlinked into
`~/.claude/skills/agent-handoff/`, `~/.codex/skills/agent-handoff/`, or
the cursor equivalent). When a task matches the description — "hand
work between CLI agents... independent artifact (review, audit, debug
diagnosis, executed diff)..." — the agent loads the SKILL.md and
follows the contract here.

No additional onboarding snippet is needed. If you find your agent
*not* reaching for handoff when it should, the fix is usually to
sharpen this file's `description:` line, not to bolt extra prompts
onto user memory.

## Live introspection — watch, history, cancel

While an agent round runs, the handoff records the spawned child's pid
under `<state>/running/<workspace>/<topic>--<agent>--<run_id>.json`
(cleared on exit). Cross-process commands use this file:

- `handoff cancel <topic>` — sends SIGINT (default; configurable via
  `--signal`) to the live child. If multiple live runs match, add
  `--agent` and/or `--run-id`. The handoff process holding the lock sees
  the child close and runs its `finally`. Use `handoff status` to see
  live rounds and run ids.
- `handoff watch <topic>` — tails each agent's local conversation file
  (claude `~/.claude/projects/...`, codex `~/.codex/sessions/...`).
  Cursor uses SQLite (`~/.cursor/chats/.../store.db`) and is not
  tailable — the watcher prints a one-line note and skips it.
- `handoff history <topic> --last N` — compact-format dump of the same
  files, parsed into role/text turns to keep token cost low. Default
  20 turns, `--full` for full message bodies, `--format raw` for
  pass-through, `--agent <name>` to scope to one agent.
- `handoff result <topic> --latest --agent <name>` — print the durable
  full output captured for a completed round. Use `--part prompt` to
  inspect the exact prompt sent to the child agent, `--path` to print
  the JSON trace path, or `--json` for the whole trace envelope.

Hitting Ctrl-C in the handoff process that spawned the child also
forwards SIGINT — the live-PID handler is registered for the
duration of the invoke and removed in `finally`. Cross-process cancel
from a different terminal uses the running file.

## Security model

Handoff is for unattended handoff. Adapters intentionally pass each
agent's non-interactive permission-bypass flag so child agents do not
hang waiting for approval. Use mode labels and the brief's scope/
constraints to communicate expected behavior; the handoff does not
sandbox the agent.

By default, child agents inherit the caller's environment. Pass
`--clean-env` to keep only PATH, HOME, shell/user/temp/locale/XDG
variables, and `AGENT_HANDOFF_*` context. The local UI binds to
`127.0.0.1` by default; non-loopback hosts require `--unsafe-host`, and
native transcript exposure on unsafe hosts requires
`--include-transcripts`.

## Runtime

Bun is the canonical source runtime — `bin/agent-handoff.ts` runs directly via
the `#!/usr/bin/env bun` shebang (~22ms cold start). For environments
without Bun, the `bin/agent-handoff` POSIX shim falls back to `node
runtime/cli.js` (~65ms). The generated `runtime/` directory is committed
because skill-install symlink flows do not run build steps. Source-level
changes require Bun; regenerate `runtime/` with `bun run build` before
publishing. `bun run runtime:check` rebuilds and fails if committed
runtime assets are stale; CI runs this guard on push and pull request.
Node ≥22 required for the fallback bundle.
