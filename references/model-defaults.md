# Model defaults

Handoff can pin per-agent defaults without editing the agents' own
global config files:

```bash
handoff model                         # list effective defaults
handoff model --path                  # print the backing JSON file
# Example pins; update as provider model names change.
handoff model set codex gpt-5.5 --effort xhigh --speed fast
handoff model set claude opus --effort max --speed fast
handoff model set cursor composer-2.5-fast
handoff model unset codex             # remove model + effort + speed
handoff model unset codex --effort-only
handoff model unset codex --speed-only
```

The backing file is `<state-dir>/agent-defaults.json`, where
`<state-dir>` follows the same resolution as topic state:
`AGENT_HANDOFF_STATE_DIR`, then `${XDG_DATA_HOME}/agent-handoff`, then
`~/.local/share/agent-handoff`.

Environment variables override the state file for one process tree:

| Agent | Model env | Effort env | Speed env |
|---|---|---|---|
| `codex` | `AGENT_HANDOFF_CODEX_MODEL` | `AGENT_HANDOFF_CODEX_REASONING_EFFORT` | `AGENT_HANDOFF_CODEX_SPEED` |
| `claude` | `AGENT_HANDOFF_CLAUDE_MODEL` | `AGENT_HANDOFF_CLAUDE_EFFORT` | `AGENT_HANDOFF_CLAUDE_SPEED` |
| `cursor` | `AGENT_HANDOFF_CURSOR_MODEL` | unsupported | unsupported; encode speed in model ID |

Adapter mapping:

- Codex: `--model <model>` and
  `-c model_reasoning_effort="<effort>"`. `--speed fast` adds
  `-c features.fast_mode=true -c service_tier="fast"`.
- Claude: `--model <model>` and `--effort <level>`. `--speed fast`
  adds `--settings '{"fastMode":true}'`.
- Cursor: `--model <model>`. If unset, handoff still passes its built-in
  `composer-2.5-fast` default. There is no separate speed flag.

Unset means "let the underlying CLI decide" for Codex and Claude. For
Cursor, unset means "use handoff's built-in `composer-2.5-fast` fallback",
matching the original adapter behavior.

Model IDs are intentionally data, not schema. Use `handoff model set`
again when a provider renames, retires, or supersedes a model.
