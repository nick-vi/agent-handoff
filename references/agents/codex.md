# Agent: codex

CLI: [`codex`](https://github.com/openai/codex)

## Invocation shape

```bash
# new session
codex exec [--model <model>] [-c 'model_reasoning_effort="<effort>"'] --full-auto "<prompt>"

# resume existing thread
codex exec resume <uuid> [--model <model>] [-c 'model_reasoning_effort="<effort>"'] --full-auto "<prompt>"
```

The handoff always passes `--full-auto` because handoff invocations are
non-interactive by design. The agent should never block on approval.

## Session model

Codex stores threads server-side as UUID-keyed conversations. The UUID
appears multiple times in stdout; the handoff extracts the last
occurrence as the canonical session ID after the round.

Resume across server restarts works; resume across thread expiration
does not. If `codex exec resume <uuid>` returns "thread not found",
the handoff records the error response, keeps the (now-dead) session ID
in the snapshot, and exits with the agent's verdict (likely `error`).
Next round will pass the same dead ID. **Auto-fallback to a new
session is not implemented.** Workaround: `handoff archive <topic>` then
re-send (creates a fresh topic + session).

## Output parsing

Verdict line:
```
^[\s\-*]*Verdict[:\s]+\s*(ok|advisory|blocked|error)\b
```

Session ID:
```
\b([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})\b
```

Last occurrence wins (later mentions reflect post-mutation state).

## Default model

By default, whatever codex's CLI configuration picks. Handoff can pin a
skill-owned per-invocation model and reasoning effort:

```bash
# Example pin; update as OpenAI model names change.
handoff model set codex gpt-5.5 --effort xhigh --speed fast
```

This causes sends to pass `--model <model>` and
`-c model_reasoning_effort="<effort>"` to `codex exec`. With
`--speed fast`, handoff also passes
`-c features.fast_mode=true -c service_tier="fast"`. Unset with
`handoff model unset codex` to return to codex's own config
(`~/.codex/config.toml`) or built-in default.

## Modes supported

`review`, `audit`, `debug`, `consult`, `execute`.

## Quirks

- **Web search + fetch enabled by default** when `--full-auto` is set.
  Useful for review modes hitting external docs (e.g. checking
  OpenFIGI's spec).
- **Long stdout**. Codex's tool-call output and final reply both go to
  stdout; the handoff returns the full body. Caller's responsibility to
  trim if piping further.
- **Rate-limit at scale**. Codex has soft daily quotas. The handoff does
  not throttle internally; caller workflows should pace if running
  many rounds in a tight loop.
