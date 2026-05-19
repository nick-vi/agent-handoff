# Sessions, Slugs, Storage

How the registry persists state, why it's shaped that way, and the
operational invariants you can rely on.

## Layout

```
${XDG_DATA_HOME:-~/.local/share}/agent-handoff/
  sessions/
    <basename>-<12hex>/                      ← per-workspace dir
      <topic>.json                            ← snapshot (atomic-write)
      <topic>.history.jsonl                   ← append-only events
      <topic>.lock/                           ← mkdir-atomic, transient
        info.json                             ← lock holder metadata
      archive/
        <topic>--<ISO8601>.json
        <topic>--<ISO8601>.history.jsonl
  running/
    <basename>-<12hex>/
      <topic>--<agent>--<run_id>.json          ← live child pid, transient
```

Override the root with `AGENT_HANDOFF_STATE_DIR=/some/path` env var.

## Workspace key

```
repo  = strip_trailing_dot_git(realpath(git rev-parse --git-common-dir)) || realpath(cwd)
hash  = sha256(repo).slice(0, 12)
dir   = "<basename>-<hash>"
```

Worktrees of the same repo share state because `--git-common-dir`
points at the main `.git` directory regardless of which linked worktree
we run from. (`--show-toplevel` would diverge per worktree and
fragment the registry — that's why we don't use it.)

Different repos with the same basename (`acme/api` vs `widgets/api`)
get different dirs because the hash is over the full resolved repo
path.

## Slug rules

```
^[a-z0-9](?:[a-z0-9-]{6,62}[a-z0-9])$
```

- 8 ≤ length ≤ 64
- lowercase ASCII letters, digits, dashes
- no leading or trailing dash
- no consecutive dashes (`--` reserved as collision-suffix delimiter)
- not in blocklist: `wip`, `tmp`, `test`, `misc`, `todo`, `foo`, `bar`,
  `baz`, `con`, `prn`, `aux`, `nul`, `conin`, `conout`, `clock`,
  `archive`, `history`, `lock`, `sessions`, `state`, `com[1-9]`, `lpt[1-9]`

The skill rejects ambiguous input rather than auto-normalizing. If
your conceptual topic name violates rules, pick a different slug — the
human-readable summary lives in the snapshot's `summary` field, not the
slug.

## Slug collisions

Two distinct concepts assigned the same slug is a user error, not a
filesystem hazard. The skill surfaces it explicitly:

- Send to existing active topic → topic round count + history continue.
  Whether the agent-side session resumes depends on the mode:
  `consult`/`debug` auto-resume the prior session ID; `review`/`audit`/
  `execute` start a fresh agent session unless `--resume` is passed.
- Send to stale topic (>7 days inactive) without flag → hard error;
  pass `--resume` to confirm or `--archive-and-new` to start fresh
  under the same slug.
- New slug while other topics are active → hard error unless
  `--new-topic` is passed.
- `--archive-and-new` on existing topic → archive snapshot+history,
  then create a fresh topic with the same slug.

## Schema versioning

Every snapshot and every event line carries `schema_version: number`.
On read, `lib/schema/migrate.ts` runs migrators in order until the
in-memory shape matches the latest definition. Adding fields means
bumping the version and writing a migrator that fills defaults; removing
or renaming fields means the same.

Files written by a newer version of the skill than the reader knows
about cause a hard error rather than silent best-effort. Forward
compat is opt-in.

## Locking

Mutations (`createTopic`, `recordInvocation`, `archiveTopic`) take a
per-topic lock via `mkdir(<topic>.lock/)`. The lock dir contains
`info.json` with `{pid, hostname, agent, topic, acquiredAt}` so a
contending caller can distinguish "live holder" from "crashed holder".

Stale-detection:
- Lock older than 30s → remove and retry
- Lock holder's PID alive (same hostname) → wait, never force-clear
- PID not found (`ESRCH`) → clear and retry

Reads (`loadSnapshot`, `readHistory`) take no lock. Atomic-write of the
snapshot guarantees a concurrent read sees prior or new state, never
torn. Trailing partial line in `history.jsonl` is tolerated on read.

## Archive retention

`handoff prune` enforces a retention envelope. Defaults:

- **Keep last N archives** per topic: 20
- **Keep up to M days**: 90

Both apply: a topic with 30 archives less than 90 days old keeps the
last 20; a topic with 5 archives all > 90 days old keeps zero.

Archives are immutable — pruning is the only delete.

## Privacy

The registry stores **summaries, verdicts, session IDs, round counts,
timestamps**. NOT prompts, NOT response bodies. Each agent owns its own
transcript (codex server-side, claude local-transcript, cursor stateless);
duplicating in the registry would risk leakage and bloat.

Opt in to local trace via `--store-trace`; trace files store the full
prompt and full agent output under `traces/<topic>/<round>-<agent>.json`.
