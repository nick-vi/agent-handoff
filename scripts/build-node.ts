#!/usr/bin/env bun
/**
 * Build the Node-runtime bundle.
 *
 * Bun is the fast path; a prebuilt Node bundle is the fallback for users
 * who don't have Bun installed. The shim at bin/agent-handoff picks bun when
 * available, otherwise execs `node runtime/cli.js`.
 *
 * The bundle is committed (skill-install symlink flows don't run a
 * build step), so this script must be rerun before publishing changes
 * that alter behavior.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const entry = resolve(repoRoot, 'bin/agent-handoff.ts');
const runtimeDir = resolve(repoRoot, 'runtime');
const outFile = resolve(runtimeDir, 'cli.js');
const sourceUi = resolve(repoRoot, 'ui', 'handoff-ui');
const runtimeUi = resolve(runtimeDir, 'ui');

mkdirSync(runtimeDir, { recursive: true });

const result = spawnSync(
  'bun',
  ['build', entry, '--target=node', '--outfile', outFile],
  { stdio: 'inherit' }
);
if (result.status !== 0) process.exit(result.status ?? 1);

const bundle = readFileSync(outFile, 'utf-8');
const rewritten = bundle.replace(/^#!.*\n/, '#!/usr/bin/env node\n');
writeFileSync(outFile, rewritten);
chmodSync(outFile, 0o755);

rmSync(runtimeUi, { recursive: true, force: true });
copyDirectory(sourceUi, runtimeUi, 'Missing source UI assets. Expected ui/handoff-ui.');

console.log(`built ${outFile}`);

function copyDirectory(source: string, target: string, missingMessage: string): void {
  if (!existsSync(source)) throw new Error(missingMessage);
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = resolve(source, entry.name);
    const targetPath = resolve(target, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, targetPath, missingMessage);
    else if (entry.isFile()) copyFileSync(sourcePath, targetPath);
  }
}
