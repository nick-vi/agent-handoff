import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { runtimeRepoRoot } from './runtime.ts';
import { resolveStateDir } from './state-dir.ts';
import type { WorkspaceInfo } from './workspace.ts';

export type UiServerOptions = {
  workspace: WorkspaceInfo;
  allWorkspaces: boolean;
  host: string;
  port: number;
  open: boolean;
  unsafeHost: boolean;
  noTranscripts: boolean;
  includeTranscripts: boolean;
  buildSnapshot: (options: {
    allWorkspaces?: boolean;
    includeTopicKey?: string;
    includeTranscripts?: boolean;
  }) => unknown;
};

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export async function startUiServer(options: UiServerOptions): Promise<number> {
  const loopbackHost = isLoopbackHost(options.host);
  if (!loopbackHost && !options.unsafeHost) {
    console.error(
      `Refusing to bind handoff UI to non-loopback host "${options.host}". ` +
        'Use --unsafe-host if you understand this exposes handoff state on the network.'
    );
    return 2;
  }
  if (options.noTranscripts && options.includeTranscripts) {
    console.error('Use either --no-transcripts or --include-transcripts, not both.');
    return 2;
  }
  const includeTranscripts = options.includeTranscripts
    || (!options.noTranscripts && loopbackHost);

  const repoRoot = runtimeRepoRoot(import.meta.url);
  const uiRoot = resolveUiRoot(repoRoot);
  if (!existsSync(join(uiRoot, 'index.html'))) {
    console.error(`UI assets not found at ${uiRoot}`);
    return 1;
  }

  const server = createServer((req, res) => {
    handleUiRequest(req, res, uiRoot, {
      allWorkspaces: options.allWorkspaces,
      includeTranscripts,
      buildSnapshot: options.buildSnapshot,
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(options.port, options.host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : options.port;
  const url = `http://${options.host}:${actualPort}/`;
  console.error(`[handoff] ui: ${url}`);
  console.error(
    options.allWorkspaces
      ? `[handoff] workspace: all workspaces under ${resolveStateDir()}`
      : `[handoff] workspace: ${options.workspace.resolvedRoot}`
  );
  if (!includeTranscripts) {
    console.error('[handoff] transcripts: disabled');
  }
  if (options.open) {
    spawnSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {
      stdio: 'ignore',
    });
  }

  await new Promise<void>((resolveStop) => {
    const stop = () => {
      server.close(() => resolveStop());
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

function resolveUiRoot(repoRoot: string): string {
  const runtimeUi = join(repoRoot, 'runtime', 'ui');
  if (existsSync(join(runtimeUi, 'index.html'))) return runtimeUi;
  return join(repoRoot, 'ui', 'handoff-ui');
}

function handleUiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  uiRoot: string,
  options: {
    allWorkspaces: boolean;
    includeTranscripts: boolean;
    buildSnapshot: UiServerOptions['buildSnapshot'];
  }
): void {
  const rawUrl = req.url ?? '/';
  const url = new URL(rawUrl, 'http://handoff.local');
  if (url.pathname === '/api/snapshot') {
    try {
      const requestedScope = url.searchParams.get('scope');
      const snapshotOptions: {
        allWorkspaces?: boolean;
        includeTopicKey?: string;
        includeTranscripts?: boolean;
      } = {
        allWorkspaces: requestedScope === 'all'
          ? true
          : requestedScope === 'workspace'
            ? false
            : options.allWorkspaces,
        includeTranscripts: options.includeTranscripts,
      };
      const includeTopicKey = url.searchParams.get('topic');
      if (includeTopicKey) snapshotOptions.includeTopicKey = includeTopicKey;
      writeJson(res, options.buildSnapshot(snapshotOptions));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  let rel: string;
  try {
    rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }
  const fullPath = resolve(uiRoot, rel);
  if (!fullPath.startsWith(`${uiRoot}/`) && fullPath !== uiRoot) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  try {
    const body = readFileSync(fullPath);
    res.writeHead(200, { 'content-type': contentType(fullPath) });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

function writeJson(res: ServerResponse, data: unknown): void {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function contentType(path: string): string {
  switch (extname(path)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.md':
      return 'text/markdown; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}
