import { describe, expect, it } from 'bun:test';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspace } from '../lib/workspace.ts';

const HANDOFF = join(__dirname, '..', 'bin', 'agent-handoff.ts');

function writeTopic(stateRoot: string, workspaceCwd: string, topic: string): void {
  const ws = resolveWorkspace(workspaceCwd);
  const wsDir = join(stateRoot, 'sessions', ws.dirName);
  mkdirSync(wsDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(wsDir, `${topic}.json`),
    JSON.stringify(
      {
        schema_version: 1,
        topic,
        summary: `Production UI smoke topic ${topic}`,
        workspace: {
          resolvedRoot: ws.resolvedRoot,
          basename: ws.basename,
          hash: ws.hash,
          fromGit: ws.fromGit,
        },
        sessions: { codex: '019df000-7b9c-7000-a93d-067e4c31c232' },
        round_count: 2,
        created_at: now,
        last_used_at: now,
      },
      null,
      2
    )
  );
  writeFileSync(
    join(wsDir, `${topic}.history.jsonl`),
    [
      JSON.stringify({
        schema_version: 1,
        kind: 'created',
        ts: now,
        agent: 'codex',
        mode: 'consult',
        round: 1,
        session_id: '019df000-7b9c-7000-a93d-067e4c31c232',
        summary: `Production UI smoke topic ${topic}`,
      }),
      JSON.stringify({
        schema_version: 1,
        kind: 'invocation',
        ts: now,
        agent: 'codex',
        mode: 'debug',
        round: 2,
        session_id: '019df000-7b9c-7000-a93d-067e4c31c232',
        verdict: 'ok',
        duration_ms: 1234,
      }),
      '',
    ].join('\n')
  );
}

function setupState(): { stateRoot: string; workspaceCwd: string; cleanup: () => void } {
  const stateRoot = mkdtempSync(join(tmpdir(), 'agent-handoff-ui-state-'));
  const workspaceCwd = mkdtempSync(join(tmpdir(), 'agent-handoff-ui-ws-'));
  writeTopic(stateRoot, workspaceCwd, 'ui-prod-topic');
  return {
    stateRoot,
    workspaceCwd,
    cleanup: () => {
      rmSync(stateRoot, { recursive: true, force: true });
      rmSync(workspaceCwd, { recursive: true, force: true });
    },
  };
}

function waitForUrl(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for ui url')), 8000);
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      const match = /ui: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(text);
      if (!match?.[1]) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`handoff ui exited before ready: ${code}`));
    });
  });
}

