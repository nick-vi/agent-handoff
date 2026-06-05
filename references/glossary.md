# Glossary

Stable definitions for terms used across SKILL.md, references, and code
comments. If you find one of these used loosely, fix the prose, not the
glossary.

## topic

Free-form lowercase ASCII slug threading conversational continuity.
Format: `[a-z0-9-]{8,64}`, no leading or trailing dash, no consecutive
dashes. Slugs are user-supplied and validated strict; the skill does not
auto-normalize spaces or case. Reserved blocklist: `wip`, `tmp`, `test`,
`misc`, plus Windows device names.

A topic spans one conceptual unit of work that may be carried across
rounds and across agents. Examples: `openfigi-plan`, `auth-refactor`,
`pricing-bug-2026-04-30`.

## round

One handoff invocation against a topic. The first send creates the topic
with `round=1`. Each subsequent send increments. Round numbers are
allocated under the topic's lock, so concurrent sends never collide.

## session

An agent-side resumable thread. Codex stores threads server-side keyed
by UUID; Claude stores sessions in local transcripts; Cursor exposes
resumable chats keyed by `session_id`.

The handoff tracks per-(topic, agent) session IDs in the snapshot. When
you send to an existing topic with a supporting agent, the handoff passes
the prior session ID and the agent picks up its server- or local-side
state. When the agent doesn't support resume, the field is null.

## agent

A CLI tool the handoff can invoke. Currently: `claude`, `codex`, `cursor`.
Each has an adapter in `lib/agents/<name>.ts` describing CLI shape,
session resume support, and output parsing.

## registry

The on-disk state owned by the handoff. Lives at
`${XDG_DATA_HOME:-~/.local/share}/agent-handoff/sessions/<workspace>/`.

Per-topic files:
- `<topic>.json` — current snapshot (atomic-write)
- `<topic>.history.jsonl` — append-only event log

Lock dir during mutations:
- `<topic>.lock/` — mkdir-atomic; `info.json` inside identifies holder

Archived topics:
- `archive/<topic>--<ISO8601>.json` and `.history.jsonl`

## workspace

A project root, used as the namespace for topics. Resolved as
`strip(/.git$, realpath(git rev-parse --git-common-dir))` if inside a
repo, else `realpath(cwd)`. Worktrees of the same repo share state
because `--git-common-dir` returns the main `.git` directory from
any linked worktree.

Workspace dir name: `<basename>-<12hex>` where `12hex` is the first 12
chars of `sha256(resolvedRoot)`. Basename for human inspection; hash
carries uniqueness across collision-prone basenames.

## verdict

Categorical outcome of a handoff round. One of `ok`, `advisory`, `blocked`,
`error`. Parsed from a `Verdict:` line in the agent's output, or
defaulted from exit code.

Exit code mapping: `ok`/`advisory` → 0; `blocked`/`error` → 1.

## snapshot

The current-state JSON file for a topic. One per topic. Replaced
atomically on every mutation. Contains: topic, summary, workspace info,
per-agent session IDs, round count, timestamps. Schema versioned via
`schema_version` field.

## history

The append-only JSONL event log for a topic. One line per event. Events:
`created`, `invocation`, `archived`. Each carries `schema_version`.
Trailing partial lines from torn writes are tolerated on read.
