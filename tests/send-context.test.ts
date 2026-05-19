/**
 * `handoff send` topic context propagation.
 *
 * Uses a fake `codex` binary on PATH so the production CLI can execute
 * end-to-end without requiring a real agent install. The fake prints the
 * handoff env it inherited; assertions verify topic routing and child env.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HANDOFF = join(__dirname, '..', 'bin', 'agent-handoff.ts');

type Fixture = {
  root: string;
  stateRoot: string;
  workspace: string;
  fakeBin: string;
};

const fixtures: Fixture[] = [];

function setup(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agent-handoff-send-context-'));
  const stateRoot = join(root, 'state');
  const workspace = join(root, 'workspace');
  const fakeBin = join(root, 'bin');
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });

  const codex = join(fakeBin, 'codex');
  writeFileSync(
    codex,
    `#!/usr/bin/env sh
echo "handoff-topic=$AGENT_HANDOFF_TOPIC"
echo "handoff-workspace-root=$AGENT_HANDOFF_WORKSPACE_ROOT"
echo "handoff-workspace-dir=$AGENT_HANDOFF_WORKSPACE_DIR"
echo "handoff-run-id=$AGENT_HANDOFF_RUN_ID"
echo "handoff-parent-run-id=$AGENT_HANDOFF_PARENT_RUN_ID"
echo "handoff-secret=\${HANDOFF_SECRET:-unset}"
echo "session 019df000-0000-7000-aaaa-000000000001"
echo "Verdict: ok"
`,
    'utf-8'
  );
  chmodSync(codex, 0o755);

  const fixture = { root, stateRoot, workspace, fakeBin };
  fixtures.push(fixture);
  return fixture;
}

function handoff(
  f: Fixture,
  argv: string[],
  env: Record<string, string> = {}
): { code: number | null; stdout: string; stderr: string } {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    AGENT_HANDOFF_STATE_DIR: f.stateRoot,
    PATH: `${f.fakeBin}:${process.env.PATH ?? ''}`,
  };
  if (!('AGENT_HANDOFF_TOPIC' in env)) delete childEnv.AGENT_HANDOFF_TOPIC;
  delete childEnv.AGENT_HANDOFF_DEPTH;
  delete childEnv.AGENT_HANDOFF_TOKEN;
  const r = spawnSync('bun', [HANDOFF, ...argv, '--workspace', f.workspace], {
    env: childEnv,
    encoding: 'utf-8',
    timeout: 8000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('send context propagation', () => {
  afterEach(() => {
    for (const f of fixtures.splice(0)) {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('injects topic and run metadata into the child agent env', () => {
    const f = setup();
    const r = handoff(f, [
      'send',
      '--agent',
      'codex',
      '--mode',
      'review',
      '--topic',
      'context-topic',
      '--prompt',
      'review this',
    ]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('handoff-topic=context-topic');
    expect(r.stdout).toContain(`handoff-workspace-root=${realpathSync(f.workspace)}`);
    expect(r.stdout).toMatch(/handoff-workspace-dir=workspace-[0-9a-f]{12}/);
    expect(r.stdout).toMatch(/handoff-run-id=run-[a-z0-9]+-[a-z0-9]+/);
    expect(r.stdout).toContain('handoff-parent-run-id=');
    expect(r.stdout).toContain('Verdict: ok');
  });

  it('uses inherited AGENT_HANDOFF_TOPIC when --topic is omitted', () => {
    const f = setup();
    const r = handoff(
      f,
      ['send', '--agent', 'codex', '--mode', 'review', '--prompt', 'review this'],
      { AGENT_HANDOFF_TOPIC: 'inherited-topic' }
    );

    expect(r.code).toBe(0);
    expect(r.stderr).toContain('using topic from AGENT_HANDOFF_TOPIC: inherited-topic');
    expect(r.stdout).toContain('handoff-topic=inherited-topic');
  });

  it('can spawn the child with a clean environment', () => {
    const f = setup();
    const r = handoff(
      f,
      [
        'send',
        '--agent',
        'codex',
        '--mode',
        'review',
        '--topic',
        'clean-env-topic',
        '--prompt',
        'review this',
        '--clean-env',
      ],
      { HANDOFF_SECRET: 'do-not-pass' }
    );

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('handoff-topic=clean-env-topic');
    expect(r.stdout).toContain('handoff-secret=unset');
    expect(r.stdout).toContain('env=clean');
  });

  it('requires --current before reading .handoff/current.json', () => {
    const f = setup();
    const created = handoff(f, [
      'send',
      '--agent',
      'codex',
      '--mode',
      'review',
      '--topic',
      'current-topic',
      '--prompt',
      'first round',
    ]);
    expect(created.code).toBe(0);

    const used = handoff(f, ['use', 'current-topic']);
    expect(used.code).toBe(0);

    const implicit = handoff(f, [
      'send',
      '--agent',
      'codex',
      '--mode',
      'review',
      '--prompt',
      'should not use pointer implicitly',
    ]);
    expect(implicit.code).toBe(2);
    expect(implicit.stderr).toContain('No --topic given and no inherited AGENT_HANDOFF_TOPIC');

    const explicit = handoff(f, [
      'send',
      '--agent',
      'codex',
      '--mode',
      'review',
      '--current',
      '--prompt',
      'explicit current',
    ]);
    expect(explicit.code).toBe(0);
    expect(explicit.stderr).toContain('using current topic from .handoff/current.json: current-topic');
    expect(explicit.stdout).toContain('handoff-topic=current-topic');
  });
});
