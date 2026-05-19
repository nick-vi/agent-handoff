# Troubleshooting

Common failure modes during normal use, and what to do.

## "Refusing nested handoff invocation (AGENT_HANDOFF_DEPTH=1)"

**Symptom:** A handoff call inside an agent that was itself invoked via
handoff refuses with exit 3.

**Why:** Anti-recursion guard. Without it, codex→cursor→codex chains
could blow up into uncontrolled depth.

**Fix:** Pass `--allow-nested` to the inner call. Name a different
topic when the inner call is an independent artifact or calls the same
agent as the outer call; otherwise the inner call can omit `--topic`
and inherit `AGENT_HANDOFF_TOPIC` from the parent handoff process.

```bash
# Outer (called by you)
handoff send --agent codex --mode consult --topic outer-design \
  --prompt "design X. If you need cursor to test something, run:
handoff send --agent cursor --mode execute --topic outer-design-exec \
  --allow-nested --prompt-file ..."
```

## "Topic 'X' is new but this workspace has active topics already"

**Symptom:** `handoff send --topic foo-bar` errors with a list of
existing topics.

**Why:** Discovery guard. Catching slug typos before they fragment the
registry.

**Fix:**
- If `foo-bar` is genuinely new: `--new-topic` to confirm
- If you meant one of the listed slugs: pass `--topic <real-slug>`
- If you want the human pointer: `handoff use <real-slug>` first, then
  send with `--current`

## Agent's session expired (codex thread not found, claude transcript missing)

**Symptom:** `handoff send` to a topic with a stored session ID gets an
agent error "thread not found" or similar.

**Why:** Agent-side state expired. The handoff does not auto-fall-back
because masking expiration as "new session" can hide auth/quota errors
that look identical.

**Fix:**
```bash
handoff reset-session <topic> --agent <name> --reason expired
```
Nulls the session ID under lock; appends a `session_reset` event;
preserves topic round count + history. Next consult/debug round mints
a fresh session.

Alternative: `handoff archive <topic>` and re-send to start completely
clean (loses topic continuity).

## Lock timeout: "Could not acquire lock for topic X"

**Symptom:** Hung lock dir; subsequent sends time out after ~30s.

**Why:** Crashed process left `<topic>.lock/` behind, AND lock's PID
matches a still-live process on this host (false positive).

**Fix:**
```bash
# Inspect first
ls -la $(handoff doctor | grep 'state dir' | awk '{print $NF}')/sessions/*/<topic>.lock/
cat .../info.json   # PID, hostname, agent, acquired_at

# If clearly stale (PID dead, old timestamp), remove
rm -rf .../sessions/<workspace>/<topic>.lock/
```

The 30s stale threshold catches almost all cases automatically; manual
removal is the escape hatch for the rest.

## Pointer points at archived topic

**Symptom:** `handoff send --current` creates a fresh topic with the slug
of one you recently archived.

**Why:** Pointer wasn't cleared. Should not happen anymore — `handoff
archive` and `--archive-and-new` both clear the pointer if it matched.
But if you set the pointer manually after archiving, this can recur.

**Fix:** `handoff clear` to drop the pointer, then `handoff use <real-slug>`
or send with explicit `--topic`.

## `handoff` command not found

**Symptom:** Agent prompts try `handoff send ...`, shell errors "command
not found".

**Why:** Symlinking the skill into `~/.claude/skills/agent-handoff/`
makes the SKILL.md visible but does NOT add `handoff` to PATH.

**Fix:**
```bash
ln -s ~/.agents/skills/agent-handoff/bin/agent-handoff ~/.local/bin/handoff
# verify
which handoff
handoff help
```

## `bun: command not found`

**Symptom:** `handoff` invokes but the bun shebang fails.

**Why:** Bun is the runtime; not pre-installed on macOS or most Linuxes.

**Fix:** Install bun: `curl -fsSL https://bun.sh/install | bash`. Then
`handoff doctor` to confirm presence.

## Agent binary missing (`codex`, `claude`, `cursor-agent`)

**Symptom:** `handoff send --agent codex` fails with `spawn codex ENOENT`.

**Why:** The named agent CLI isn't on PATH.

**Fix:** `handoff doctor` lists which agents are findable. Install the
missing one or invoke with a different `--agent`.

## Workspace key changed (project moved/renamed)

**Symptom:** Topics from a project disappear after you rename or move
the project dir.

**Why:** Workspace hash is sha256 of the resolved git repo root
(`--git-common-dir` minus trailing `.git`, or realpath cwd outside a
repo). New path → new hash → new (empty) workspace dir.

**Fix:**
```bash
# Find the historical hash
handoff alias --suggest

# Pin it to the new path
handoff alias /Users/me/code/new-name <12-hex-hash>

# Verify
handoff doctor   # should now show aliased=true
handoff list     # historical topics back
```

## Codex review of a fresh diff produces "Verdict: ok" with no findings

**Symptom:** `--mode review` returns terse output and passes.

**Why:** `review` mode does NOT auto-resume the prior session, so codex
sees the prompt with no historical context. If the prompt didn't
include the diff or relevant context, codex has nothing to review.

**Fix:** Include the diff (or paths to inspect) in the prompt. Or
switch to `--mode consult --resume` to carry prior session context.
