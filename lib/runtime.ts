import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function runtimeRepoRoot(importMetaUrl: string): string {
  const here = dirname(fileURLToPath(importMetaUrl));
  if (here.endsWith('/bin') || here.endsWith('/runtime') || here.endsWith('/lib')) {
    return resolve(here, '..');
  }
  return here;
}
