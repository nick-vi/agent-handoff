# Agent: claude

CLI: `claude` (Claude Code)

## Invocation shape

```bash
# new session
claude --print --dangerously-skip-permissions --output-format json "<prompt>"

# resume existing
claude --print --dangerously-skip-permissions --output-format json --resume <session-id> "<prompt>"
```

`--print` is required for non-interactive output. Without it, Claude
launches its TUI.

`--output-format json` is always passed so the handoff receives a
structured envelope with `session_id`, `result`, `is_error`, and
permission-denial details.

`--dangerously-skip-permissions` is always passed. Without it, claude
prompts on every write or Bash invocation; with no human at the TTY
the run hangs until timeout and the handoff sees a zero-exit empty
response that defaults to `Verdict: ok` — false signal. Mirrors
codex's `--full-auto` and cursor's `--yolo`.

## Session model

Claude Code stores sessions in local transcripts at
`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. `--resume <uuid>` picks
up where you left off; `--continue` picks up the most recent session in
the cwd.

The handoff tracks per-(topic, claude) session IDs in the snapshot. If
the local transcript is deleted, `--resume <uuid>` errors; the handoff
records that error response and **does not** fall back to a new
session — the next round would pass the same (now-dead) ID and likely
fail again. Workaround: `handoff reset-session <topic> --agent claude
--reason expired` to clear only Claude's session pointer, or archive
and re-send to start completely clean.

## Output parsing

Verdict line:
```
^[\s\-*]*Verdict[:\s]+\s*(ok|advisory|blocked|error)\b
```

Claude stdout is expected to be a JSON object from `--output-format
json`. The handoff reads:
```
{
  "session_id": "...",
  "result": "...",
  "is_error": false,
  "permission_denials": []
}
```

If the JSON envelope is missing or malformed, the adapter treats the
round as an error instead of guessing from free-form stdout.

## Default model

By default, whatever the Claude Code config picks. Handoff can pin a
skill-owned per-invocation model and effort:

```bash
# Example pin; update as Anthropic model aliases change.
handoff model set claude latest-claude --effort max --fallback-model opus,sonnet
handoff model set claude fast-opus --effort max
```

This causes sends to pass `--model <model>` and `--effort <level>` to
`claude`. With `--fallback-model`, handoff passes Claude Code's native
fallback chain. With `--speed fast`, handoff also passes a per-session
`--settings '{"fastMode":true}'` override, but suppresses fast mode for
non-Opus effective models. Unset with
`handoff model unset claude` to return to Claude Code's own
config/default.

Version-conscious profiles:

- `latest-claude`: Fable on Claude Code `2.1.170+`; otherwise Opus.
- `latest-opus`: Opus alias.
- `fast-opus`: Opus alias plus fast mode.

## Modes supported

`consult`, `audit`, `review`, `debug`, `execute`.

## Quirks

- **Project context**. Claude reads `CLAUDE.md` from the cwd
  automatically. The brief in the prompt is supplementary.
- **Execute is supported**. Cursor is still the faster primary executor
  for bounded code edits; Claude is useful when execution needs more
  deliberate multi-file reasoning.
- **Conversation length**. Long resumed sessions accumulate context;
  if a topic crosses many rounds with claude, eventually the session
  window saturates and behavior degrades. Use
  `handoff reset-session <topic> --agent claude --reason expired` to
  mint a fresh Claude session while preserving topic history, or
  `handoff send --topic <topic> --archive-and-new ...` to archive the
  topic and start clean under the same slug.
