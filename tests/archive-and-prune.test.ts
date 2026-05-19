/**
 * Archive + prune behavior. Covers:
 *   - Archive on missing topic throws TopicNotFoundError
 *   - Archive timestamp format matches the prune regex
 *   - Same-topic rapid archives get a hex collision suffix
 *   - Prune actually removes archives now that timestamps parse
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  archiveTopic,
  createTopic,
  pruneArchives,
  TopicNotFoundError,
} from '../lib/registry.ts';
import type { WorkspaceInfo } from '../lib/workspace.ts';

let stateRoot: string;
let originalStateDir: string | undefined;

function makeWs(): WorkspaceInfo {
  return {
    resolvedRoot: '/tmp/archive-test',
    basename: 'archtest',
    hash: 'archive99999',
    dirName: 'archtest-archive99999',
    fromGit: false,
    aliased: false,
    gitProbe: 'not-a-repo',
  };
}

describe('archiveTopic + pruneArchives', () => {
  beforeAll(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'agent-handoff-archive-test-'));
    originalStateDir = process.env.AGENT_HANDOFF_STATE_DIR;
    process.env.AGENT_HANDOFF_STATE_DIR = stateRoot;
  });

  afterAll(() => {
    if (originalStateDir === undefined) delete process.env.AGENT_HANDOFF_STATE_DIR;
    else process.env.AGENT_HANDOFF_STATE_DIR = originalStateDir;
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it('throws TopicNotFoundError when archiving a topic that does not exist', async () => {
    const ws = makeWs();
    await expect(archiveTopic(ws, 'never-existed-topic', 'manual')).rejects.toBeInstanceOf(
      TopicNotFoundError
    );
  });

  it('produces timestamp matching prune regex /^\\d{8}T\\d{6}Z(?:-[0-9a-f]{4})?$/', async () => {
    const ws = makeWs();
    await createTopic({
      workspace: ws,
      topic: 'topic-to-archive',
      agent: 'codex',
      mode: 'consult',
      summary: null,
      initialSessionId: null,
    });
    const result = await archiveTopic(ws, 'topic-to-archive', 'manual');
    const filename = result.archivedSnapshot.split('/').pop()!;
    // Filename: `topic-to-archive--YYYYMMDDTHHMMSSZ.json`
    expect(filename).toMatch(
      /^topic-to-archive--\d{8}T\d{6}Z(?:-[0-9a-f]{4})?\.json$/
    );
  });

  it('handles same-second collision with hex suffix', async () => {
    const ws = makeWs();
    // Force two archives in the same wall-clock second by archiving →
    // recreating → archiving back-to-back.
    for (let i = 0; i < 3; i++) {
      await createTopic({
        workspace: ws,
        topic: 'collision-topic',
        agent: 'codex',
        mode: 'consult',
        summary: null,
        initialSessionId: null,
      });
      await archiveTopic(ws, 'collision-topic', 'archive_and_new');
    }
    const archDir = join(stateRoot, 'sessions', ws.dirName, 'archive');
    const archives = readdirSync(archDir).filter(
      (n) => n.startsWith('collision-topic--') && n.endsWith('.json')
    );
    // All 3 archives must coexist; if we'd reused the same path one would
    // have overwritten the other.
    expect(archives.length).toBe(3);
    // Each archive name must satisfy the prune regex.
    for (const name of archives) {
      expect(name).toMatch(
        /^collision-topic--\d{8}T\d{6}Z(?:-[0-9a-f]{4})?\.json$/
      );
    }
  });

  it('prune removes archives older than the keep-days threshold', async () => {
    const ws = makeWs();
    const archDir = join(stateRoot, 'sessions', ws.dirName, 'archive');
    // Plant a synthetic old archive directly. Date 1971 is well past 90d.
    const fs = require('node:fs') as typeof import('node:fs');
    const oldName = 'planted-old--19710101T000000Z.json';
    const oldHist = 'planted-old--19710101T000000Z.history.jsonl';
    if (!existsSync(archDir)) fs.mkdirSync(archDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(archDir, oldName), '{"schema_version":1}', 'utf-8');
    fs.writeFileSync(join(archDir, oldHist), '', 'utf-8');

    const result = pruneArchives(ws, { keepDays: 90, keepCount: 100 });
    expect(result.removed.length).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(archDir, oldName))).toBe(false);
    expect(existsSync(join(archDir, oldHist))).toBe(false);
  });
});
