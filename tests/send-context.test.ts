/**
 * `handoff send` topic context propagation.
 *
 * Uses a fake `codex` binary on PATH so the production CLI can execute
 * end-to-end without requiring a real agent install. The fake prints the
 * handoff env it inherited; assertions verify topic routing and child env.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
if [ "\${HANDOFF_FAKE_LONG_OUTPUT:-}" = "1" ]; then
  echo "long-output-start"
  i=0
  while [ "$i" -lt 13000 ]; do
    printf x
    i=$((i + 1))
  done
  echo
  echo "long-output-tail"
  echo "Verdict: ok"
  exit 0
fi
echo "handoff-topic=$AGENT_HANDOFF_TOPIC"
echo "handoff-workspace-root=$AGENT_HANDOFF_WORKSPACE_ROOT"
echo "handoff-workspace-dir=$AGENT_HANDOFF_WORKSPACE_DIR"
echo "handoff-run-id=$AGENT_HANDOFF_RUN_ID"
echo "handoff-parent-run-id=$AGENT_HANDOFF_PARENT_RUN_ID"
echo "handoff-caller-agent=$AGENT_HANDOFF_CALLER_AGENT"
echo "handoff-secret=\${HANDOFF_SECRET:-unset}"
echo "session 019df000-0000-7000-aaaa-000000000001"
echo "Verdict: ok"
`,
    'utf-8'
  );
  chmodSync(codex, 0o755);

  const claude = join(fakeBin, 'claude');
  writeFileSync(
    claude,
    `#!/usr/bin/env sh
printf '%s\\n' "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"handoff-caller-agent=\${AGENT_HANDOFF_CALLER_AGENT}\\\\nVerdict: ok\\\\n\\",\\"session_id\\":\\"6989a01b-a788-482d-a121-57780ea123bf\\"}"
`,
    'utf-8'
  );
  chmodSync(claude, 0o755);

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
  if (!('AGENT_HANDOFF_CALLER_AGENT' in env)) delete childEnv.AGENT_HANDOFF_CALLER_AGENT;
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
    expect(r.stdout).toContain('handoff-caller-agent=codex');
    expect(r.stdout).toContain('Verdict: ok');
  });

  it('stores every round trace and retrieves full output by result command', () => {
    const f = setup();
    const r = handoff(f, [
      'send',
      '--agent',
      'codex',
      '--mode',
      'review',
      '--topic',
      'trace-topic',
      '--prompt',
      'review this',
    ]);

    expect(r.code).toBe(0);
    const workspaceDir = readdirSync(join(f.stateRoot, 'sessions'))[0]!;
    const tracePath = join(
      f.stateRoot,
      'sessions',
      workspaceDir,
      'traces',
      'trace-topic',
      '000001-codex.json'
    );
    const trace = JSON.parse(readFileSync(tracePath, 'utf-8'));
    expect(trace.prompt).toBe('review this');
    expect(trace.output).toContain('handoff-topic=trace-topic');

    const output = handoff(f, [
      'result',
      'trace-topic',
      '--round',
      '1',
      '--agent',
      'codex',
      '--part',
      'output',
    ]);
    expect(output.code).toBe(0);
    expect(output.stdout).toContain('handoff-topic=trace-topic');

    const prompt = handoff(f, [
      'result',
      'trace-topic',
      '--round',
      '1',
      '--agent',
      'codex',
      '--part',
      'prompt',
    ]);
    expect(prompt.code).toBe(0);
    expect(prompt.stdout).toBe('review this\n');

    const path = handoff(f, [
      'result',
      'trace-topic',
      '--round',
      '1',
      '--agent',
      'codex',
      '--path',
    ]);
    expect(path.code).toBe(0);
    expect(path.stdout.trim()).toBe(tracePath);
  });

  it('previews large stdout while preserving full output in result storage', () => {
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
        'large-output',
        '--prompt',
        'review this',
      ],
      { HANDOFF_FAKE_LONG_OUTPUT: '1' }
    );

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('[handoff] full output stored:');
    expect(r.stdout).toContain('[handoff] retrieve: handoff result large-output --round 1 --agent codex --part output');
    expect(r.stdout).toContain('long-output-start');
    expect(r.stdout).toContain('stdout preview truncated');
    expect(r.stdout).not.toContain('long-output-tail');

    const output = handoff(f, ['result', 'large-output', '--latest', '--agent', 'codex']);
    expect(output.code).toBe(0);
    expect(output.stdout).toContain('long-output-start');
    expect(output.stdout).toContain('long-output-tail');
    expect(output.stdout).toContain('Verdict: ok');
  });

  it('sets child caller identity even when parent env belongs to another agent', () => {
    const f = setup();
    const r = handoff(
      f,
      [
        'send',
        '--agent',
        'claude',
        '--mode',
        'review',
        '--topic',
        'caller-identity',
        '--prompt',
        'review this',
      ],
      { CODEX_THREAD_ID: '019df000-0000-7000-aaaa-000000000001' }
    );

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('handoff-caller-agent=claude');
  });

  it('records explicit caller identity before stale agent env', () => {
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
        'caller-precedence',
        '--prompt',
        'review this',
      ],
      {
        AGENT_HANDOFF_CALLER_AGENT: 'claude',
        CODEX_THREAD_ID: '019df000-0000-7000-aaaa-000000000001',
      }
    );

    expect(r.code).toBe(0);
    const workspaceDirs = readdirSync(join(f.stateRoot, 'sessions'));
    expect(workspaceDirs.length).toBe(1);
    const workspaceDir = workspaceDirs[0]!;
    const historyPath = join(f.stateRoot, 'sessions', workspaceDir, 'caller-precedence.history.jsonl');
    const [created] = readFileSync(historyPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    expect(created.caller_agent).toBe('claude');
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
