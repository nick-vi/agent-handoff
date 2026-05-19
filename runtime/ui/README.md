# agent-handoff inspector

Source static local UI shell for reading handoff topics, sends, and
agent-native transcripts.

Launch through `handoff ui` so the shell can fetch actual workspace state
from `/api/snapshot`. `bun run build` copies this directory into
`runtime/ui/`, which is the install-time asset directory served by
bundled releases.

## What it demonstrates

- Project switcher that defaults to all projects with handoff activity,
  while keeping the selected transcript scoped to one project/topic.
- Search across topics, summaries, sessions, and visible sends.
- Primary transcript reader with markdown-aware rendering and lightweight syntax highlighting.
- Right-side handoff send timeline for scanning each `handoff send` delta in the selected topic.
- Verdicts plus missing transcript/no-session hints on the relevant topic or send.
- Live elapsed labels that update without re-rendering the full UI, so open details and scroll positions stay stable.
- Contained pane scrolling: the app frame stays fixed while topics, transcript, and send timeline scroll independently.

## Keyboard model

- `/` focuses search.
- `j` / `k` move through visible rounds.
- `[` / `]` move through rounds for the selected agent lane.
- `g` / `G` jump to the first or last visible round.
- `Esc` clears search when search is focused.

## Production wiring

`handoff ui` serves a read-only adapter over:

- `<state>/sessions/<workspace>/<topic>.json`
- `<state>/sessions/<workspace>/<topic>.history.jsonl`
- `<state>/running/<workspace>/*.json`
- optional traces under `traces/<topic>/`
- agent-native transcript resolvers for claude, codex, and cursor

Run:

```bash
handoff ui
handoff ui --all-workspaces
handoff ui --port 0 --workspace /path/to/project
```

The browser UI requests all projects by default and lets the user narrow
to one project from the top-left switcher. `--all-workspaces` keeps the
server's initial `/api/snapshot` response in all-projects mode for API
consumers. The server gives each topic a stable `workspaceDir/topic` key
so duplicate slugs across projects do not collide.
The server binds to localhost by default and refuses non-loopback hosts
unless `--unsafe-host` is passed. On unsafe hosts, native transcript
content is disabled unless `--include-transcripts` is explicit. Pass
`--no-transcripts` for metadata-only inspection on any host.

The served UI does not poll. It loads real workspace data from
`/api/snapshot` and preserves topic, transcript, and send-list scroll
positions when the selected topic is refreshed.

The UI assets are static and packaged with the skill. Runtime data and
compatibility come from the serving `handoff` binary, which reads state
through the same schema migrators as the CLI and exposes release/schema
metadata in `/api/snapshot`.

Claude designed the initial direction: a dense three-pane product shell
with a topic list, center transcript reader, and right handoff send timeline.

A final Claude critique identified polish blockers around live refresh,
keyboard navigation, ARIA semantics, and responsive timeline columns. Those
are reflected in the current shell.
