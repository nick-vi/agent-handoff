#!/usr/bin/env bun
/**
 * Release guard: regenerate install-time runtime assets and fail if the
 * committed runtime tree is stale.
 */

import { spawnSync } from 'node:child_process';

run('bun', ['run', 'build']);

const diff = spawnSync('git', ['diff', '--exit-code', '--', 'runtime/'], {
  stdio: 'inherit',
});

if (diff.status !== 0) {
  console.error('\nruntime/ is stale. Run `bun run build` and commit the result.');
  process.exit(diff.status ?? 1);
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