describe('handoff ui', () => {
  it('serves actual workspace state through /api/snapshot', async () => {
    const ws = setupState();
    let child: ChildProcessWithoutNullStreams | null = null;
    try {
      child = spawn('bun', [HANDOFF, 'ui', '--port', '0', '--workspace', ws.workspaceCwd], {
        env: { ...process.env, AGENT_HANDOFF_STATE_DIR: ws.stateRoot },
      });
      const url = await waitForUrl(child);
      const response = await fetch(`${url}api/snapshot`);
      expect(response.status).toBe(200);
      type UiSnapshot = {
        workspace: { basename: string };
        topics: Array<{ slug: string; rounds: Array<{ mode: string; verdict: string }> }>;
      };
      const json = (await response.json()) as UiSnapshot;
      expect(json.workspace.basename).toBe(resolveWorkspace(ws.workspaceCwd).basename);
      expect(json.topics).toHaveLength(1);
      expect(json.topics[0]?.slug).toBe('ui-prod-topic');
      expect(json.topics[0]?.rounds).toHaveLength(2);
      expect(json.topics[0]?.rounds[1]?.mode).toBe('debug');
      expect(json.topics[0]?.rounds[1]?.verdict).toBe('ok');
    } finally {
      if (child && child.exitCode === null) child.kill('SIGINT');
      ws.cleanup();
    }
  });

  it('serves the split static UI assets', async () => {
    const ws = setupState();
    let child: ChildProcessWithoutNullStreams | null = null;
    try {
      child = spawn('bun', [HANDOFF, 'ui', '--port', '0', '--workspace', ws.workspaceCwd], {
        env: { ...process.env, AGENT_HANDOFF_STATE_DIR: ws.stateRoot },
      });
      const url = await waitForUrl(child);
      const index = await fetch(url);
      const indexText = await index.text();
      expect(index.status).toBe(200);
      expect(indexText).not.toContain('./fixture-data.js');
      expect(indexText).toContain('./dom-utils.js');
      expect(indexText).toContain('./interactions.js');
      expect(indexText).toContain('./app.js');
      expect(indexText).toContain('./vendor/marked.umd.js');
      expect(indexText).toContain('./vendor/highlight.min.js');

      for (const path of [
        'style.css',
        'vendor/highlight-github.min.css',
        'vendor/marked.umd.js',
        'vendor/highlight.min.js',
        'styles/base.css',
        'styles/layout-lists.css',
        'styles/timeline.css',
        'styles/inspector.css',
        'styles/responsive.css',
        'dom-utils.js',
        'interactions.js',
        'app.js',
      ]) {
        const response = await fetch(`${url}${path}`);
        expect(response.status).toBe(200);
      }
    } finally {
      if (child && child.exitCode === null) child.kill('SIGINT');
      ws.cleanup();
    }
  });

  it('can aggregate topics across all workspace buckets', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'agent-handoff-ui-all-state-'));
    const workspaceA = mkdtempSync(join(tmpdir(), 'agent-handoff-ui-all-a-'));
    const workspaceB = mkdtempSync(join(tmpdir(), 'agent-handoff-ui-all-b-'));
    let child: ChildProcessWithoutNullStreams | null = null;
    try {
      writeTopic(stateRoot, workspaceA, 'ui-prod-alpha');
      writeTopic(stateRoot, workspaceB, 'ui-prod-beta');
      child = spawn(
        'bun',
        [HANDOFF, 'ui', '--port', '0', '--all-workspaces', '--workspace', workspaceA],
        { env: { ...process.env, AGENT_HANDOFF_STATE_DIR: stateRoot } }
      );
      const url = await waitForUrl(child);
      const response = await fetch(`${url}api/snapshot`);
      expect(response.status).toBe(200);
      type UiSnapshot = {
        workspace: { scope: string; workspaces: Array<{ dirName: string }> };
        topics: Array<{ key: string; slug: string; workspace: { dirName: string } }>;
      };
      const json = (await response.json()) as UiSnapshot;
      expect(json.workspace.scope).toBe('all');
      expect(json.workspace.workspaces).toHaveLength(2);
      expect(json.topics.map((topic) => topic.slug).sort()).toEqual([
        'ui-prod-alpha',
        'ui-prod-beta',
      ]);
      expect(new Set(json.topics.map((topic) => topic.workspace.dirName)).size).toBe(2);
      expect(json.topics.every((topic) => topic.key.includes('/'))).toBe(true);
    } finally {
      if (child && child.exitCode === null) child.kill('SIGINT');
      rmSync(stateRoot, { recursive: true, force: true });
      rmSync(workspaceA, { recursive: true, force: true });
      rmSync(workspaceB, { recursive: true, force: true });
    }
  });

  it('allows the browser UI to request all projects without --all-workspaces', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'agent-handoff-ui-scope-state-'));
    const workspaceA = mkdtempSync(join(tmpdir(), 'agent-handoff-ui-scope-a-'));
    const workspaceB = mkdtempSync(join(tmpdir(), 'agent-handoff-ui-scope-b-'));
    let child: ChildProcessWithoutNullStreams | null = null;
    try {
      writeTopic(stateRoot, workspaceA, 'ui-scope-alpha');
      writeTopic(stateRoot, workspaceB, 'ui-scope-beta');
      child = spawn(
        'bun',
        [HANDOFF, 'ui', '--port', '0', '--workspace', workspaceA],
        { env: { ...process.env, AGENT_HANDOFF_STATE_DIR: stateRoot } }
      );
      const url = await waitForUrl(child);

      const currentResponse = await fetch(`${url}api/snapshot`);
      const current = (await currentResponse.json()) as {
        workspace: { scope: string };
        topics: Array<{ slug: string }>;
      };
      expect(current.workspace.scope).toBe('workspace');
      expect(current.topics.map((topic) => topic.slug)).toEqual(['ui-scope-alpha']);

      const allResponse = await fetch(`${url}api/snapshot?scope=all`);
      const all = (await allResponse.json()) as {
        workspace: { scope: string; workspaces: Array<{ dirName: string }> };
        topics: Array<{ slug: string }>;
      };
      expect(all.workspace.scope).toBe('all');
      expect(all.workspace.workspaces).toHaveLength(2);
      expect(all.topics.map((topic) => topic.slug).sort()).toEqual([
        'ui-scope-alpha',
        'ui-scope-beta',
      ]);
    } finally {
      if (child && child.exitCode === null) child.kill('SIGINT');
      rmSync(stateRoot, { recursive: true, force: true });
      rmSync(workspaceA, { recursive: true, force: true });
      rmSync(workspaceB, { recursive: true, force: true });
    }
  });

  it('refuses non-loopback UI hosts unless explicitly marked unsafe', () => {
    const ws = setupState();
    try {
      const result = spawnSync(
        'bun',
        [HANDOFF, 'ui', '--host', '0.0.0.0', '--port', '0', '--workspace', ws.workspaceCwd],
        { env: { ...process.env, AGENT_HANDOFF_STATE_DIR: ws.stateRoot }, encoding: 'utf-8' }
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Refusing to bind handoff UI to non-loopback host');
    } finally {
      ws.cleanup();
    }
  });
});
