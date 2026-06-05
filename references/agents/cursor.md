# Agent: cursor

CLI: `cursor-agent` (Cursor IDE companion CLI)

## Invocation shape

```bash
cursor-agent \
  --print \
  --output-format json \
  --trust \
  --workspace <path> \
  --model composer-2.5-fast \
  --yolo \
  [--resume <chatId>] \
  "<prompt>"
```

The prompt is positional and must be the final argument. Current
`cursor-agent` builds no longer accept the older `agent` subcommand or
`--prompt` flag.

`--yolo` is always passed. Handoff invocations are non-interactive by
design — there's no human at the TTY to approve per-step prompts, so
omitting `--yolo` would just cause the run to hang. Mirrors codex's
`--full-auto` and claude's `--dangerously-skip-permissions`. Mode
constrains what cursor *should* do (read-only modes shouldn't write
regardless); the flag just removes the prompts that would otherwise
block an unattended run.

## Session model

**Resumable.** Cursor exposes durable chats via `--resume <chatId>` and
emits a `session_id` field in its JSON envelope. The handoff captures
`session_id` from stdout on first invocation and stores it under the
topic's `cursor` slot; subsequent rounds whose mode auto-resumes
(`consult`, `debug`) or whose caller passes `--resume` will pass
`--resume <chatId>` back to cursor.

`consult` and `debug` auto-resume by default under handoff's mode policy.
Other modes capture the session ID too, but only pass it back when the
caller explicitly uses `--resume`.

Cursor's session IDs are uuidv4 (8-4-4-4-12 hex, no leading-7 in the
time-low dword like codex's uuidv7).

## Default model

`composer-2.5-fast`. Cheap, fast, suitable for bounded execution. Override
the handoff-owned default with:

```bash
handoff model set cursor gpt-5
```

This changes the `--model <model>` value passed to `cursor-agent`.
`handoff model unset cursor` returns to the built-in `composer-2.5-fast`
fallback.

Cursor Agent does not expose a separate handoff speed knob; choose a
`*-fast` model ID such as `composer-2.5-fast`.

## Modes supported

`execute`, `review`, `audit`, `debug`, `consult`.

Cursor is primary for `execute`; codex or claude are still better
defaults for deeper `review`, `audit`, `debug`, and `consult` work.

## Output parsing

Cursor returns JSON. The handoff walks stdout lines from the end looking
for the canonical `result`-shaped envelope and pulls `session_id` from
it. Verdict is parsed from a `Verdict:` line in the body if present;
otherwise defaults from exit code.

For richer parsing, the calling agent's brief should specify the expected
structured output shape (Files Changed / Validation / Verdict) and
include it in the prompt.

## Quirks

- **Workspace must be absolute and trusted.** `--trust` opts into the
  workspace's `.cursor/rules/` and project setup.
- **Large diffs in stdout.** Cursor emits the full implementation summary
  + JSON envelope. Pipe through `jq '.result'` to extract just the
  result body if scripts need it.
- **Worktree support**. Pass `--worktree <name>` if your workflow uses
  Cursor worktrees. Handoff does not currently surface this; add to the
  adapter if you need it.
