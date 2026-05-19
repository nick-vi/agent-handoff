# Methodology

When to handoff vs stay inline. Worked examples follow.

## Default rule

> Handoff for independent artifact. Inline for collaboration.

If you want an answer that another agent could write down without
reading your conversation history — handoff. If you want to riff back and
forth, narrowing a problem with shared context — inline.

## Inline (don't handoff)

- Iterating on a plan with the user. A handoff freezes a snapshot
  mid-thought.
- Small clarifying questions. "Should we use option A or B?" doesn't
  need an independent reviewer.
- Code search across the local repo. The current agent has tools.
- Stylistic choices. "Is this name good?" is collaborative.

## Handoff

- **Code review of a finished diff or written plan.** Codex peer-reviews;
  the artifact (findings + verdict) stands alone, independent of the
  drafting conversation.
- **Bounded execution from a clear brief.** Cursor takes a brief, ships
  a diff, validates. Caller verifies and accepts.
- **Debug diagnosis of a clean failure.** "Test X fails with error Y;
  diagnose root cause." A separate agent with fresh context often spots
  what the original missed.
- **Audit of a module the calling agent didn't write.** Path-scoped,
  read-only, produces findings.
- **Multi-round design review where you want a peer.** Codex resumes
  across rounds via session continuity; each round is a discrete artifact.

## Worked example: the OpenFIGI plan

This skill itself was used as a vehicle for testing the design pattern:

1. Claude drafts an OpenFIGI integration plan in a project conversation.
2. Plan is mature enough for outside review. Claude hands off:
   `handoff send --agent codex --mode consult --topic openfigi-plan --prompt-file plan.md`
3. Codex returns findings + verdict (advisory).
4. Claude addresses the findings, drafts v2 of the plan.
5. Claude hands off again to the same topic — codex resumes the thread:
   `handoff send --agent codex --mode consult --topic openfigi-plan --prompt "v2 addresses the schema concern, see ..."`
6. Round count = 2. Verdict = advisory. Claude addresses pushback.
7. Round 3: codex returns verdict = sign-off (mapped to `ok`).
8. Claude implements. Future debug pass on this work would
   `handoff send --agent codex --mode debug --topic openfigi-plan ...`
   and inherit the design context from the same thread.

What was independent: each codex round is a self-contained findings
artifact. Findings cite line numbers, propose fixes, give a verdict.
What was collaborative: drafting the plan, narrowing the brief, reading
the findings and deciding which to act on.

## Anti-patterns

- **Relaying every micro-decision.** "Should this variable be `let` or
  `const`?" is inline. Handoff imposes overhead.
- **Relaying without a brief.** A vague prompt yields vague output. The
  handoff does not enforce the brief contract; the calling agent must.
- **Recursive handoff loops.** The skill blocks them by default
  (`AGENT_HANDOFF_DEPTH`). If you genuinely need agent A → B → A, name a
  topic per leg, not one topic for the whole loop.
- **Treating Verdict as truth.** Verdict is a hint for the calling
  workflow. Always inspect the body and validate.
