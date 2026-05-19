# Agent: claude

CLI: `claude` (Claude Code)

## Invocation shape

```bash
# new session
claude --print --dangerously-skip-permissions "<prompt>"

# resume existing
claude --print --dangerously-skip-permissions --resume <session-id> "<prompt>"
```

`--print` is required for non-interactive output. Without it, Claude
launches its TUI.

`--dangerously-skip-permissions` is always passed. Without it, claude
prompts on every write or Bash invocation; with no human at the TTY
the run hangs until timeout and the handoff sees a zero-exit empty
response that defaults to `Verdict: ok` — false signal. Mirrors
codex's `--full-auto` and cursor's `--yolo` (which cursor only sets
for `execute`; claude needs the bypass for any mode that might reach
for Bash, including audit/debug).

## Session model

Claude Code stores sessions in local transcripts at
`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. `--resume <uuid>` picks
up where you left off; `--continue` picks up the most recent session in
the cwd.

The handoff tracks per-(topic, claude) session IDs in the snapshot. If
the local transcript is deleted, `--resume <uuid>` errors; the handoff
records that error response and **does not** fall back to a new
session — the next round would pass the same (now-dead) ID and likely
fail again. Workaround: `handoff archive <topic>` and re-send to start
clean.

## Output parsing

Verdict line:
```
^[\s\-*]*Verdict[:\s]+\s*(ok|advisory|blocked|error)\b
```

Session ID extraction is best-effort; Claude's stdout doesn't reliably
emit a `session-id=` banner the way codex does. The handoff looks for:
```
\bsession[_\- ]id[:=\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b
```

If the regex misses, the handoff reuses the prior session ID (when
resuming) or null (when starting). The trade-off: a new session that
mints a UUID we don't capture means the next round starts another new
session instead of resuming. Caller can pass `--session-id <uuid>` if
they captured it from somewhere else.

## Default model

Whatever the Claude Code config picks. Override per-call via
`--model <name>` (handoff doesn't surface this yet).

## Modes supported

`consult`, `audit`, `review`, `debug`.

## Quirks

- **Project context**. Claude reads `CLAUDE.md` from the cwd
  automatically. The brief in the prompt is supplementary.
- **No execute mode here**. Claude Code can write code, but cursor with
  `--yolo` is the cleaner executor with explicit project-context wiring
  and a tighter brief contract.
- **Conversation length**. Long resumed sessions accumulate context;
  if a topic crosses many rounds with claude, eventually the session
  window saturates and behavior degrades. Archive with `handoff archive
  <topic> --archive-and-new` to start a fresh session while preserving
  history.
