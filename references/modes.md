# Modes

Five modes. Each describes a category of work, not a specific agent
binding.

**All agents support all modes.** Use whichever fits — the handoff no
longer rejects on adapter-side mode allowlists. The matrix below is
guidance, not a gate. The "primary" column is a default; "viable"
agents work fine for the same job, with the trade-offs noted below.

## Mode → recommended agent

| Mode | Primary | Viable | Notes |
|------|---------|--------|-------|
| `execute` | cursor | claude, codex | Cursor's `--yolo` is fastest for bounded code edits; claude is more deliberate (better at multi-file reasoning); codex slower but works as fallback |
| `review` | codex | claude, cursor | Codex's reasoning fits diff/PR review; claude better when review needs prose-heavy explanation; cursor third-choice |
| `audit` | codex | claude, cursor | Same shape as review but read-only on a path/module |
| `debug` | codex | claude, cursor | Either reasoning model fits; cursor third-choice unless the bug is in code it just wrote |
| `consult` | codex or claude | cursor | Multi-round design review; both reasoning models hold context across rounds via session resume; cursor consult works but is shallower |

The handoff only checks `supportedModes` to surface "this adapter
doesn't claim to support that mode" warnings. All three current
adapters declare all five modes.

## Per-agent strengths (heuristic, drifts fast)

### claude
- Strong: nuanced consult, prose-heavy review, multi-file reasoning,
  long-form debug diagnosis, anything that benefits from careful
  step-by-step thinking
- Weak: not the fastest executor; slower turnaround than cursor for
  small bounded edits
- When to pick: design discussions, complex bug diagnosis, reviews
  of plans/specs (not just diffs), tasks where reasoning quality
  matters more than throughput

### codex
- Strong: diff and PR review, repo-aware audit, root-cause debugging,
  multi-round consult with durable server-side threads
- Weak: execute is bounded but slow vs cursor; less polished prose
- When to pick: code review on a diff, "audit this module for
  smells", "diagnose this stack trace", "design the schema and we'll
  iterate over rounds"

### cursor
- Strong: fast bounded code execution (`--yolo`), CURSOR.md-driven
  project context awareness, write-then-validate loops
- Weak: review and debug are shallower than codex/claude; consult is
  serviceable but not the natural fit
- When to pick: "implement this brief", "apply this diff suggestion",
  "wire up this integration" — anything where speed of writing code
  matters more than depth of reasoning

## execute

**Purpose**: write code per a brief.

**Output expectation**:
```
Summary
- <what was implemented>

Files Changed
- path/to/file.ts
- path/to/other-file.ts

Validation
- <command>: <pass/fail>

Open Issues
- <issue or none>

Verdict: ok | advisory | blocked | error
```

**Cursor notes**: `--yolo` bypasses per-step approval. Cursor reads
project context (CURSOR.md, etc) automatically. Fastest for small
bounded changes.

**Claude notes**: more deliberate. Better when the brief touches
several files or needs the agent to reason about cross-file
implications before writing. Slower than cursor.

**Codex fallback**: when no cursor-agent on the host or the change is
small enough that latency doesn't matter, codex with `--full-auto`
executes bounded changes. Works, slower than the alternatives.

## review

**Purpose**: find problems in a diff, PR, plan, or document.

**Output expectation**:
```
Findings
- [P0/P1/P2] file:line — issue. Suggested fix.
- ...

Verdict: ok | advisory | blocked | error

Open Questions
- ...
```

**Codex notes**: `codex exec review` is a native subcommand for
repo-aware review against pending changes. The handoff uses plain
`codex exec` and includes the diff in the prompt; both work.

**Claude notes**: better for reviews that need prose explanation
(architecture critique, spec review, RFC commentary).

## audit

**Purpose**: assess a path or module without proposing changes.
Read-only by definition.

**Output expectation**: same as `review` but the brief scopes a
path/module rather than a diff. No "fix" pressure on the auditor.

## debug

**Purpose**: diagnose a specific failure.

**Brief should include**: the error (verbatim), reproduction steps if
known, the relevant files/log excerpts.

**Output expectation**:
```
Diagnosis
- <root cause>
- <evidence>

Suggested Fix
- <approach>
- <files to change>

Verdict: ok | advisory | blocked | error
```

## consult

**Purpose**: multi-round design review where the consulting agent
holds context across rounds via session resume.

**Brief should include**: enough state for round 1 to be self-contained
(no implicit "you remember what we discussed earlier"). On rounds ≥ 2,
the agent already has its server-side context; the new prompt can
reference prior rounds tacitly ("addressing your pushback on X").

**Output expectation**: free-form, but caller should still emit a
Verdict line so the registry can categorize each round.

## Picking a mode

If unsure, default to `consult` — most forgiving and supports
multi-round.

If you want a one-shot artifact and are sure the receiving agent has
enough context in the brief alone, `review` or `audit`.

If you want code written, `execute`.

If you have a specific failure to diagnose, `debug`.
