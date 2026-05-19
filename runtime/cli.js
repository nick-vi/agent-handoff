#!/usr/bin/env node
// @bun

// bin/agent-handoff.ts
import { spawnSync as spawnSync5 } from "child_process";
import { existsSync as existsSync18, readFileSync as readFileSync13 } from "fs";

// lib/atomic-file.ts
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

class AtomicFile {
  path;
  constructor(path) {
    this.path = path;
  }
  read() {
    try {
      return readFileSync(this.path, "utf-8");
    } catch (error) {
      if (error.code === "ENOENT")
        return null;
      throw error;
    }
  }
  readJson() {
    const content = this.read();
    if (content === null)
      return null;
    return JSON.parse(content);
  }
  write(content) {
    const dir = dirname(this.path);
    if (!existsSync(dir))
      mkdirSync(dir, { recursive: true, mode: 448 });
    const tempPath = this.generateTempPath();
    writeFileSync(tempPath, content, { encoding: "utf-8", mode: 384 });
    try {
      renameSync(tempPath, this.path);
    } catch (error) {
      try {
        unlinkSync(tempPath);
      } catch {}
      throw error;
    }
  }
  writeJson(data, indent = 0) {
    const content = indent > 0 ? JSON.stringify(data, null, indent) : JSON.stringify(data);
    this.write(content);
  }
  exists() {
    return existsSync(this.path);
  }
  delete() {
    try {
      unlinkSync(this.path);
      return true;
    } catch (error) {
      if (error.code === "ENOENT")
        return false;
      throw error;
    }
  }
  get filePath() {
    return this.path;
  }
  generateTempPath() {
    return join(dirname(this.path), `.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  }
}

// lib/state-dir.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2 } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
var APP_NAME = "agent-handoff";
function resolveStateDir() {
  const override = process.env.AGENT_HANDOFF_STATE_DIR;
  if (override && override.length > 0)
    return override;
  const xdgDataHome = process.env.XDG_DATA_HOME;
  if (xdgDataHome && xdgDataHome.length > 0) {
    return join2(xdgDataHome, APP_NAME);
  }
  return join2(homedir(), ".local", "share", APP_NAME);
}
function ensureStateDir() {
  const dir = resolveStateDir();
  if (!existsSync2(dir)) {
    mkdirSync2(dir, { recursive: true, mode: 448 });
  }
  return dir;
}

// lib/aliases.ts
import { existsSync as existsSync3, readdirSync, readFileSync as readFileSync2, statSync } from "node:fs";
import { join as join3 } from "node:path";
var FILENAME = "aliases.json";
function aliasFilePath() {
  return join3(ensureStateDir(), FILENAME);
}
function load() {
  const file = new AtomicFile(aliasFilePath());
  const raw = file.readJson();
  if (raw && raw.schema_version === 1 && raw.aliases)
    return raw;
  return { schema_version: 1, aliases: {} };
}
function save(data) {
  new AtomicFile(aliasFilePath()).writeJson(data, 2);
}
function setAlias(resolvedRoot, hash) {
  const file = load();
  file.aliases[resolvedRoot] = hash;
  save(file);
}
function removeAlias(resolvedRoot) {
  const file = load();
  if (!(resolvedRoot in file.aliases))
    return false;
  delete file.aliases[resolvedRoot];
  save(file);
  return true;
}
function listAliases() {
  return { ...load().aliases };
}
function suggestMovedWorkspaces() {
  const sessionsDir = join3(ensureStateDir(), "sessions");
  if (!existsSync3(sessionsDir))
    return [];
  const out = [];
  for (const dirName of readdirSync(sessionsDir)) {
    const dirPath = join3(sessionsDir, dirName);
    let stat;
    try {
      stat = statSync(dirPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory())
      continue;
    const entries = readdirSync(dirPath);
    const snapshotName = entries.find((n) => n.endsWith(".json") && !n.endsWith(".history.jsonl"));
    if (!snapshotName)
      continue;
    let snap = null;
    try {
      snap = JSON.parse(readFileSync2(join3(dirPath, snapshotName), "utf-8"));
    } catch {
      continue;
    }
    const recordedRoot = snap?.workspace?.resolvedRoot;
    if (!recordedRoot)
      continue;
    if (existsSync3(recordedRoot))
      continue;
    const topicCount = entries.filter((n) => n.endsWith(".json") && !n.endsWith(".history.jsonl")).length;
    const hash = dirName.slice(-12);
    out.push({
      hash,
      dirName,
      recordedRoot,
      lastUsedAt: snap?.last_used_at ?? null,
      topicCount
    });
  }
  return out.sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""));
}

// lib/agents/claude.ts
import { spawn } from "node:child_process";

// lib/agents/base.ts
function defaultVerdictFromExitCode(code) {
  if (code === 0)
    return "advisory";
  if (code === null)
    return "error";
  return "error";
}
var EMPTY_OUTPUT_MAX_CHARS = 16;
function outputLooksEmpty(output) {
  return output.trim().length < EMPTY_OUTPUT_MAX_CHARS;
}
function resolveVerdict(stdout, exitCode, bodyVerdict) {
  if (bodyVerdict)
    return bodyVerdict;
  if (exitCode === 0 && outputLooksEmpty(stdout))
    return "error";
  return defaultVerdictFromExitCode(exitCode);
}
var VERDICT_LINE = /^[\s\-*]*Verdict[:\s]+\s*(ok|advisory|blocked|error)\b/im;
function matchVerdictLine(stdout) {
  const m = VERDICT_LINE.exec(stdout);
  if (m && m[1])
    return m[1].toLowerCase();
  return null;
}

// lib/session-id.ts
var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidSessionId(_agent, sessionId) {
  return UUID_PATTERN.test(sessionId);
}
function sanitizeSessionId(agent, sessionId) {
  if (sessionId === null || sessionId === undefined)
    return sessionId;
  if (isValidSessionId(agent, sessionId))
    return sessionId;
  throw new Error(`Invalid ${agent} session id: ${sessionId}`);
}

// lib/agents/claude.ts
var SUPPORTED_MODES = [
  "consult",
  "audit",
  "review",
  "debug",
  "execute"
];
var claude = {
  name: "claude",
  supportsResume: true,
  supportedModes: SUPPORTED_MODES,
  async invoke(req) {
    const args = buildClaudeArgs(req.sessionId, req.prompt);
    const t0 = Date.now();
    const result = await spawnClaude(args, req.workspaceRoot, req.onSpawn, req.env);
    const durationMs = Date.now() - t0;
    const parsed = tryParseJsonResult(result.stdout);
    if (parsed) {
      const denialCount = Array.isArray(parsed.permission_denials) ? parsed.permission_denials.length : 0;
      const body = parsed.result ?? "";
      const output2 = denialCount > 0 ? `[handoff] claude reported ${denialCount} permission denial${denialCount === 1 ? "" : "s"}

${body}` : body;
      const verdict = parsed.is_error === true || denialCount > 0 ? "error" : resolveVerdict(body, result.code, matchVerdictLine(body));
      return {
        output: output2,
        sessionId: typeof parsed.session_id === "string" ? sanitizeSessionId("claude", parsed.session_id) : undefined,
        verdict,
        durationMs
      };
    }
    const output = result.stdout.trim() ? result.stdout : result.stderr.trim() ? result.stderr : "Claude did not return a JSON result envelope.";
    return {
      output,
      sessionId: undefined,
      verdict: "error",
      durationMs
    };
  }
};
function buildClaudeArgs(sessionId, prompt) {
  const args = ["--print", "--dangerously-skip-permissions", "--output-format", "json"];
  if (sessionId) {
    args.push("--resume", sessionId);
  }
  args.push(prompt);
  return args;
}
function tryParseJsonResult(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{"))
    return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null)
      return null;
    return parsed;
  } catch {
    return null;
  }
}
function spawnClaude(args, cwd, onSpawn, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (onSpawn && typeof child.pid === "number")
      onSpawn(child.pid);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => {
      stdout += String(c);
    });
    child.stderr?.on("data", (c) => {
      stderr += String(c);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

// lib/agents/codex.ts
import { spawn as spawn2 } from "node:child_process";
var SUPPORTED_MODES2 = ["review", "audit", "debug", "consult", "execute"];
var SESSION_ID_PATTERN = /\b([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
var codex = {
  name: "codex",
  supportsResume: true,
  supportedModes: SUPPORTED_MODES2,
  async invoke(req) {
    const args = buildCodexArgs(req.sessionId, req.prompt);
    const t0 = Date.now();
    const result = await spawnCodex(args, req.workspaceRoot, req.onSpawn, req.env);
    const durationMs = Date.now() - t0;
    const extracted = extractSessionId(`${result.stdout}
${result.stderr}`);
    return {
      output: result.stdout,
      sessionId: extracted ? sanitizeSessionId("codex", extracted) : undefined,
      verdict: resolveVerdict(result.stdout, result.code, matchVerdictLine(result.stdout)),
      durationMs
    };
  }
};
function buildCodexArgs(sessionId, prompt) {
  const args = ["exec"];
  if (sessionId) {
    args.push("resume", sessionId);
  }
  args.push("--full-auto");
  args.push(prompt);
  return args;
}
function spawnCodex(args, cwd, onSpawn, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn2("codex", args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (onSpawn && typeof child.pid === "number")
      onSpawn(child.pid);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}
function extractSessionId(stdout) {
  let last = null;
  let match;
  const re = new RegExp(SESSION_ID_PATTERN, "gi");
  while ((match = re.exec(stdout)) !== null) {
    last = match[1] ?? null;
  }
  return last;
}

// lib/agents/cursor.ts
import { spawn as spawn3 } from "node:child_process";
var SUPPORTED_MODES3 = [
  "execute",
  "audit",
  "consult",
  "review",
  "debug"
];
var MODEL_DEFAULT = "composer-2-fast";
var cursor = {
  name: "cursor",
  supportsResume: true,
  supportedModes: SUPPORTED_MODES3,
  async invoke(req) {
    const args = buildArgs(req.mode, req.workspaceRoot, req.prompt, req.sessionId);
    const t0 = Date.now();
    const result = await spawnCursor(args, req.workspaceRoot, req.onSpawn, req.env);
    const durationMs = Date.now() - t0;
    const extracted = extractSessionId2(result.stdout);
    return {
      output: result.stdout,
      sessionId: extracted ? sanitizeSessionId("cursor", extracted) : undefined,
      verdict: extractVerdict(result.stdout, result.code),
      durationMs
    };
  }
};
function buildArgs(mode, workspace, prompt, sessionId) {
  const args = ["--print", "--output-format", "json", "--trust", "--workspace", workspace];
  args.push("--model", MODEL_DEFAULT);
  args.push("--yolo");
  if (sessionId)
    args.push("--resume", sessionId);
  args.push(prompt);
  return args;
}
function spawnCursor(args, cwd, onSpawn, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn3("cursor-agent", args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (onSpawn && typeof child.pid === "number")
      onSpawn(child.pid);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => {
      stdout += String(c);
    });
    child.stderr?.on("data", (c) => {
      stderr += String(c);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}
function extractSessionId2(stdout) {
  const lines = stdout.split(`
`);
  for (let i = lines.length - 1;i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || !line.startsWith("{"))
      continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.session_id === "string" && parsed.session_id) {
        return parsed.session_id;
      }
    } catch {}
  }
  return null;
}
function extractVerdict(stdout, exitCode) {
  return resolveVerdict(stdout, exitCode, matchVerdictLine(stdout));
}

// lib/agents/index.ts
var AGENTS = {
  claude,
  codex,
  cursor
};

class UnknownAgentError extends Error {
  raw;
  constructor(raw) {
    super(`Unknown agent "${raw}". Supported: ${Object.keys(AGENTS).join(", ")}.`);
    this.raw = raw;
    this.name = "UnknownAgentError";
  }
}
function resolveAgent(raw) {
  if (raw === "claude" || raw === "codex" || raw === "cursor") {
    return AGENTS[raw];
  }
  throw new UnknownAgentError(raw);
}

// lib/registry.ts
import { existsSync as existsSync6, mkdirSync as mkdirSync5, readdirSync as readdirSync2, readFileSync as readFileSync5, renameSync as renameSync2, rmSync as rmSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname4, join as join5 } from "node:path";

// lib/event-log.ts
import { appendFileSync, closeSync, existsSync as existsSync4, mkdirSync as mkdirSync3, openSync, readFileSync as readFileSync3 } from "node:fs";
import { dirname as dirname2 } from "node:path";

class EventLog {
  fd = null;
  path;
  constructor(path) {
    this.path = path;
  }
  append(event) {
    const fd = this.openWrite();
    appendFileSync(fd, `${JSON.stringify(event)}
`);
  }
  read() {
    if (!existsSync4(this.path))
      return [];
    const content = readFileSync3(this.path, "utf-8");
    const lines = content.split(`
`);
    const out = [];
    for (const line of lines) {
      if (!line)
        continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  }
  close() {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {}
      this.fd = null;
    }
  }
  get filePath() {
    return this.path;
  }
  openWrite() {
    if (this.fd !== null)
      return this.fd;
    const dir = dirname2(this.path);
    if (!existsSync4(dir))
      mkdirSync3(dir, { recursive: true, mode: 448 });
    this.fd = openSync(this.path, "a", 384);
    return this.fd;
  }
}

// lib/lifecycle.ts
var STALE_DAYS = 30;
var RESUME_CONFIRM_DAYS = 7;
var STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;
var RESUME_CONFIRM_MS = RESUME_CONFIRM_DAYS * 24 * 60 * 60 * 1000;
function classify(snapshot) {
  const lastUsedMs = Date.parse(snapshot.last_used_at);
  if (!Number.isFinite(lastUsedMs))
    return "active";
  const ageMs = Date.now() - lastUsedMs;
  return ageMs > STALE_MS ? "stale" : "active";
}
var AUTO_RESUME_MODES = new Set(["consult", "debug"]);

// lib/lock.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync4, readFileSync as readFileSync4, rmSync, statSync as statSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { hostname } from "node:os";
import { dirname as dirname3, join as join4 } from "node:path";

class LockTimeoutError extends Error {
  topic;
  heldBy;
  constructor(topic, heldBy) {
    const holder = heldBy ? `pid ${heldBy.pid} on ${heldBy.hostname} (${heldBy.agent})` : "unknown";
    super(`Could not acquire lock for topic "${topic}"; held by ${holder}`);
    this.topic = topic;
    this.heldBy = heldBy;
    this.name = "LockTimeoutError";
  }
}
var STALE_THRESHOLD_MS = 30000;
var ACQUIRE_RETRIES = 600;
var RETRY_DELAY_BASE_MS = 50;
var RETRY_DELAY_JITTER_MS = 50;
async function withLock(workspaceDir, topic, agent, fn) {
  const lockDir = join4(workspaceDir, `${topic}.lock`);
  await acquire(lockDir, topic, agent);
  try {
    return await fn();
  } finally {
    release(lockDir);
  }
}
async function acquire(lockDir, topic, agent) {
  const parent = dirname3(lockDir);
  if (!existsSync5(parent))
    mkdirSync4(parent, { recursive: true, mode: 448 });
  for (let attempt = 0;attempt < ACQUIRE_RETRIES; attempt++) {
    try {
      mkdirSync4(lockDir, { recursive: false, mode: 448 });
      writeInfoFile(lockDir, topic, agent);
      return;
    } catch (err) {
      if (err.code !== "EEXIST")
        throw err;
      if (isStaleAndCleared(lockDir)) {
        continue;
      }
      const delay = RETRY_DELAY_BASE_MS + Math.floor(Math.random() * RETRY_DELAY_JITTER_MS);
      await sleep(delay);
    }
  }
  throw new LockTimeoutError(topic, readInfoFile(lockDir));
}
function release(lockDir) {
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {}
}
function isStaleAndCleared(lockDir) {
  let info = null;
  try {
    info = readInfoFile(lockDir);
  } catch {
    info = null;
  }
  let ageMs = 0;
  try {
    const st = statSync2(lockDir);
    ageMs = Date.now() - st.mtimeMs;
  } catch {
    return true;
  }
  if (info && info.hostname === hostname()) {
    if (isPidAlive(info.pid))
      return false;
  }
  if (ageMs < STALE_THRESHOLD_MS)
    return false;
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {}
  return true;
}
function writeInfoFile(lockDir, topic, agent) {
  const info = {
    pid: process.pid,
    hostname: hostname(),
    agent,
    topic,
    acquiredAt: new Date().toISOString()
  };
  writeFileSync2(join4(lockDir, "info.json"), JSON.stringify(info, null, 2), "utf-8");
}
function readInfoFile(lockDir) {
  const path = join4(lockDir, "info.json");
  if (!existsSync5(path))
    return null;
  try {
    return JSON.parse(readFileSync4(path, "utf-8"));
  } catch {
    return null;
  }
}
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = err.code;
    if (code === "ESRCH")
      return false;
    return true;
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// lib/schema/v1.ts
var SCHEMA_VERSION = 1;

// lib/schema/migrate.ts
function migrateSnapshot(raw) {
  const obj = raw ?? {};
  const v = obj.schema_version;
  if (v === undefined) {
    throw new Error("Snapshot is missing schema_version.");
  }
  if (v === SCHEMA_VERSION)
    return raw;
  throw new Error(`Unknown snapshot schema_version ${v}; latest is ${SCHEMA_VERSION}. Was this file written by a newer agent-handoff?`);
}
function migrateEvent(raw) {
  const obj = raw ?? {};
  const v = obj.schema_version;
  if (v === undefined) {
    throw new Error("Event is missing schema_version.");
  }
  if (v === SCHEMA_VERSION)
    return raw;
  throw new Error(`Unknown event schema_version ${v}; latest is ${SCHEMA_VERSION}.`);
}

// lib/slug.ts
var SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{6,62}[a-z0-9])$/;
var CONSECUTIVE_DASHES = /--/;
var RESERVED = new Set([
  "wip",
  "tmp",
  "test",
  "misc",
  "todo",
  "foo",
  "bar",
  "baz",
  "con",
  "prn",
  "aux",
  "nul",
  "conin",
  "conout",
  "clock",
  "archive",
  "history",
  "lock",
  "sessions",
  "state"
]);
var RESERVED_PATTERNS = [/^com[1-9]$/, /^lpt[1-9]$/];

class TopicSlugError extends Error {
  slug;
  reason;
  constructor(slug, reason) {
    super(`Invalid topic slug "${slug}": ${reason}`);
    this.slug = slug;
    this.reason = reason;
    this.name = "TopicSlugError";
  }
}
function validateTopic(slug) {
  if (typeof slug !== "string") {
    throw new TopicSlugError(String(slug), "must be a string");
  }
  if (slug.length < 8) {
    throw new TopicSlugError(slug, "minimum 8 chars (avoids accidental short names)");
  }
  if (slug.length > 64) {
    throw new TopicSlugError(slug, "maximum 64 chars (filesystem-friendly)");
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new TopicSlugError(slug, "must match /^[a-z0-9](?:[a-z0-9-]{6,62}[a-z0-9])$/ (lowercase ASCII, dashes ok, no leading/trailing dash)");
  }
  if (CONSECUTIVE_DASHES.test(slug)) {
    throw new TopicSlugError(slug, "no consecutive dashes (reserved as collision-suffix delimiter)");
  }
  if (RESERVED.has(slug)) {
    throw new TopicSlugError(slug, "reserved name (collides with filesystem or skill internals)");
  }
  for (const pattern of RESERVED_PATTERNS) {
    if (pattern.test(slug)) {
      throw new TopicSlugError(slug, `reserved pattern ${pattern} (Windows device name)`);
    }
  }
}

// lib/registry.ts
var ARCHIVE_DIRNAME = "archive";
function workspaceDir(ws) {
  return join5(ensureStateDir(), "sessions", ws.dirName);
}
function snapshotPath(ws, topic) {
  return join5(workspaceDir(ws), `${topic}.json`);
}
function historyPath(ws, topic) {
  return join5(workspaceDir(ws), `${topic}.history.jsonl`);
}
function archiveDir(ws) {
  return join5(workspaceDir(ws), ARCHIVE_DIRNAME);
}
function loadSnapshot(ws, topic) {
  validateTopic(topic);
  const file = new AtomicFile(snapshotPath(ws, topic));
  const raw = file.readJson();
  if (raw === null)
    return null;
  return migrateSnapshot(raw);
}
function readHistory(ws, topic) {
  validateTopic(topic);
  const log = new EventLog(historyPath(ws, topic));
  return log.read().map(migrateEvent);
}
function listTopics(ws) {
  const dir = workspaceDir(ws);
  if (!existsSync6(dir))
    return [];
  const entries = readdirSync2(dir);
  const topics = [];
  for (const name of entries) {
    if (!name.endsWith(".json"))
      continue;
    if (name.endsWith(".history.jsonl"))
      continue;
    if (name.startsWith("."))
      continue;
    topics.push(name.slice(0, -".json".length));
  }
  return topics.sort();
}
function listTopicSummaries(ws) {
  const slugs = listTopics(ws);
  const out = [];
  for (const topic of slugs) {
    const snap = loadSnapshot(ws, topic);
    if (!snap)
      continue;
    out.push({
      topic,
      summary: snap.summary,
      lifecycle: classify(snap),
      roundCount: snap.round_count,
      lastUsedAt: snap.last_used_at,
      sessions: snap.sessions
    });
  }
  out.sort((a, b) => {
    if (a.lifecycle !== b.lifecycle) {
      return a.lifecycle === "active" ? -1 : 1;
    }
    return a.topic.localeCompare(b.topic);
  });
  return out;
}
function getActiveTopics(ws) {
  return listTopicSummaries(ws).filter((t) => t.lifecycle === "active");
}
async function createTopic(opts) {
  validateTopic(opts.topic);
  return withLock(workspaceDir(opts.workspace), opts.topic, opts.agent, async () => {
    const file = new AtomicFile(snapshotPath(opts.workspace, opts.topic));
    if (file.exists()) {
      throw new TopicAlreadyExistsError(opts.topic);
    }
    const now = new Date().toISOString();
    const summary = opts.summary ?? autoSummary(opts.promptForAutoSummary);
    const initialSessionId = sanitizeSessionId(opts.agent, opts.initialSessionId) ?? null;
    const snap = {
      schema_version: SCHEMA_VERSION,
      topic: opts.topic,
      summary,
      workspace: {
        resolvedRoot: opts.workspace.resolvedRoot,
        basename: opts.workspace.basename,
        hash: opts.workspace.hash,
        fromGit: opts.workspace.fromGit
      },
      sessions: { [opts.agent]: initialSessionId },
      round_count: 1,
      created_at: now,
      last_used_at: now
    };
    file.writeJson(snap, 2);
    const log = new EventLog(historyPath(opts.workspace, opts.topic));
    log.append({
      schema_version: SCHEMA_VERSION,
      kind: "created",
      ts: now,
      agent: opts.agent,
      caller_agent: opts.callerAgent ?? null,
      mode: opts.mode,
      round: 1,
      session_id: initialSessionId,
      summary
    });
    log.close();
    return snap;
  });
}
function autoSummary(prompt) {
  if (!prompt)
    return null;
  const lines = prompt.split(`
`).map((s) => s.trim());
  for (const line of lines) {
    if (!line)
      continue;
    if (line.startsWith("#"))
      continue;
    if (line.startsWith("---"))
      continue;
    return line.length > 100 ? `${line.slice(0, 97)}...` : line;
  }
  return null;
}
async function recordInvocation(opts) {
  validateTopic(opts.topic);
  return withLock(workspaceDir(opts.workspace), opts.topic, opts.agent, async () => {
    const file = new AtomicFile(snapshotPath(opts.workspace, opts.topic));
    const raw = file.readJson();
    if (raw === null) {
      throw new TopicNotFoundError(opts.topic);
    }
    const snap = migrateSnapshot(raw);
    const now = new Date().toISOString();
    const nextRound = snap.round_count + 1;
    const sanitizedSessionId = sanitizeSessionId(opts.agent, opts.sessionId);
    const mergedSessionId = sanitizedSessionId === undefined ? snap.sessions[opts.agent] ?? null : sanitizedSessionId;
    const next = {
      ...snap,
      sessions: {
        ...snap.sessions,
        [opts.agent]: mergedSessionId
      },
      round_count: nextRound,
      last_used_at: now
    };
    file.writeJson(next, 2);
    const log = new EventLog(historyPath(opts.workspace, opts.topic));
    log.append({
      schema_version: SCHEMA_VERSION,
      kind: "invocation",
      ts: now,
      agent: opts.agent,
      caller_agent: opts.callerAgent ?? null,
      mode: opts.mode,
      round: nextRound,
      session_id: mergedSessionId,
      verdict: opts.verdict,
      duration_ms: opts.durationMs
    });
    log.close();
    return next;
  });
}
async function resetSession(ws, topic, agent, reason = "manual") {
  validateTopic(topic);
  return withLock(workspaceDir(ws), topic, agent, async () => {
    const file = new AtomicFile(snapshotPath(ws, topic));
    const raw = file.readJson();
    if (raw === null) {
      throw new TopicNotFoundError(topic);
    }
    const snap = migrateSnapshot(raw);
    const previousSessionId = snap.sessions[agent] ?? null;
    if (previousSessionId === null) {
      return { previousSessionId: null };
    }
    const next = {
      ...snap,
      sessions: { ...snap.sessions, [agent]: null },
      last_used_at: new Date().toISOString()
    };
    file.writeJson(next, 2);
    const log = new EventLog(historyPath(ws, topic));
    log.append({
      schema_version: SCHEMA_VERSION,
      kind: "session_reset",
      ts: new Date().toISOString(),
      agent,
      previous_session_id: previousSessionId,
      reason
    });
    log.close();
    return { previousSessionId };
  });
}
async function archiveTopic(ws, topic, reason) {
  validateTopic(topic);
  return withLock(workspaceDir(ws), topic, "cli", async () => {
    const liveSnap = snapshotPath(ws, topic);
    if (!existsSync6(liveSnap)) {
      throw new TopicNotFoundError(topic);
    }
    const isoMs = new Date().toISOString();
    const baseTs = isoMs.slice(0, 4) + isoMs.slice(5, 7) + isoMs.slice(8, 10) + "T" + isoMs.slice(11, 13) + isoMs.slice(14, 16) + isoMs.slice(17, 19) + "Z";
    const archDir = archiveDir(ws);
    if (!existsSync6(archDir))
      mkdirSync5(archDir, { recursive: true, mode: 448 });
    let ts = baseTs;
    let attempt = 0;
    while (existsSync6(join5(archDir, `${topic}--${ts}.json`))) {
      attempt++;
      const suffix = Math.floor(Math.random() * 65535).toString(16).padStart(4, "0");
      ts = `${baseTs}-${suffix}`;
      if (attempt > 8) {
        throw new Error(`archive collision unresolvable for ${topic} at ${baseTs}; tried ${attempt}`);
      }
    }
    const liveHist = historyPath(ws, topic);
    const archSnap = join5(archDir, `${topic}--${ts}.json`);
    const archHist = join5(archDir, `${topic}--${ts}.history.jsonl`);
    renameSync2(liveSnap, archSnap);
    if (existsSync6(liveHist))
      renameSync2(liveHist, archHist);
    const livePlan = join5(workspaceDir(ws), "plans", `${topic}.md`);
    const livePlanHistory = join5(workspaceDir(ws), "plans", `${topic}.history`);
    const archPlan = join5(archDir, `${topic}--${ts}.plan.md`);
    const archPlanHistory = join5(archDir, `${topic}--${ts}.plan.history`);
    let archivedPlan = null;
    let archivedPlanHistory = null;
    if (existsSync6(livePlan)) {
      renameSync2(livePlan, archPlan);
      archivedPlan = archPlan;
    }
    if (existsSync6(livePlanHistory)) {
      renameSync2(livePlanHistory, archPlanHistory);
      archivedPlanHistory = archPlanHistory;
    }
    const archLog = new EventLog(archHist);
    archLog.append({
      schema_version: SCHEMA_VERSION,
      kind: "archived",
      ts: new Date().toISOString(),
      reason
    });
    archLog.close();
    return {
      archivedSnapshot: archSnap,
      archivedHistory: archHist,
      archivedPlan,
      archivedPlanHistory,
      liveSnapshot: liveSnap,
      liveHistory: liveHist,
      livePlan,
      livePlanHistory
    };
  });
}
function restoreArchivedTopic(arch) {
  if (arch.archivedPlanHistory && existsSync6(arch.archivedPlanHistory)) {
    try {
      mkdirSync5(dirname4(arch.livePlanHistory), { recursive: true, mode: 448 });
      renameSync2(arch.archivedPlanHistory, arch.livePlanHistory);
    } catch (err) {
      console.error(`[handoff] restore: failed to move plan history back: ${err.message}`);
    }
  }
  if (arch.archivedPlan && existsSync6(arch.archivedPlan)) {
    try {
      mkdirSync5(dirname4(arch.livePlan), { recursive: true, mode: 448 });
      renameSync2(arch.archivedPlan, arch.livePlan);
    } catch (err) {
      console.error(`[handoff] restore: failed to move plan back: ${err.message}`);
    }
  }
  if (existsSync6(arch.archivedHistory)) {
    try {
      const raw = readFileSync5(arch.archivedHistory, "utf-8");
      const lines = raw.split(`
`).filter((l) => l.length > 0);
      let trimmed = raw;
      if (lines.length > 0) {
        try {
          const last = JSON.parse(lines[lines.length - 1] ?? "{}");
          if (last.kind === "archived") {
            trimmed = lines.slice(0, -1).join(`
`) + (lines.length > 1 ? `
` : "");
          }
        } catch {}
      }
      writeFileSync3(arch.archivedHistory, trimmed, { mode: 384 });
      renameSync2(arch.archivedHistory, arch.liveHistory);
    } catch (err) {
      console.error(`[handoff] restore: failed to move history back: ${err.message}`);
    }
  }
  if (existsSync6(arch.archivedSnapshot)) {
    try {
      renameSync2(arch.archivedSnapshot, arch.liveSnapshot);
    } catch (err) {
      console.error(`[handoff] restore: failed to move snapshot back: ${err.message}`);
    }
  }
}
function pruneArchives(ws, options = {}) {
  const keepCount = options.keepCount ?? 20;
  const keepDays = options.keepDays ?? 90;
  const ageThresholdMs = keepDays * 24 * 60 * 60 * 1000;
  const dir = archiveDir(ws);
  if (!existsSync6(dir))
    return { removed: [] };
  const entries = readdirSync2(dir).filter((n) => n.endsWith(".json") || n.endsWith(".history.jsonl"));
  const byTopic = new Map;
  for (const name of entries) {
    const match = /^(.*?)--(\d{8}T\d{6}Z)(?:-([0-9a-f]{4}))?(?:\.history)?\.json(l)?$/.exec(name);
    if (!match)
      continue;
    const [, topic, tsStr, hexSuffix] = match;
    const ts = parseTsCompact(tsStr ?? "") ?? 0;
    if (!topic)
      continue;
    const group = hexSuffix ? `${topic}--${tsStr}-${hexSuffix}` : `${topic}--${tsStr}`;
    if (!byTopic.has(topic))
      byTopic.set(topic, []);
    byTopic.get(topic).push({ name, ts, group });
  }
  const now = Date.now();
  const removed = [];
  for (const [, items] of byTopic) {
    items.sort((a, b) => b.ts - a.ts);
    const seenGroups = new Map;
    for (const item of items) {
      if (!seenGroups.has(item.group))
        seenGroups.set(item.group, []);
      seenGroups.get(item.group).push({ name: item.name, ts: item.ts });
    }
    let kept = 0;
    for (const [, group] of seenGroups) {
      const groupTs = group[0]?.ts ?? 0;
      const ageMs = now - groupTs;
      const tooOld = ageMs > ageThresholdMs;
      const overCount = kept >= keepCount;
      if (tooOld || overCount) {
        for (const f of group) {
          const fullPath = join5(dir, f.name);
          try {
            rmSync2(fullPath);
            removed.push(fullPath);
          } catch {}
        }
      } else {
        kept++;
      }
    }
  }
  return { removed };
}
async function trimActiveHistories(ws, keepLast) {
  if (!Number.isFinite(keepLast) || keepLast < 1) {
    throw new Error(`trimActiveHistories: keepLast must be ≥ 1, got ${keepLast}`);
  }
  const dir = workspaceDir(ws);
  if (!existsSync6(dir))
    return { trimmed: [] };
  const topics = readdirSync2(dir).filter((n) => n.endsWith(".history.jsonl")).map((n) => n.slice(0, -".history.jsonl".length));
  const trimmed = [];
  for (const topic of topics) {
    try {
      validateTopic(topic);
    } catch {
      continue;
    }
    await withLock(dir, topic, "cli", async () => {
      const path = historyPath(ws, topic);
      if (!existsSync6(path))
        return;
      const raw = readFileSync5(path, "utf-8");
      const lines = raw.split(`
`).filter((l) => l.length > 0);
      if (lines.length <= keepLast)
        return;
      const removed = lines.length - keepLast;
      const next = lines.slice(removed).join(`
`) + `
`;
      writeFileSync3(path, next, { mode: 384 });
      trimmed.push({ topic, removed, kept: keepLast });
    });
  }
  return { trimmed };
}
function parseTsCompact(ts) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(ts);
  if (!m)
    return null;
  const [, y, mo, d, h, mi, s] = m;
  const d2 = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  const t = d2.getTime();
  return Number.isFinite(t) ? t : null;
}

class TopicAlreadyExistsError extends Error {
  topic;
  constructor(topic) {
    super(`Topic "${topic}" already exists. Use --resume to continue, or --archive-and-new to start fresh.`);
    this.topic = topic;
    this.name = "TopicAlreadyExistsError";
  }
}

class TopicNotFoundError extends Error {
  topic;
  constructor(topic) {
    super(`Topic "${topic}" not found in this workspace.`);
    this.topic = topic;
    this.name = "TopicNotFoundError";
  }
}

// lib/lifecycle.ts
var STALE_DAYS2 = 30;
var RESUME_CONFIRM_DAYS2 = 7;
var STALE_MS2 = STALE_DAYS2 * 24 * 60 * 60 * 1000;
var RESUME_CONFIRM_MS2 = RESUME_CONFIRM_DAYS2 * 24 * 60 * 60 * 1000;
function requiresResumeConfirmation(snapshot, now = new Date) {
  const lastUsedMs = Date.parse(snapshot.last_used_at);
  if (!Number.isFinite(lastUsedMs))
    return false;
  return now.getTime() - lastUsedMs > RESUME_CONFIRM_MS2;
}
var AUTO_RESUME_MODES2 = new Set(["consult", "debug"]);
function shouldResumeAgentSession(mode, explicitResumeFlag) {
  return explicitResumeFlag || AUTO_RESUME_MODES2.has(mode);
}

// lib/pointer.ts
import { existsSync as existsSync7, mkdirSync as mkdirSync6, readFileSync as readFileSync6, writeFileSync as writeFileSync4 } from "node:fs";
import { dirname as dirname5, join as join6 } from "node:path";
var POINTER_DIR = ".handoff";
var POINTER_FILE = "current.json";
var GIT_EXCLUDE_FILE = ".git/info/exclude";
var GIT_EXCLUDE_LINE = ".handoff/";
function pointerPath(workspaceRoot) {
  return join6(workspaceRoot, POINTER_DIR, POINTER_FILE);
}
function readPointer(ws) {
  const file = new AtomicFile(pointerPath(ws.resolvedRoot));
  const raw = file.readJson();
  if (raw === null)
    return null;
  if (raw.workspace_hash !== ws.hash)
    return null;
  return raw;
}
function setPointer(ws, topic) {
  const path = pointerPath(ws.resolvedRoot);
  const dir = dirname5(path);
  if (!existsSync7(dir))
    mkdirSync6(dir, { recursive: true, mode: 448 });
  const pointer = {
    schema_version: 1,
    workspace_hash: ws.hash,
    current_topic: topic,
    set_at: new Date().toISOString()
  };
  new AtomicFile(path).writeJson(pointer, 2);
  if (ws.fromGit)
    ensureGitExcludeLine(ws.resolvedRoot);
}
function clearPointer(ws) {
  setPointer(ws, null);
}
function ensureGitExcludeLine(workspaceRoot) {
  const excludePath = join6(workspaceRoot, GIT_EXCLUDE_FILE);
  if (!existsSync7(excludePath)) {
    return;
  }
  const content = readFileSync6(excludePath, "utf-8");
  if (content.split(`
`).includes(GIT_EXCLUDE_LINE))
    return;
  const newContent = content.endsWith(`
`) ? `${content}${GIT_EXCLUDE_LINE}
` : `${content}
${GIT_EXCLUDE_LINE}
`;
  writeFileSync4(excludePath, newContent, "utf-8");
}

// lib/agents/cursor-sqlite.ts
import { spawnSync } from "node:child_process";
import { existsSync as existsSync8 } from "node:fs";
function readCursorChat(dbPath, options = {}) {
  const warnings = [];
  if (!existsSync8(dbPath)) {
    warnings.push(`store.db not found at ${dbPath}`);
    return { meta: {}, rootBlobId: null, turns: [], warnings };
  }
  if (!sqlite3Available()) {
    warnings.push("sqlite3 CLI not on PATH — install sqlite3 to read cursor chats");
    return { meta: {}, rootBlobId: null, turns: [], warnings };
  }
  const meta = readMeta(dbPath, warnings);
  const rootBlobId = meta.latestRootBlobId ?? null;
  if (!rootBlobId) {
    warnings.push("meta has no latestRootBlobId; chat may be empty or schema changed");
    return { meta, rootBlobId: null, turns: [], warnings };
  }
  if (options.sinceRootBlobId === rootBlobId) {
    return { meta, rootBlobId, turns: [], warnings };
  }
  const childIds = readRootChildren(dbPath, rootBlobId, warnings);
  const turns = [];
  for (const id of childIds) {
    const blobHex = readBlobHex(dbPath, id);
    if (!blobHex) {
      warnings.push(`blob ${id.slice(0, 12)}… not found (referenced by root)`);
      continue;
    }
    const turn = parseTurnBlob(id, blobHex, warnings);
    if (turn)
      turns.push(turn);
  }
  return { meta, rootBlobId, turns, warnings };
}
function sqlite3Available() {
  const r = spawnSync("sqlite3", ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
  return r.status === 0;
}
function validateRootBlobShape(hex) {
  return /^0a20[0-9a-f]{64}/i.test(hex);
}
function runSqlite(dbPath, sql) {
  const r = spawnSync("sqlite3", [dbPath, sql], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (r.status !== 0)
    return null;
  return r.stdout.trim();
}
function readMeta(dbPath, warnings) {
  const hexValue = runSqlite(dbPath, "SELECT value FROM meta WHERE key='0';");
  if (!hexValue) {
    warnings.push("meta key '0' not found in store.db");
    return {};
  }
  if (!/^[0-9a-f]+$/i.test(hexValue) || hexValue.length % 2 !== 0) {
    warnings.push(`meta value not hex (got ${hexValue.length} chars); schema drift`);
    return {};
  }
  let json;
  try {
    json = Buffer.from(hexValue, "hex").toString("utf-8");
  } catch (err) {
    warnings.push(`meta value hex-decode failed: ${err.message}`);
    return {};
  }
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) {
      warnings.push("meta json not an object");
      return {};
    }
    return parsed;
  } catch (err) {
    warnings.push(`meta json parse failed: ${err.message}`);
    return {};
  }
}
function readBlobHex(dbPath, blobId) {
  if (!/^[0-9a-f]{64}$/i.test(blobId))
    return null;
  const hex = runSqlite(dbPath, `SELECT hex(data) FROM blobs WHERE id='${blobId}';`);
  if (!hex)
    return null;
  return hex.toLowerCase();
}
function readRootChildren(dbPath, rootId, warnings) {
  const hex = readBlobHex(dbPath, rootId);
  if (!hex) {
    warnings.push(`root blob ${rootId.slice(0, 12)}… not found`);
    return [];
  }
  if (!validateRootBlobShape(hex)) {
    warnings.push(`root blob shape unexpected (does not start with 0A 20 …); cursor format drift?`);
    return [];
  }
  return extractField1BlobIds(hex);
}
function extractField1BlobIds(hex) {
  const ids = [];
  let i = 0;
  while (i + 4 + 64 <= hex.length) {
    const tag = hex.slice(i, i + 2);
    const len = hex.slice(i + 2, i + 4);
    if (tag !== "0a" || len !== "20")
      break;
    ids.push(hex.slice(i + 4, i + 4 + 64));
    i += 4 + 64;
  }
  return ids;
}
var KNOWN_ROLES = new Set(["system", "user", "assistant", "tool", "developer"]);
function parseTurnBlob(blobId, hex, warnings) {
  const utf8 = Buffer.from(hex, "hex").toString("utf-8");
  const trimmed = utf8.trim();
  if (trimmed.startsWith("{")) {
    return tryParse(blobId, trimmed, warnings);
  }
  const firstBrace = utf8.indexOf("{");
  if (firstBrace === -1) {
    return null;
  }
  return tryParse(blobId, utf8.slice(firstBrace), warnings);
}
function tryParse(blobId, json, warnings) {
  const balanced = extractBalancedJson(json);
  if (!balanced) {
    warnings.push(`blob ${blobId.slice(0, 12)}…: could not find balanced JSON object`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(balanced);
  } catch (err) {
    warnings.push(`blob ${blobId.slice(0, 12)}…: json parse failed (${err.message})`);
    return null;
  }
  const role = parsed.role;
  if (!role || typeof role !== "string") {
    return null;
  }
  if (!KNOWN_ROLES.has(role)) {
    warnings.push(`blob ${blobId.slice(0, 12)}…: unknown role "${role}" — added since this adapter shipped?`);
  }
  const text = stringifyContent(parsed.content);
  return { blobId, role, text, raw: parsed };
}
function extractBalancedJson(s) {
  if (s[0] !== "{")
    return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0;i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString)
      continue;
    if (ch === "{")
      depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0)
        return s.slice(0, i + 1);
    }
  }
  return null;
}
function stringifyContent(content) {
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return "";
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== "object")
      continue;
    const p = {
      ...part
    };
    if (typeof p.text === "string")
      parts.push(p.text);
    else if (p.type === "redacted-reasoning")
      parts.push("<redacted-reasoning>");
    else if (p.type === "tool_use" && p.name) {
      const args = toolArgsText(p.input ?? p.arguments);
      parts.push(`<tool: ${String(p.name)}>${args ? `
${args}` : ""}`);
    } else if (p.type === "tool_result") {
      const result = typeof p.content === "string" ? p.content : stringifyContent(p.content);
      parts.push(`<tool_result>${result ? `
${result}` : ""}`);
    } else if (p.type)
      parts.push(`<${p.type}>`);
  }
  return parts.join(" ").trim();
}
function toolArgsText(value) {
  if (value == null || value === "")
    return "";
  if (typeof value === "string")
    return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// lib/local-sessions.ts
import { existsSync as existsSync9, readdirSync as readdirSync3 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join7 } from "node:path";
function encodeClaudeWorkspace(workspaceRoot) {
  return workspaceRoot.replace(/[/.]/g, "-");
}
function resolveLocalSession(agent, sessionId, workspaceRoot) {
  if (!isValidSessionId(agent, sessionId)) {
    return { kind: "missing", reason: `invalid ${agent} session id shape` };
  }
  switch (agent) {
    case "claude":
      return resolveClaude(sessionId, workspaceRoot);
    case "codex":
      return resolveCodex(sessionId);
    case "cursor":
      return resolveCursor(sessionId);
  }
}
function resolveCursor(sessionId) {
  const root = join7(homedir2(), ".cursor", "chats");
  if (!existsSync9(root)) {
    return { kind: "missing", reason: "no ~/.cursor/chats directory" };
  }
  for (const ws of readdirSync3(root)) {
    const candidate = join7(root, ws, sessionId, "store.db");
    if (existsSync9(candidate))
      return { kind: "sqlite-cursor", path: candidate };
  }
  return {
    kind: "missing",
    reason: `no store.db under ~/.cursor/chats/*/${sessionId}/`
  };
}
function resolveClaude(sessionId, workspaceRoot) {
  const root = join7(homedir2(), ".claude", "projects");
  if (!existsSync9(root)) {
    return { kind: "missing", reason: `no ~/.claude/projects directory` };
  }
  const encoded = encodeClaudeWorkspace(workspaceRoot);
  const candidate = join7(root, encoded, `${sessionId}.jsonl`);
  if (existsSync9(candidate))
    return { kind: "file", path: candidate };
  for (const dir of readdirSync3(root)) {
    const path = join7(root, dir, `${sessionId}.jsonl`);
    if (existsSync9(path))
      return { kind: "file", path };
  }
  return {
    kind: "missing",
    reason: `no ${sessionId}.jsonl under ~/.claude/projects/* (workspace ${encoded})`
  };
}
function resolveCodex(sessionId) {
  const root = join7(homedir2(), ".codex", "sessions");
  if (!existsSync9(root)) {
    return { kind: "missing", reason: "no ~/.codex/sessions directory" };
  }
  const tail = `-${sessionId}.jsonl`;
  const years = readdirSync3(root).filter((n) => /^\d{4}$/.test(n)).sort().reverse();
  for (const y of years) {
    const months = readdirSync3(join7(root, y)).filter((n) => /^\d{2}$/.test(n)).sort().reverse();
    for (const m of months) {
      const days = readdirSync3(join7(root, y, m)).filter((n) => /^\d{2}$/.test(n)).sort().reverse();
      for (const d of days) {
        const dir = join7(root, y, m, d);
        for (const name of readdirSync3(dir)) {
          if (name.endsWith(tail))
            return { kind: "file", path: join7(dir, name) };
        }
      }
    }
  }
  return {
    kind: "missing",
    reason: `no rollout-*-${sessionId}.jsonl under ~/.codex/sessions`
  };
}

// lib/running.ts
import { existsSync as existsSync10, mkdirSync as mkdirSync7, readdirSync as readdirSync4, statSync as statSync3, unlinkSync as unlinkSync2 } from "node:fs";
import { join as join8 } from "node:path";
function runningDir(ws) {
  return join8(ensureStateDir(), "running", ws.dirName);
}
function runningPath(ws, topic, agent, runId) {
  return join8(runningDir(ws), `${topic}--${agent}--${safeRunIdSegment(runId)}.json`);
}
function safeRunIdSegment(runId) {
  return runId.replace(/[^A-Za-z0-9_.-]/g, "_");
}
function markRunning(ws, topic, agent, pid, opts = {}) {
  const dir = runningDir(ws);
  if (!existsSync10(dir))
    mkdirSync7(dir, { recursive: true, mode: 448 });
  const runId = opts.runId ?? `pid-${pid}`;
  const file = new AtomicFile(runningPath(ws, topic, agent, runId));
  file.writeJson({
    schema_version: 1,
    pid,
    topic,
    agent,
    ...opts.mode ? { mode: opts.mode } : {},
    run_id: runId,
    ...opts.parentRunId ? { parent_run_id: opts.parentRunId } : {},
    workspace_root: ws.resolvedRoot,
    started_at: new Date().toISOString()
  }, 2);
}
function clearRunning(ws, topic, agent, opts = {}) {
  if (opts.runId) {
    const path = runningPath(ws, topic, agent, opts.runId);
    try {
      if (existsSync10(path))
        unlinkSync2(path);
    } catch {}
    return;
  }
  const dir = runningDir(ws);
  if (!existsSync10(dir))
    return;
  for (const name of readdirSync4(dir)) {
    const path = join8(dir, name);
    try {
      if (!statSync3(path).isFile())
        continue;
      const raw = new AtomicFile(path).readJson();
      if (isRunningRecord(raw) && raw.topic === topic && raw.agent === agent) {
        unlinkSync2(path);
      }
    } catch {}
  }
}
function readRunning(ws, topic, agent, opts = {}) {
  const matches = listRunning(ws).filter((entry) => entry.topic === topic && entry.agent === agent && (!opts.runId || entry.run_id === opts.runId));
  return matches.length === 1 ? matches[0] : null;
}
function listRunning(ws) {
  const dir = runningDir(ws);
  if (!existsSync10(dir))
    return [];
  const out = [];
  for (const name of readdirSync4(dir)) {
    if (!name.endsWith(".json"))
      continue;
    const path = join8(dir, name);
    try {
      if (!statSync3(path).isFile())
        continue;
    } catch {
      continue;
    }
    const file = new AtomicFile(path);
    const raw = file.readJson();
    if (!isRunningRecord(raw))
      continue;
    if (!isAlive(raw.pid)) {
      try {
        unlinkSync2(path);
      } catch {}
      continue;
    }
    out.push(raw);
  }
  return out.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
}
function cancelRunning(ws, topic, agent, signal = "SIGINT", opts = {}) {
  const entry = readRunning(ws, topic, agent, opts);
  if (!entry)
    return { delivered: false, pid: null, runId: null };
  if (!isAlive(entry.pid)) {
    clearRunning(ws, topic, agent, { runId: entry.run_id });
    return { delivered: false, pid: entry.pid, runId: entry.run_id };
  }
  try {
    process.kill(entry.pid, signal);
    return { delivered: true, pid: entry.pid, runId: entry.run_id };
  } catch {
    clearRunning(ws, topic, agent, { runId: entry.run_id });
    return { delivered: false, pid: entry.pid, runId: entry.run_id };
  }
}
function isRunningRecord(raw) {
  return Boolean(raw && raw.schema_version === 1 && typeof raw.pid === "number" && typeof raw.topic === "string" && isAgentName(raw.agent) && typeof raw.run_id === "string" && typeof raw.workspace_root === "string" && typeof raw.started_at === "string");
}
function isAgentName(value) {
  return value === "claude" || value === "codex" || value === "cursor";
}
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// lib/state-dir.ts
import { homedir as homedir3 } from "node:os";
import { join as join9 } from "node:path";
var APP_NAME2 = "agent-handoff";
function resolveStateDir2() {
  const override = process.env.AGENT_HANDOFF_STATE_DIR;
  if (override && override.length > 0)
    return override;
  const xdgDataHome = process.env.XDG_DATA_HOME;
  if (xdgDataHome && xdgDataHome.length > 0) {
    return join9(xdgDataHome, APP_NAME2);
  }
  return join9(homedir3(), ".local", "share", APP_NAME2);
}

// lib/slug.ts
var SLUG_PATTERN2 = /^[a-z0-9](?:[a-z0-9-]{6,62}[a-z0-9])$/;
var CONSECUTIVE_DASHES2 = /--/;
var RESERVED2 = new Set([
  "wip",
  "tmp",
  "test",
  "misc",
  "todo",
  "foo",
  "bar",
  "baz",
  "con",
  "prn",
  "aux",
  "nul",
  "conin",
  "conout",
  "clock",
  "archive",
  "history",
  "lock",
  "sessions",
  "state"
]);
var RESERVED_PATTERNS2 = [/^com[1-9]$/, /^lpt[1-9]$/];

class TopicSlugError2 extends Error {
  slug;
  reason;
  constructor(slug, reason) {
    super(`Invalid topic slug "${slug}": ${reason}`);
    this.slug = slug;
    this.reason = reason;
    this.name = "TopicSlugError";
  }
}
function validateTopic2(slug) {
  if (typeof slug !== "string") {
    throw new TopicSlugError2(String(slug), "must be a string");
  }
  if (slug.length < 8) {
    throw new TopicSlugError2(slug, "minimum 8 chars (avoids accidental short names)");
  }
  if (slug.length > 64) {
    throw new TopicSlugError2(slug, "maximum 64 chars (filesystem-friendly)");
  }
  if (!SLUG_PATTERN2.test(slug)) {
    throw new TopicSlugError2(slug, "must match /^[a-z0-9](?:[a-z0-9-]{6,62}[a-z0-9])$/ (lowercase ASCII, dashes ok, no leading/trailing dash)");
  }
  if (CONSECUTIVE_DASHES2.test(slug)) {
    throw new TopicSlugError2(slug, "no consecutive dashes (reserved as collision-suffix delimiter)");
  }
  if (RESERVED2.has(slug)) {
    throw new TopicSlugError2(slug, "reserved name (collides with filesystem or skill internals)");
  }
  for (const pattern of RESERVED_PATTERNS2) {
    if (pattern.test(slug)) {
      throw new TopicSlugError2(slug, `reserved pattern ${pattern} (Windows device name)`);
    }
  }
}

// lib/trace.ts
import { join as join10 } from "node:path";
var TRACES_DIRNAME = "traces";
function tracesDir(ws) {
  return join10(ensureStateDir(), "sessions", ws.dirName, TRACES_DIRNAME);
}
function topicTracesDir(ws, topic) {
  return join10(tracesDir(ws), topic);
}
function tracePath(ws, topic, round, agent) {
  const padded = String(round).padStart(6, "0");
  return join10(topicTracesDir(ws, topic), `${padded}-${agent}.json`);
}
function writeTrace(ws, trace) {
  const file = new AtomicFile(tracePath(ws, trace.topic, trace.round, trace.agent));
  file.writeJson(trace, 2);
}

// lib/duration.ts
var UNIT_MS = {
  m: 60000,
  h: 3600000,
  d: 86400000
};
function parseSince(spec) {
  const match = /^(\d+)([mhd])$/.exec(spec.trim());
  if (!match)
    return null;
  const n = Number.parseInt(match[1], 10);
  const unit = match[2];
  if (!Number.isFinite(n) || n <= 0)
    return null;
  const multiplier = UNIT_MS[unit];
  if (!multiplier)
    return null;
  return n * multiplier;
}

// lib/plan.ts
import { createHash } from "node:crypto";
import { existsSync as existsSync11, readdirSync as readdirSync5, readFileSync as readFileSync7, statSync as statSync4 } from "node:fs";
import { join as join11 } from "node:path";
var PLANS_DIRNAME = "plans";
function plansDir(ws) {
  return join11(ensureStateDir(), "sessions", ws.dirName, PLANS_DIRNAME);
}
function planPath(ws, topic) {
  return join11(plansDir(ws), `${topic}.md`);
}
function planHistoryDir(ws, topic) {
  return join11(plansDir(ws), `${topic}.history`);
}
function readPlan(ws, topic) {
  const path = planPath(ws, topic);
  if (!existsSync11(path)) {
    return { path, content: null, lastModified: null, contentHash: null };
  }
  const content = readFileSync7(path, "utf-8");
  const lastModified = statSync4(path).mtime;
  const contentHash = sha256(content);
  return { path, content, lastModified, contentHash };
}
function writePlan(ws, topic, content) {
  new AtomicFile(planPath(ws, topic)).write(content);
}
function snapshotPlanIfChanged(ws, topic, round) {
  const current = readPlan(ws, topic);
  if (current.content === null || current.contentHash === null) {
    return { snapshotted: false, path: null };
  }
  const history = listPlanHistoryRounds(ws, topic);
  if (history.length > 0) {
    const lastRound = history[history.length - 1];
    const lastContent = readPlanSnapshot(ws, topic, lastRound);
    if (lastContent !== null && sha256(lastContent) === current.contentHash) {
      return { snapshotted: false, path: null };
    }
  }
  const snapPath = join11(planHistoryDir(ws, topic), `${String(round).padStart(6, "0")}.md`);
  new AtomicFile(snapPath).write(current.content);
  return { snapshotted: true, path: snapPath };
}
function listPlanHistoryRounds(ws, topic) {
  const dir = planHistoryDir(ws, topic);
  if (!existsSync11(dir))
    return [];
  const rounds = [];
  for (const name of readdirSync5(dir)) {
    if (!name.endsWith(".md"))
      continue;
    const rawRound = name.slice(0, -".md".length);
    const n = Number.parseInt(rawRound, 10);
    if (Number.isFinite(n) && n > 0)
      rounds.push(n);
  }
  return rounds.sort((a, b) => a - b);
}
function readPlanSnapshot(ws, topic, round) {
  const path = join11(planHistoryDir(ws, topic), `${String(round).padStart(6, "0")}.md`);
  if (!existsSync11(path))
    return null;
  return readFileSync7(path, "utf-8");
}
function composePromptWithPlan(ws, topic, userPrompt, now = new Date) {
  const state = readPlan(ws, topic);
  if (state.content === null || state.lastModified === null) {
    return { prompt: userPrompt, injection: null };
  }
  const ageStr = formatAge(state.lastModified, now);
  const header = `## handoff plan: ${topic} (last edited ${ageStr})`;
  const footer = "## end handoff plan";
  const composed = `${header}
${state.content.trim()}
${footer}

${userPrompt}`;
  return {
    prompt: composed,
    injection: {
      sizeBytes: Buffer.byteLength(state.content, "utf-8"),
      ageString: ageStr,
      lastModified: state.lastModified,
      contentHash: state.contentHash
    }
  };
}
function formatAge(then, now = new Date) {
  const diffMs = now.getTime() - then.getTime();
  if (diffMs < 60000)
    return "just now";
  if (diffMs < 3600000)
    return `${Math.floor(diffMs / 60000)}m ago`;
  if (diffMs < 86400000)
    return `${Math.floor(diffMs / 3600000)}h ago`;
  if (diffMs < 7 * 86400000)
    return `${Math.floor(diffMs / 86400000)}d ago`;
  return `${Math.floor(diffMs / (7 * 86400000))}w ago`;
}
function sha256(s) {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

// lib/workspace.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { createHash as createHash2 } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname as dirname6, isAbsolute, resolve } from "node:path";

// lib/aliases.ts
import { join as join12 } from "node:path";
var FILENAME2 = "aliases.json";
function aliasFilePath2() {
  return join12(ensureStateDir(), FILENAME2);
}
function load2() {
  const file = new AtomicFile(aliasFilePath2());
  const raw = file.readJson();
  if (raw && raw.schema_version === 1 && raw.aliases)
    return raw;
  return { schema_version: 1, aliases: {} };
}
function lookupAlias(resolvedRoot) {
  const file = load2();
  return file.aliases[resolvedRoot] ?? null;
}

// lib/workspace.ts
function resolveWorkspace(cwd = process.cwd()) {
  const cwdReal = realpathSync(cwd);
  const probe = probeGitRepoRoot(cwdReal);
  const resolvedRoot = probe.kind === "ok" ? probe.repoRoot : cwdReal;
  const aliasedHash = lookupAlias(resolvedRoot);
  const hash = aliasedHash ?? createHash2("sha256").update(resolvedRoot, "utf8").digest("hex").slice(0, 12);
  const base = sanitizeBasename(basename(resolvedRoot));
  return {
    resolvedRoot,
    basename: base,
    hash,
    dirName: `${base}-${hash}`,
    fromGit: probe.kind === "ok",
    aliased: aliasedHash !== null,
    gitProbe: probe.kind
  };
}
function probeGitRepoRoot(cwd) {
  const result = spawnSync2("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error && result.error.code === "ENOENT") {
    return { kind: "missing-binary" };
  }
  if (result.status !== 0)
    return { kind: "not-a-repo" };
  const raw = result.stdout.trim();
  if (!raw)
    return { kind: "not-a-repo" };
  const absoluteGitDir = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const repoRoot = basename(absoluteGitDir) === ".git" ? dirname6(absoluteGitDir) : absoluteGitDir;
  try {
    return { kind: "ok", repoRoot: realpathSync(repoRoot) };
  } catch {
    return { kind: "ok", repoRoot };
  }
}
function sanitizeBasename(raw) {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return cleaned || "workspace";
}

// lib/ui-server.ts
import { spawnSync as spawnSync3 } from "node:child_process";
import { existsSync as existsSync12, readFileSync as readFileSync8 } from "node:fs";
import { createServer } from "node:http";
import { extname, join as join13, resolve as resolve3 } from "node:path";

// lib/runtime.ts
import { dirname as dirname7, resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";
function runtimeRepoRoot(importMetaUrl) {
  const here = dirname7(fileURLToPath(importMetaUrl));
  if (here.endsWith("/bin") || here.endsWith("/runtime") || here.endsWith("/lib")) {
    return resolve2(here, "..");
  }
  return here;
}

// lib/ui-server.ts
function isLoopbackHost(host) {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}
async function startUiServer(options) {
  const loopbackHost = isLoopbackHost(options.host);
  if (!loopbackHost && !options.unsafeHost) {
    console.error(`Refusing to bind handoff UI to non-loopback host "${options.host}". ` + "Use --unsafe-host if you understand this exposes handoff state on the network.");
    return 2;
  }
  if (options.noTranscripts && options.includeTranscripts) {
    console.error("Use either --no-transcripts or --include-transcripts, not both.");
    return 2;
  }
  const includeTranscripts = options.includeTranscripts || !options.noTranscripts && loopbackHost;
  const repoRoot = runtimeRepoRoot(import.meta.url);
  const uiRoot = resolveUiRoot(repoRoot);
  if (!existsSync12(join13(uiRoot, "index.html"))) {
    console.error(`UI assets not found at ${uiRoot}`);
    return 1;
  }
  const server = createServer((req, res) => {
    handleUiRequest(req, res, uiRoot, {
      allWorkspaces: options.allWorkspaces,
      includeTranscripts,
      buildSnapshot: options.buildSnapshot
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port, options.host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : options.port;
  const url = `http://${options.host}:${actualPort}/`;
  console.error(`[handoff] ui: ${url}`);
  console.error(options.allWorkspaces ? `[handoff] workspace: all workspaces under ${resolveStateDir()}` : `[handoff] workspace: ${options.workspace.resolvedRoot}`);
  if (!includeTranscripts) {
    console.error("[handoff] transcripts: disabled");
  }
  if (options.open) {
    spawnSync3(process.platform === "darwin" ? "open" : "xdg-open", [url], {
      stdio: "ignore"
    });
  }
  await new Promise((resolveStop) => {
    const stop = () => {
      server.close(() => resolveStop());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
function resolveUiRoot(repoRoot) {
  const runtimeUi = join13(repoRoot, "runtime", "ui");
  if (existsSync12(join13(runtimeUi, "index.html")))
    return runtimeUi;
  return join13(repoRoot, "ui", "handoff-ui");
}
function handleUiRequest(req, res, uiRoot, options) {
  const rawUrl = req.url ?? "/";
  const url = new URL(rawUrl, "http://handoff.local");
  if (url.pathname === "/api/snapshot") {
    try {
      const requestedScope = url.searchParams.get("scope");
      const snapshotOptions = {
        allWorkspaces: requestedScope === "all" ? true : requestedScope === "workspace" ? false : options.allWorkspaces,
        includeTranscripts: options.includeTranscripts
      };
      const includeTopicKey = url.searchParams.get("topic");
      if (includeTopicKey)
        snapshotOptions.includeTopicKey = includeTopicKey;
      writeJson(res, options.buildSnapshot(snapshotOptions));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }
  let rel;
  try {
    rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("bad request");
    return;
  }
  const fullPath = resolve3(uiRoot, rel);
  if (!fullPath.startsWith(`${uiRoot}/`) && fullPath !== uiRoot) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }
  try {
    const body = readFileSync8(fullPath);
    res.writeHead(200, { "content-type": contentType(fullPath) });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}
function writeJson(res, data) {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(data));
}
function contentType(path) {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".md":
      return "text/markdown; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

// lib/ui-snapshot.ts
import { readFileSync as readFileSync11, readdirSync as readdirSync10 } from "node:fs";
import { join as join19 } from "node:path";

// lib/pointer.ts
import { dirname as dirname8, join as join14 } from "node:path";
var POINTER_DIR2 = ".handoff";
var POINTER_FILE2 = "current.json";
function pointerPath2(workspaceRoot) {
  return join14(workspaceRoot, POINTER_DIR2, POINTER_FILE2);
}
function readPointer2(ws) {
  const file = new AtomicFile(pointerPath2(ws.resolvedRoot));
  const raw = file.readJson();
  if (raw === null)
    return null;
  if (raw.workspace_hash !== ws.hash)
    return null;
  return raw;
}

// lib/running.ts
import { existsSync as existsSync13, mkdirSync as mkdirSync8, readdirSync as readdirSync6, statSync as statSync5, unlinkSync as unlinkSync3 } from "node:fs";
import { join as join15 } from "node:path";
function runningDir2(ws) {
  return join15(ensureStateDir(), "running", ws.dirName);
}
function listRunning2(ws) {
  const dir = runningDir2(ws);
  if (!existsSync13(dir))
    return [];
  const out = [];
  for (const name of readdirSync6(dir)) {
    if (!name.endsWith(".json"))
      continue;
    const path = join15(dir, name);
    try {
      if (!statSync5(path).isFile())
        continue;
    } catch {
      continue;
    }
    const file = new AtomicFile(path);
    const raw = file.readJson();
    if (!isRunningRecord2(raw))
      continue;
    if (!isAlive2(raw.pid)) {
      try {
        unlinkSync3(path);
      } catch {}
      continue;
    }
    out.push(raw);
  }
  return out.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
}
function isRunningRecord2(raw) {
  return Boolean(raw && raw.schema_version === 1 && typeof raw.pid === "number" && typeof raw.topic === "string" && isAgentName2(raw.agent) && typeof raw.run_id === "string" && typeof raw.workspace_root === "string" && typeof raw.started_at === "string");
}
function isAgentName2(value) {
  return value === "claude" || value === "codex" || value === "cursor";
}
function isAlive2(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// lib/registry.ts
import { existsSync as existsSync14, mkdirSync as mkdirSync9, readdirSync as readdirSync7, readFileSync as readFileSync9, renameSync as renameSync3, rmSync as rmSync3, writeFileSync as writeFileSync5 } from "node:fs";
import { dirname as dirname9, join as join16 } from "node:path";
function workspaceDir2(ws) {
  return join16(ensureStateDir(), "sessions", ws.dirName);
}
function snapshotPath2(ws, topic) {
  return join16(workspaceDir2(ws), `${topic}.json`);
}
function historyPath2(ws, topic) {
  return join16(workspaceDir2(ws), `${topic}.history.jsonl`);
}
function loadSnapshot2(ws, topic) {
  validateTopic(topic);
  const file = new AtomicFile(snapshotPath2(ws, topic));
  const raw = file.readJson();
  if (raw === null)
    return null;
  return migrateSnapshot(raw);
}
function readHistory2(ws, topic) {
  validateTopic(topic);
  const log = new EventLog(historyPath2(ws, topic));
  return log.read().map(migrateEvent);
}
function listTopics2(ws) {
  const dir = workspaceDir2(ws);
  if (!existsSync14(dir))
    return [];
  const entries = readdirSync7(dir);
  const topics = [];
  for (const name of entries) {
    if (!name.endsWith(".json"))
      continue;
    if (name.endsWith(".history.jsonl"))
      continue;
    if (name.startsWith("."))
      continue;
    topics.push(name.slice(0, -".json".length));
  }
  return topics.sort();
}
function listTopicSummaries2(ws) {
  const slugs = listTopics2(ws);
  const out = [];
  for (const topic of slugs) {
    const snap = loadSnapshot2(ws, topic);
    if (!snap)
      continue;
    out.push({
      topic,
      summary: snap.summary,
      lifecycle: classify(snap),
      roundCount: snap.round_count,
      lastUsedAt: snap.last_used_at,
      sessions: snap.sessions
    });
  }
  out.sort((a, b) => {
    if (a.lifecycle !== b.lifecycle) {
      return a.lifecycle === "active" ? -1 : 1;
    }
    return a.topic.localeCompare(b.topic);
  });
  return out;
}

// lib/trace.ts
import { readdirSync as readdirSync8 } from "node:fs";
import { join as join17 } from "node:path";
var TRACES_DIRNAME2 = "traces";
function tracesDir2(ws) {
  return join17(ensureStateDir(), "sessions", ws.dirName, TRACES_DIRNAME2);
}
function topicTracesDir2(ws, topic) {
  return join17(tracesDir2(ws), topic);
}
function readTraces(ws, topic) {
  const dir = topicTracesDir2(ws, topic);
  let entries;
  try {
    entries = readdirSync8(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!name.endsWith(".json"))
      continue;
    const file = new AtomicFile(join17(dir, name));
    const raw = file.readJson();
    if (raw && raw.schema_version === 1)
      out.push(raw);
  }
  out.sort((a, b) => a.round - b.round);
  return out;
}

// lib/transcripts.ts
import { readFileSync as readFileSync10 } from "node:fs";

// lib/agents/cursor-sqlite.ts
import { spawnSync as spawnSync4 } from "node:child_process";
import { existsSync as existsSync15 } from "node:fs";
function readCursorChat2(dbPath, options = {}) {
  const warnings = [];
  if (!existsSync15(dbPath)) {
    warnings.push(`store.db not found at ${dbPath}`);
    return { meta: {}, rootBlobId: null, turns: [], warnings };
  }
  if (!sqlite3Available2()) {
    warnings.push("sqlite3 CLI not on PATH — install sqlite3 to read cursor chats");
    return { meta: {}, rootBlobId: null, turns: [], warnings };
  }
  const meta = readMeta2(dbPath, warnings);
  const rootBlobId = meta.latestRootBlobId ?? null;
  if (!rootBlobId) {
    warnings.push("meta has no latestRootBlobId; chat may be empty or schema changed");
    return { meta, rootBlobId: null, turns: [], warnings };
  }
  if (options.sinceRootBlobId === rootBlobId) {
    return { meta, rootBlobId, turns: [], warnings };
  }
  const childIds = readRootChildren2(dbPath, rootBlobId, warnings);
  const turns = [];
  for (const id of childIds) {
    const blobHex = readBlobHex2(dbPath, id);
    if (!blobHex) {
      warnings.push(`blob ${id.slice(0, 12)}… not found (referenced by root)`);
      continue;
    }
    const turn = parseTurnBlob2(id, blobHex, warnings);
    if (turn)
      turns.push(turn);
  }
  return { meta, rootBlobId, turns, warnings };
}
function sqlite3Available2() {
  const r = spawnSync4("sqlite3", ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
  return r.status === 0;
}
function validateRootBlobShape2(hex) {
  return /^0a20[0-9a-f]{64}/i.test(hex);
}
function runSqlite2(dbPath, sql) {
  const r = spawnSync4("sqlite3", [dbPath, sql], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (r.status !== 0)
    return null;
  return r.stdout.trim();
}
function readMeta2(dbPath, warnings) {
  const hexValue = runSqlite2(dbPath, "SELECT value FROM meta WHERE key='0';");
  if (!hexValue) {
    warnings.push("meta key '0' not found in store.db");
    return {};
  }
  if (!/^[0-9a-f]+$/i.test(hexValue) || hexValue.length % 2 !== 0) {
    warnings.push(`meta value not hex (got ${hexValue.length} chars); schema drift`);
    return {};
  }
  let json;
  try {
    json = Buffer.from(hexValue, "hex").toString("utf-8");
  } catch (err) {
    warnings.push(`meta value hex-decode failed: ${err.message}`);
    return {};
  }
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) {
      warnings.push("meta json not an object");
      return {};
    }
    return parsed;
  } catch (err) {
    warnings.push(`meta json parse failed: ${err.message}`);
    return {};
  }
}
function readBlobHex2(dbPath, blobId) {
  if (!/^[0-9a-f]{64}$/i.test(blobId))
    return null;
  const hex = runSqlite2(dbPath, `SELECT hex(data) FROM blobs WHERE id='${blobId}';`);
  if (!hex)
    return null;
  return hex.toLowerCase();
}
function readRootChildren2(dbPath, rootId, warnings) {
  const hex = readBlobHex2(dbPath, rootId);
  if (!hex) {
    warnings.push(`root blob ${rootId.slice(0, 12)}… not found`);
    return [];
  }
  if (!validateRootBlobShape2(hex)) {
    warnings.push(`root blob shape unexpected (does not start with 0A 20 …); cursor format drift?`);
    return [];
  }
  return extractField1BlobIds2(hex);
}
function extractField1BlobIds2(hex) {
  const ids = [];
  let i = 0;
  while (i + 4 + 64 <= hex.length) {
    const tag = hex.slice(i, i + 2);
    const len = hex.slice(i + 2, i + 4);
    if (tag !== "0a" || len !== "20")
      break;
    ids.push(hex.slice(i + 4, i + 4 + 64));
    i += 4 + 64;
  }
  return ids;
}
var KNOWN_ROLES2 = new Set(["system", "user", "assistant", "tool", "developer"]);
function parseTurnBlob2(blobId, hex, warnings) {
  const utf8 = Buffer.from(hex, "hex").toString("utf-8");
  const trimmed = utf8.trim();
  if (trimmed.startsWith("{")) {
    return tryParse2(blobId, trimmed, warnings);
  }
  const firstBrace = utf8.indexOf("{");
  if (firstBrace === -1) {
    return null;
  }
  return tryParse2(blobId, utf8.slice(firstBrace), warnings);
}
function tryParse2(blobId, json, warnings) {
  const balanced = extractBalancedJson2(json);
  if (!balanced) {
    warnings.push(`blob ${blobId.slice(0, 12)}…: could not find balanced JSON object`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(balanced);
  } catch (err) {
    warnings.push(`blob ${blobId.slice(0, 12)}…: json parse failed (${err.message})`);
    return null;
  }
  const role = parsed.role;
  if (!role || typeof role !== "string") {
    return null;
  }
  if (!KNOWN_ROLES2.has(role)) {
    warnings.push(`blob ${blobId.slice(0, 12)}…: unknown role "${role}" — added since this adapter shipped?`);
  }
  const text = stringifyContent2(parsed.content);
  return { blobId, role, text, raw: parsed };
}
function extractBalancedJson2(s) {
  if (s[0] !== "{")
    return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0;i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString)
      continue;
    if (ch === "{")
      depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0)
        return s.slice(0, i + 1);
    }
  }
  return null;
}
function stringifyContent2(content) {
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return "";
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== "object")
      continue;
    const p = {
      ...part
    };
    if (typeof p.text === "string")
      parts.push(p.text);
    else if (p.type === "redacted-reasoning")
      parts.push("<redacted-reasoning>");
    else if (p.type === "tool_use" && p.name) {
      const args = toolArgsText2(p.input ?? p.arguments);
      parts.push(`<tool: ${String(p.name)}>${args ? `
${args}` : ""}`);
    } else if (p.type === "tool_result") {
      const result = typeof p.content === "string" ? p.content : stringifyContent2(p.content);
      parts.push(`<tool_result>${result ? `
${result}` : ""}`);
    } else if (p.type)
      parts.push(`<${p.type}>`);
  }
  return parts.join(" ").trim();
}
function toolArgsText2(value) {
  if (value == null || value === "")
    return "";
  if (typeof value === "string")
    return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// lib/local-sessions.ts
import { existsSync as existsSync16, readdirSync as readdirSync9 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join18 } from "node:path";
function encodeClaudeWorkspace2(workspaceRoot) {
  return workspaceRoot.replace(/[/.]/g, "-");
}
function resolveLocalSession2(agent, sessionId, workspaceRoot) {
  if (!isValidSessionId(agent, sessionId)) {
    return { kind: "missing", reason: `invalid ${agent} session id shape` };
  }
  switch (agent) {
    case "claude":
      return resolveClaude2(sessionId, workspaceRoot);
    case "codex":
      return resolveCodex2(sessionId);
    case "cursor":
      return resolveCursor2(sessionId);
  }
}
function resolveCursor2(sessionId) {
  const root = join18(homedir4(), ".cursor", "chats");
  if (!existsSync16(root)) {
    return { kind: "missing", reason: "no ~/.cursor/chats directory" };
  }
  for (const ws of readdirSync9(root)) {
    const candidate = join18(root, ws, sessionId, "store.db");
    if (existsSync16(candidate))
      return { kind: "sqlite-cursor", path: candidate };
  }
  return {
    kind: "missing",
    reason: `no store.db under ~/.cursor/chats/*/${sessionId}/`
  };
}
function resolveClaude2(sessionId, workspaceRoot) {
  const root = join18(homedir4(), ".claude", "projects");
  if (!existsSync16(root)) {
    return { kind: "missing", reason: `no ~/.claude/projects directory` };
  }
  const encoded = encodeClaudeWorkspace2(workspaceRoot);
  const candidate = join18(root, encoded, `${sessionId}.jsonl`);
  if (existsSync16(candidate))
    return { kind: "file", path: candidate };
  for (const dir of readdirSync9(root)) {
    const path = join18(root, dir, `${sessionId}.jsonl`);
    if (existsSync16(path))
      return { kind: "file", path };
  }
  return {
    kind: "missing",
    reason: `no ${sessionId}.jsonl under ~/.claude/projects/* (workspace ${encoded})`
  };
}
function resolveCodex2(sessionId) {
  const root = join18(homedir4(), ".codex", "sessions");
  if (!existsSync16(root)) {
    return { kind: "missing", reason: "no ~/.codex/sessions directory" };
  }
  const tail = `-${sessionId}.jsonl`;
  const years = readdirSync9(root).filter((n) => /^\d{4}$/.test(n)).sort().reverse();
  for (const y of years) {
    const months = readdirSync9(join18(root, y)).filter((n) => /^\d{2}$/.test(n)).sort().reverse();
    for (const m of months) {
      const days = readdirSync9(join18(root, y, m)).filter((n) => /^\d{2}$/.test(n)).sort().reverse();
      for (const d of days) {
        const dir = join18(root, y, m, d);
        for (const name of readdirSync9(dir)) {
          if (name.endsWith(tail))
            return { kind: "file", path: join18(dir, name) };
        }
      }
    }
  }
  return {
    kind: "missing",
    reason: `no rollout-*-${sessionId}.jsonl under ~/.codex/sessions`
  };
}

// lib/transcripts.ts
function resolveTranscriptTurns(agent, sessionId, workspaceRoot) {
  const res = resolveLocalSession2(agent, sessionId, workspaceRoot);
  if (res.kind === "missing" || res.kind === "unsupported")
    return null;
  if (res.kind === "sqlite-cursor") {
    const result = readCursorChat2(res.path);
    return {
      sourcePath: res.path,
      turns: result.turns.map(cursorTurnToTranscript),
      warnings: result.warnings
    };
  }
  let lines;
  try {
    lines = readFileSync10(res.path, "utf-8").split(`
`).filter((line) => line.length > 0);
  } catch {
    return null;
  }
  return {
    sourcePath: res.path,
    turns: lines.map((line) => parseTurn(line)).filter((turn) => turn !== null),
    warnings: []
  };
}
function cursorTurnToTranscript(turn) {
  return { role: turn.role, text: turn.text, ts: null, raw: turn.raw };
}
function isToolTurn(t) {
  return t.role === "tool_call" || t.role === "tool" || t.role === "function_call";
}
function parseTurn(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const ts = parsed.timestamp ?? parsed.ts ?? null;
  if (parsed.type === "response_item" && parsed.payload) {
    const p = parsed.payload;
    if (p.type === "message" && p.role) {
      return { role: p.role, text: extractTextFromContent(p.content), ts, raw: parsed };
    }
    if (p.type === "function_call" && p.name) {
      const argsPreview = (p.arguments ?? "").replace(/\s+/g, " ").trim();
      const args = argsPreview.length > 80 ? `${argsPreview.slice(0, 77)}…` : argsPreview;
      return { role: "tool_call", text: `${p.name}(${args})`, ts, raw: parsed };
    }
    return null;
  }
  if (parsed.type === "event_msg" || parsed.type === "session_meta" || parsed.type === "turn_context") {
    return null;
  }
  if (parsed.type === "user" || parsed.type === "assistant") {
    const role2 = parsed.message?.role ?? parsed.type;
    return {
      role: role2,
      text: extractTextFromContent(parsed.message?.content),
      ts,
      raw: parsed
    };
  }
  if (["system", "attachment", "queue-operation", "last-prompt"].includes(parsed.type ?? "")) {
    return null;
  }
  const role = parsed.role ?? parsed.message?.role ?? parsed.type ?? "";
  if (!role || ["state", "cache_event"].includes(role))
    return null;
  return {
    role,
    text: extractTextFromContent(parsed.message?.content ?? parsed.content),
    ts,
    raw: parsed
  };
}
function extractTextFromContent(content) {
  if (typeof content === "string")
    return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(part);
        continue;
      }
      if (!part || typeof part !== "object")
        continue;
      const p = part;
      if (typeof p.text === "string")
        parts.push(p.text);
      else if (typeof p.thinking === "string")
        parts.push(`<thinking> ${p.thinking}`);
      else if (p.type === "tool_use" && p.name) {
        const args = toolArgsText3(p.input ?? p.arguments);
        parts.push(`<tool: ${String(p.name)}>${args ? `
${args}` : ""}`);
      } else if (p.type === "tool_result") {
        const result = typeof p.content === "string" ? p.content : extractTextFromContent(p.content);
        parts.push(`<tool_result>${result ? `
${result}` : ""}`);
      } else if (p.type === "image" || p.source)
        parts.push("[image]");
      else if (p.type)
        parts.push(`<${p.type}>`);
    }
    return parts.join(" ").trim();
  }
  return "";
}
function toolArgsText3(value) {
  if (value == null || value === "")
    return "";
  if (typeof value === "string")
    return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// lib/ui-snapshot.ts
function buildUiSnapshot(workspace, options = {}) {
  const pointer = options.allWorkspaces ? null : readPointer2(workspace);
  const workspaces = options.allWorkspaces ? listUiWorkspaces(workspace) : [workspace];
  const transcripts = {};
  const running = [];
  const topics = [];
  for (const ws of workspaces) {
    const wsSummary = workspaceSummary(ws);
    const wsRunning = listRunning2(ws).map((run) => ({
      key: `${ws.dirName}/${run.topic}--${run.agent}--${run.run_id}`,
      topicKey: `${ws.dirName}/${run.topic}`,
      topic: run.topic,
      agent: run.agent,
      mode: run.mode ?? "running",
      pid: run.pid,
      startedAt: run.started_at,
      elapsedMs: Date.now() - Date.parse(run.started_at),
      pidAlive: true,
      runId: run.run_id ?? null,
      parentRunId: run.parent_run_id ?? null,
      workspace: wsSummary
    }));
    running.push(...wsRunning);
    const runningByTopic = new Map;
    for (const run of wsRunning) {
      const list = runningByTopic.get(run.topic) ?? [];
      list.push(run);
      runningByTopic.set(run.topic, list);
    }
    for (const summary of listTopicSummaries2(ws)) {
      const currentTopicKey = `${ws.dirName}/${summary.topic}`;
      const shouldResolveTranscripts = options.includeTranscripts !== false && (!options.allWorkspaces || options.includeTopicKey === currentTopicKey);
      const snapshot = loadSnapshot2(ws, summary.topic);
      const history = readHistory2(ws, summary.topic);
      const traceByRound = new Map(readTraces(ws, summary.topic).map((trace) => [`${trace.round}:${trace.agent}`, trace]));
      const rounds = [];
      for (const event of history) {
        if (event.kind !== "created" && event.kind !== "invocation")
          continue;
        const trace = traceByRound.get(`${event.round}:${event.agent}`);
        const sessionId = event.session_id ?? null;
        if (sessionId && shouldResolveTranscripts) {
          addTranscript(transcripts, event.agent, sessionId, ws.resolvedRoot);
        }
        rounds.push({
          index: event.round,
          agent: event.agent,
          fromAgent: event.caller_agent ?? null,
          mode: event.mode,
          verdict: event.kind === "invocation" ? event.verdict : "unknown",
          startedAt: event.ts,
          durationMs: event.kind === "invocation" ? event.duration_ms : null,
          sessionId,
          promptPreview: trace ? preview(trace.prompt) : event.kind === "created" ? summary.summary ?? "Topic created" : `${event.agent}/${event.mode} invocation`,
          resultPreview: trace ? preview(trace.output) : event.kind === "created" ? "Topic created in handoff history" : `${event.verdict}; no trace body stored for this round`,
          hasTrace: Boolean(trace),
          isRunning: false,
          ...trace ? { traceSpans: traceToSpans(trace) } : {},
          agentSteps: eventToSteps(event, trace, sessionId)
        });
      }
      let nextSyntheticRound = Math.max(snapshot?.round_count ?? summary.roundCount, 0) + 1;
      for (const run of runningByTopic.get(summary.topic) ?? []) {
        const sessionId = snapshot?.sessions[run.agent] ?? null;
        if (sessionId && shouldResolveTranscripts) {
          addTranscript(transcripts, run.agent, sessionId, ws.resolvedRoot);
        }
        rounds.push({
          index: nextSyntheticRound++,
          agent: run.agent,
          fromAgent: null,
          mode: run.mode === "running" ? "running" : run.mode,
          verdict: "unknown",
          startedAt: run.startedAt,
          durationMs: null,
          sessionId,
          promptPreview: "Running handoff invocation",
          resultPreview: `pid ${run.pid} is still active`,
          hasTrace: false,
          isRunning: true,
          agentSteps: [
            { kind: "process", label: "Process alive", text: `pid ${run.pid} is still running.` },
            {
              kind: "handoff",
              label: "Awaiting durable event",
              text: "The final history row is written after the child agent exits."
            }
          ]
        });
      }
      rounds.sort((a, b) => a.index - b.index);
      topics.push({
        key: currentTopicKey,
        slug: summary.topic,
        workspace: wsSummary,
        summary: summary.summary,
        lifecycle: summary.lifecycle,
        roundCount: snapshot?.round_count ?? summary.roundCount,
        createdAt: snapshot?.created_at ?? summary.lastUsedAt,
        lastUsedAt: summary.lastUsedAt,
        sessions: {
          claude: summary.sessions.claude ?? null,
          codex: summary.sessions.codex ?? null,
          cursor: summary.sessions.cursor ?? null
        },
        rounds
      });
    }
  }
  topics.sort((a, b) => {
    const wsCmp = a.workspace.basename.localeCompare(b.workspace.basename);
    if (wsCmp !== 0)
      return wsCmp;
    return a.slug.localeCompare(b.slug);
  });
  const workspaceSummaries = workspaces.map(workspaceSummary);
  return {
    workspace: {
      root: options.allWorkspaces ? resolveStateDir() : workspace.resolvedRoot,
      basename: options.allWorkspaces ? "all workspaces" : workspace.basename,
      hash: options.allWorkspaces ? String(workspaceSummaries.length).padStart(4, "0") : workspace.hash,
      dirName: options.allWorkspaces ? "all" : workspace.dirName,
      scope: options.allWorkspaces ? "all" : "workspace",
      releaseVersion: handoffVersion(),
      schemaVersion: SCHEMA_VERSION,
      pointer: pointer?.current_topic ?? null,
      stateDir: resolveStateDir(),
      workspaces: workspaceSummaries
    },
    running,
    topics,
    transcripts
  };
}
function listAllWorkspaceDirs() {
  const sessionsRoot = join19(resolveStateDir(), "sessions");
  try {
    return readdirSync10(sessionsRoot).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
}
function listUiWorkspaces(current) {
  const byDir = new Map;
  byDir.set(current.dirName, current);
  for (const dirName of listAllWorkspaceDirs()) {
    const ws = workspaceFromStateDir(dirName);
    if (ws)
      byDir.set(dirName, ws);
  }
  return [...byDir.values()].sort((a, b) => {
    const nameCmp = a.basename.localeCompare(b.basename);
    if (nameCmp !== 0)
      return nameCmp;
    return a.dirName.localeCompare(b.dirName);
  });
}
function workspaceFromStateDir(dirName) {
  const dir = join19(resolveStateDir(), "sessions", dirName);
  let names;
  try {
    names = readdirSync10(dir);
  } catch {
    return null;
  }
  for (const name of names.sort()) {
    if (!name.endsWith(".json"))
      continue;
    if (name.endsWith(".history.jsonl"))
      continue;
    if (name.startsWith("."))
      continue;
    try {
      const raw = JSON.parse(readFileSync11(join19(dir, name), "utf-8"));
      const ws = raw.workspace;
      if (!ws?.resolvedRoot || !ws.basename || !ws.hash)
        continue;
      return {
        resolvedRoot: ws.resolvedRoot,
        basename: ws.basename,
        hash: ws.hash,
        dirName,
        fromGit: Boolean(ws.fromGit),
        aliased: false,
        gitProbe: ws.fromGit ? "ok" : "not-a-repo"
      };
    } catch {
      continue;
    }
  }
  return null;
}
function workspaceSummary(ws) {
  return {
    root: ws.resolvedRoot,
    basename: ws.basename,
    hash: ws.hash,
    dirName: ws.dirName
  };
}
function handoffVersion() {
  try {
    const pkg = JSON.parse(readFileSync11(join19(runtimeRepoRoot(import.meta.url), "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}
function addTranscript(out, agent, sessionId, workspaceRoot) {
  const key = `${agent}:${sessionId}`;
  if (out[key])
    return;
  const resolved = resolveTranscriptTurns(agent, sessionId, workspaceRoot);
  if (!resolved)
    return;
  out[key] = {
    sourcePath: resolved.sourcePath,
    turns: resolved.turns.slice(-200).map(turnToUi)
  };
}
function turnToUi(turn) {
  const meta = toolMeta(turn.raw);
  const name = meta.toolName ?? (isToolTurn(turn) ? /^([\w.-]+)/.exec(turn.text)?.[1] ?? turn.role : undefined);
  return {
    role: turn.role,
    text: turn.text,
    ts: turn.ts,
    ...name ? { name } : {},
    ...meta.toolUseId ? { toolUseId: meta.toolUseId } : {},
    ...meta.toolName ? { toolName: meta.toolName } : {},
    ...meta.isError !== undefined ? { isError: meta.isError } : {}
  };
}
function toolMeta(raw) {
  if (!raw || typeof raw !== "object")
    return {};
  const envelope = raw;
  if (envelope.payload?.type === "function_call") {
    const meta = {};
    const id = envelope.payload.call_id ?? envelope.payload.id;
    if (id)
      meta.toolUseId = id;
    if (envelope.payload.name)
      meta.toolName = envelope.payload.name;
    return meta;
  }
  const content = envelope.message?.content;
  if (!Array.isArray(content))
    return {};
  for (const part of content) {
    if (!part || typeof part !== "object")
      continue;
    const p = part;
    if (p.type === "tool_use") {
      const meta = {};
      if (p.id)
        meta.toolUseId = p.id;
      if (p.name)
        meta.toolName = p.name;
      return meta;
    }
    if (p.type === "tool_result") {
      const meta = {};
      if (p.tool_use_id)
        meta.toolUseId = p.tool_use_id;
      if (p.is_error !== undefined)
        meta.isError = p.is_error;
      return meta;
    }
  }
  return {};
}
function traceToSpans(trace) {
  return [
    { kind: "trace", name: "prompt captured", durationMs: Math.min(trace.prompt.length, 1000) },
    { kind: "agent", name: "agent runtime", durationMs: trace.duration_ms ?? 0 },
    { kind: "trace", name: "output captured", durationMs: Math.min(trace.output.length, 1000) }
  ];
}
function eventToSteps(event, trace, sessionId) {
  const steps = [
    {
      kind: event.kind,
      label: event.kind === "created" ? "Topic created" : "Invocation recorded",
      text: `Handoff stored round ${event.round} for ${event.agent}/${event.mode}.`
    }
  ];
  steps.push(sessionId ? { kind: "session", label: "Session pointer captured", text: sessionId } : { kind: "session", label: "No session pointer", text: "Native chat cannot be resolved for this round." });
  steps.push(trace ? { kind: "trace", label: "Trace body stored", text: "Prompt and output are available from handoff trace storage." } : { kind: "trace", label: "No trace body", text: "Only categorical history metadata is available for this round." });
  if (event.kind === "invocation") {
    steps.push({
      kind: "verdict",
      label: `Verdict ${event.verdict}`,
      text: event.duration_ms === null ? "No duration recorded." : `Completed in ${event.duration_ms}ms.`
    });
  }
  return steps;
}
function preview(text, max = 220) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}...` : compact;
}

// lib/transcripts.ts
function cursorTurnToTranscript2(turn) {
  return { role: turn.role, text: turn.text, ts: null, raw: turn.raw };
}
function isToolTurn2(t) {
  return t.role === "tool_call" || t.role === "tool" || t.role === "function_call";
}
function isSystemTurn(t) {
  if (t.role === "system" || t.role === "developer")
    return true;
  if (t.role === "user") {
    const head = t.text.trimStart().slice(0, 30);
    if (head.startsWith("<environment_context>"))
      return true;
    if (head.startsWith("<user_info>"))
      return true;
  }
  return false;
}
function parseTurn2(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const ts = parsed.timestamp ?? parsed.ts ?? null;
  if (parsed.type === "response_item" && parsed.payload) {
    const p = parsed.payload;
    if (p.type === "message" && p.role) {
      return { role: p.role, text: extractTextFromContent2(p.content), ts, raw: parsed };
    }
    if (p.type === "function_call" && p.name) {
      const argsPreview = (p.arguments ?? "").replace(/\s+/g, " ").trim();
      const args = argsPreview.length > 80 ? `${argsPreview.slice(0, 77)}…` : argsPreview;
      return { role: "tool_call", text: `${p.name}(${args})`, ts, raw: parsed };
    }
    return null;
  }
  if (parsed.type === "event_msg" || parsed.type === "session_meta" || parsed.type === "turn_context") {
    return null;
  }
  if (parsed.type === "user" || parsed.type === "assistant") {
    const role2 = parsed.message?.role ?? parsed.type;
    return {
      role: role2,
      text: extractTextFromContent2(parsed.message?.content),
      ts,
      raw: parsed
    };
  }
  if (["system", "attachment", "queue-operation", "last-prompt"].includes(parsed.type ?? "")) {
    return null;
  }
  const role = parsed.role ?? parsed.message?.role ?? parsed.type ?? "";
  if (!role || ["state", "cache_event"].includes(role))
    return null;
  return {
    role,
    text: extractTextFromContent2(parsed.message?.content ?? parsed.content),
    ts,
    raw: parsed
  };
}
function extractTextFromContent2(content) {
  if (typeof content === "string")
    return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(part);
        continue;
      }
      if (!part || typeof part !== "object")
        continue;
      const p = part;
      if (typeof p.text === "string")
        parts.push(p.text);
      else if (typeof p.thinking === "string")
        parts.push(`<thinking> ${p.thinking}`);
      else if (p.type === "tool_use" && p.name) {
        const args = toolArgsText4(p.input ?? p.arguments);
        parts.push(`<tool: ${String(p.name)}>${args ? `
${args}` : ""}`);
      } else if (p.type === "tool_result") {
        const result = typeof p.content === "string" ? p.content : extractTextFromContent2(p.content);
        parts.push(`<tool_result>${result ? `
${result}` : ""}`);
      } else if (p.type === "image" || p.source)
        parts.push("[image]");
      else if (p.type)
        parts.push(`<${p.type}>`);
    }
    return parts.join(" ").trim();
  }
  return "";
}
function toolArgsText4(value) {
  if (value == null || value === "")
    return "";
  if (typeof value === "string")
    return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// bin/agent-handoff.ts
import {
  closeSync as closeSync2,
  openSync as openSync2,
  readdirSync as readdirSync11,
  readSync,
  statSync as statSync6,
  unlinkSync as unlinkSync5,
  writeFileSync as writeFileSync7
} from "fs";
import { join as join21 } from "path";

// lib/atomic-file.ts
import { existsSync as existsSync17, mkdirSync as mkdirSync10, readFileSync as readFileSync12, renameSync as renameSync4, unlinkSync as unlinkSync4, writeFileSync as writeFileSync6 } from "node:fs";
import { dirname as dirname10, join as join20 } from "node:path";

class AtomicFile2 {
  path;
  constructor(path) {
    this.path = path;
  }
  read() {
    try {
      return readFileSync12(this.path, "utf-8");
    } catch (error) {
      if (error.code === "ENOENT")
        return null;
      throw error;
    }
  }
  readJson() {
    const content = this.read();
    if (content === null)
      return null;
    return JSON.parse(content);
  }
  write(content) {
    const dir = dirname10(this.path);
    if (!existsSync17(dir))
      mkdirSync10(dir, { recursive: true, mode: 448 });
    const tempPath = this.generateTempPath();
    writeFileSync6(tempPath, content, { encoding: "utf-8", mode: 384 });
    try {
      renameSync4(tempPath, this.path);
    } catch (error) {
      try {
        unlinkSync4(tempPath);
      } catch {}
      throw error;
    }
  }
  writeJson(data, indent = 0) {
    const content = indent > 0 ? JSON.stringify(data, null, indent) : JSON.stringify(data);
    this.write(content);
  }
  exists() {
    return existsSync17(this.path);
  }
  delete() {
    try {
      unlinkSync4(this.path);
      return true;
    } catch (error) {
      if (error.code === "ENOENT")
        return false;
      throw error;
    }
  }
  get filePath() {
    return this.path;
  }
  generateTempPath() {
    return join20(dirname10(this.path), `.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  }
}

// bin/agent-handoff.ts
var NEST_DEPTH_VAR = "AGENT_HANDOFF_DEPTH";
var NEST_TOKEN_VAR = "AGENT_HANDOFF_TOKEN";
var CONTEXT_TOPIC_VAR = "AGENT_HANDOFF_TOPIC";
var CONTEXT_WORKSPACE_ROOT_VAR = "AGENT_HANDOFF_WORKSPACE_ROOT";
var CONTEXT_WORKSPACE_DIR_VAR = "AGENT_HANDOFF_WORKSPACE_DIR";
var CONTEXT_RUN_ID_VAR = "AGENT_HANDOFF_RUN_ID";
var CONTEXT_PARENT_RUN_ID_VAR = "AGENT_HANDOFF_PARENT_RUN_ID";
var CONTEXT_CALLER_AGENT_VAR = "AGENT_HANDOFF_CALLER_AGENT";
function mintNestToken() {
  return `r${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
function mintRunId() {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
function detectCallerAgent() {
  const explicit = process.env[CONTEXT_CALLER_AGENT_VAR];
  if (explicit === "claude" || explicit === "codex" || explicit === "cursor")
    return explicit;
  if (process.env.CODEX_THREAD_ID || process.env.CODEX_CI)
    return "codex";
  if (process.env.CLAUDECODE || process.env.CLAUDE_AGENT_SDK_VERSION)
    return "claude";
  if (process.env.CURSOR_AGENT || process.env.CURSOR_TRACE_ID)
    return "cursor";
  return null;
}
async function main(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    printUsage();
    return 0;
  }
  switch (sub) {
    case "send":
      return await cmdSend(rest);
    case "list":
    case "ls":
      return cmdList(rest);
    case "show":
      return cmdShow(rest);
    case "archive":
      return await cmdArchive(rest);
    case "prune":
      return await cmdPrune(rest);
    case "use":
      return cmdUse(rest);
    case "clear":
      return cmdClear(rest);
    case "status":
      return cmdStatus(rest);
    case "doctor":
      return cmdDoctor(rest);
    case "alias":
      return cmdAlias(rest);
    case "reset-session":
      return await cmdResetSession(rest);
    case "tail":
      return await cmdTail(rest);
    case "log":
      return cmdLog(rest);
    case "plan":
      return await cmdPlan(rest);
    case "cancel":
      return cmdCancel(rest);
    case "watch":
      return await cmdWatch(rest);
    case "history":
      return cmdHistory(rest);
    case "ui":
      return await cmdUi(rest);
    default:
      console.error(`Unknown subcommand: ${sub}
`);
      printUsage();
      return 2;
  }
}
async function cmdSend(argv) {
  const args = parseFlags(argv, {
    string: ["agent", "mode", "topic", "summary", "workspace", "prompt-file", "prompt"],
    boolean: [
      "resume",
      "new-topic",
      "archive-and-new",
      "allow-nested",
      "current",
      "store-trace",
      "no-plan",
      "snapshot-plan-on-edit",
      "clean-env"
    ]
  });
  const depthRaw = process.env[NEST_DEPTH_VAR];
  const depth = depthRaw ? Number.parseInt(depthRaw, 10) : 0;
  const incomingToken = process.env[NEST_TOKEN_VAR];
  const trulyNested = depth >= 1 && Boolean(incomingToken);
  if (trulyNested && !boolFlag(args, "allow-nested")) {
    console.error(`Refusing nested handoff invocation (${NEST_DEPTH_VAR}=${depth}). ` + `Pass --allow-nested if you really want this.`);
    return 3;
  }
  const agentName = strFlag(args, "agent");
  const modeName = strFlag(args, "mode");
  let topicSlug = strFlag(args, "topic");
  if (!agentName) {
    console.error("Missing required --agent");
    return 2;
  }
  if (!modeName) {
    console.error("Missing required --mode");
    return 2;
  }
  const prompt = readPrompt(strFlag(args, "prompt-file"), strFlag(args, "prompt"));
  if (prompt === null) {
    console.error("Provide a prompt via --prompt or --prompt-file (or pipe stdin).");
    return 2;
  }
  let agent;
  try {
    agent = resolveAgent(agentName);
  } catch (err) {
    if (err instanceof UnknownAgentError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  const mode = modeName;
  if (!agent.supportedModes.includes(mode)) {
    console.error(`Mode "${mode}" not supported by agent "${agent.name}". ` + `Supported: ${agent.supportedModes.join(", ")}.`);
    return 2;
  }
  const cwd = strFlag(args, "workspace") ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  const useCurrent = boolFlag(args, "current");
  if (topicSlug && useCurrent) {
    console.error("Use either --topic <slug> or --current, not both.");
    return 2;
  }
  if (!topicSlug) {
    if (useCurrent) {
      const pointer = readPointer(workspace);
      if (pointer?.current_topic) {
        topicSlug = pointer.current_topic;
        console.error(`[handoff] using current topic from .handoff/current.json: ${topicSlug}`);
      } else {
        const active = getActiveTopics(workspace);
        console.error("No current topic set in .handoff/current.json.");
        if (active.length > 0) {
          console.error("Active topics in this workspace:");
          printTopicList(active);
          console.error("");
          console.error("Pick one with `--topic <slug>` or set a default with `handoff use <slug>`.");
        } else {
          console.error("Pass `--topic <slug>` to create a topic.");
        }
        return 2;
      }
    } else if (process.env[CONTEXT_TOPIC_VAR]) {
      topicSlug = process.env[CONTEXT_TOPIC_VAR];
      console.error(`[handoff] using topic from ${CONTEXT_TOPIC_VAR}: ${topicSlug}`);
    } else {
      const active = getActiveTopics(workspace);
      if (active.length > 0) {
        console.error("No --topic given and no inherited AGENT_HANDOFF_TOPIC. Active topics:");
        printTopicList(active);
        console.error("");
        console.error("Pick one with `--topic <slug>`, inherit via AGENT_HANDOFF_TOPIC,");
        console.error("or explicitly use `.handoff/current.json` with `--current`.");
        console.error("For a fresh thread, pass `--new-topic --topic <fresh-slug>`.");
        return 2;
      }
      console.error("Missing required topic. Pass --topic <slug>, inherit AGENT_HANDOFF_TOPIC, or pass --current.");
      return 2;
    }
  }
  try {
    validateTopic2(topicSlug);
  } catch (err) {
    if (err instanceof TopicSlugError2) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  const existing = loadSnapshot(workspace, topicSlug);
  let snapshot = existing;
  let restorePointerAfterCreate = null;
  let archivedForRollback = null;
  if (existing) {
    if (boolFlag(args, "archive-and-new")) {
      const ptrBefore = readPointer(workspace);
      const pointerWasAimedHere = ptrBefore?.current_topic === topicSlug;
      if (pointerWasAimedHere)
        clearPointer(workspace);
      archivedForRollback = await archiveTopic(workspace, topicSlug, "archive_and_new");
      if (pointerWasAimedHere) {
        restorePointerAfterCreate = topicSlug;
      }
      snapshot = null;
    }
    if (snapshot && requiresResumeConfirmation(snapshot) && !boolFlag(args, "resume")) {
      const ageHours = Math.round((Date.now() - Date.parse(snapshot.last_used_at)) / 3600000);
      console.error(`Topic "${topicSlug}" last used ${ageHours}h ago (>${RESUME_CONFIRM_DAYS2}d). ` + `Pass --resume to confirm intent, or --archive-and-new to start fresh.`);
      return 2;
    }
  } else {
    if (boolFlag(args, "resume")) {
      console.error(`Cannot --resume: topic "${topicSlug}" does not exist yet. Drop the flag to create.`);
      return 2;
    }
    const active = getActiveTopics(workspace);
    if (active.length > 0 && !boolFlag(args, "new-topic")) {
      console.error(`Topic "${topicSlug}" is new but this workspace has active topics already:`);
      printTopicList(active);
      console.error("");
      console.error('If "${topicSlug}" is genuinely a new conceptual thread, pass --new-topic to confirm.'.replace("${topicSlug}", topicSlug));
      console.error("Otherwise pick an existing slug above or `handoff use <slug>`.");
      return 2;
    }
  }
  const wantResume = shouldResumeAgentSession(mode, boolFlag(args, "resume"));
  const sessionId = wantResume ? snapshot?.sessions[agent.name] ?? null : null;
  const noPlan = boolFlag(args, "no-plan");
  const callerAgent = detectCallerAgent();
  const composed = noPlan ? { prompt, injection: null } : composePromptWithPlan(workspace, topicSlug, prompt);
  const priorDepth = process.env[NEST_DEPTH_VAR];
  const priorToken = process.env[NEST_TOKEN_VAR];
  const priorTopic = process.env[CONTEXT_TOPIC_VAR];
  const priorWorkspaceRoot = process.env[CONTEXT_WORKSPACE_ROOT_VAR];
  const priorWorkspaceDir = process.env[CONTEXT_WORKSPACE_DIR_VAR];
  const priorRunId = process.env[CONTEXT_RUN_ID_VAR];
  const priorParentRunId = process.env[CONTEXT_PARENT_RUN_ID_VAR];
  process.env[NEST_DEPTH_VAR] = String(depth + 1);
  process.env[NEST_TOKEN_VAR] = mintNestToken();
  process.env[CONTEXT_TOPIC_VAR] = topicSlug;
  process.env[CONTEXT_WORKSPACE_ROOT_VAR] = workspace.resolvedRoot;
  process.env[CONTEXT_WORKSPACE_DIR_VAR] = workspace.dirName;
  const runId = mintRunId();
  process.env[CONTEXT_RUN_ID_VAR] = runId;
  if (priorRunId)
    process.env[CONTEXT_PARENT_RUN_ID_VAR] = priorRunId;
  else
    delete process.env[CONTEXT_PARENT_RUN_ID_VAR];
  const childEnv = buildChildEnv(boolFlag(args, "clean-env"));
  let livePid = null;
  const sigintForward = () => {
    if (livePid !== null) {
      try {
        process.kill(livePid, "SIGINT");
      } catch {}
    }
  };
  process.on("SIGINT", sigintForward);
  let response;
  let wallMs;
  try {
    const t0 = Date.now();
    response = await agent.invoke({
      topic: topicSlug,
      mode,
      workspaceRoot: workspace.resolvedRoot,
      prompt: composed.prompt,
      sessionId,
      env: childEnv,
      onSpawn: (pid) => {
        livePid = pid;
        const runOpts = { mode, runId };
        if (process.env[CONTEXT_PARENT_RUN_ID_VAR]) {
          runOpts.parentRunId = process.env[CONTEXT_PARENT_RUN_ID_VAR];
        }
        markRunning(workspace, topicSlug, agent.name, pid, runOpts);
      }
    });
    wallMs = Date.now() - t0;
  } finally {
    process.off("SIGINT", sigintForward);
    livePid = null;
    clearRunning(workspace, topicSlug, agent.name, { runId });
    if (priorDepth === undefined)
      delete process.env[NEST_DEPTH_VAR];
    else
      process.env[NEST_DEPTH_VAR] = priorDepth;
    if (priorToken === undefined)
      delete process.env[NEST_TOKEN_VAR];
    else
      process.env[NEST_TOKEN_VAR] = priorToken;
    if (priorTopic === undefined)
      delete process.env[CONTEXT_TOPIC_VAR];
    else
      process.env[CONTEXT_TOPIC_VAR] = priorTopic;
    if (priorWorkspaceRoot === undefined)
      delete process.env[CONTEXT_WORKSPACE_ROOT_VAR];
    else
      process.env[CONTEXT_WORKSPACE_ROOT_VAR] = priorWorkspaceRoot;
    if (priorWorkspaceDir === undefined)
      delete process.env[CONTEXT_WORKSPACE_DIR_VAR];
    else
      process.env[CONTEXT_WORKSPACE_DIR_VAR] = priorWorkspaceDir;
    if (priorRunId === undefined)
      delete process.env[CONTEXT_RUN_ID_VAR];
    else
      process.env[CONTEXT_RUN_ID_VAR] = priorRunId;
    if (priorParentRunId === undefined)
      delete process.env[CONTEXT_PARENT_RUN_ID_VAR];
    else
      process.env[CONTEXT_PARENT_RUN_ID_VAR] = priorParentRunId;
  }
  if (snapshot === null) {
    try {
      await createTopic({
        workspace,
        topic: topicSlug,
        agent: agent.name,
        callerAgent,
        mode,
        summary: strFlag(args, "summary") ?? null,
        promptForAutoSummary: prompt,
        initialSessionId: response.sessionId ?? null
      });
      if (restorePointerAfterCreate) {
        setPointer(workspace, restorePointerAfterCreate);
      }
    } catch (err) {
      if (err instanceof TopicAlreadyExistsError) {
        await recordInvocation({
          workspace,
          topic: topicSlug,
          agent: agent.name,
          callerAgent,
          mode,
          sessionId: response.sessionId,
          verdict: response.verdict,
          durationMs: response.durationMs
        });
      } else if (archivedForRollback) {
        console.error(`[handoff] createTopic failed after agent invocation; rolling archive back: ${err.message}`);
        restoreArchivedTopic(archivedForRollback);
        if (restorePointerAfterCreate) {
          setPointer(workspace, restorePointerAfterCreate);
        }
        throw err;
      } else {
        throw err;
      }
    }
  } else {
    await recordInvocation({
      workspace,
      topic: topicSlug,
      agent: agent.name,
      callerAgent,
      mode,
      sessionId: response.sessionId,
      verdict: response.verdict,
      durationMs: response.durationMs
    });
  }
  if (boolFlag(args, "store-trace")) {
    try {
      const finalSnap = loadSnapshot(workspace, topicSlug);
      const round = finalSnap?.round_count ?? 1;
      writeTrace(workspace, {
        schema_version: 1,
        topic: topicSlug,
        agent: agent.name,
        mode,
        round,
        ts: new Date().toISOString(),
        prompt,
        output: response.output,
        session_id: response.sessionId ?? null,
        verdict: response.verdict,
        duration_ms: response.durationMs
      });
    } catch (err) {
      console.error(`[handoff] warn: failed to write trace: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let planSnapshotPath = null;
  if (boolFlag(args, "snapshot-plan-on-edit") && !noPlan) {
    try {
      const finalSnap = loadSnapshot(workspace, topicSlug);
      const round = finalSnap?.round_count ?? 1;
      const result = snapshotPlanIfChanged(workspace, topicSlug, round);
      if (result.snapshotted)
        planSnapshotPath = result.path;
    } catch (err) {
      console.error(`[handoff] warn: failed to snapshot plan: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  process.stdout.write(response.output);
  if (!response.output.endsWith(`
`))
    process.stdout.write(`
`);
  const planFooter = composed.injection ? ` plan=injected(${composed.injection.sizeBytes}B,${composed.injection.ageString})` : noPlan ? " plan=skipped" : "";
  const snapFooter = planSnapshotPath ? " plan-snapshot=written" : "";
  const envFooter = boolFlag(args, "clean-env") ? " env=clean" : "";
  console.log(`[handoff] topic=${topicSlug} agent=${agent.name} mode=${mode} ` + `session=${response.sessionId ?? "none"} ` + `verdict=${response.verdict} duration_ms=${response.durationMs} wall_ms=${wallMs}` + planFooter + snapFooter + envFooter);
  if (response.verdict === "ok" || response.verdict === "advisory")
    return 0;
  if (response.verdict === "blocked")
    return 1;
  return 1;
}
function cmdList(argv) {
  const args = parseFlags(argv, { string: ["workspace"], boolean: ["stale", "all"] });
  const cwd = strFlag(args, "workspace") ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  const summaries = listTopicSummaries(workspace);
  const filter = boolFlag(args, "stale") ? (s) => s.lifecycle === "stale" : boolFlag(args, "all") ? () => true : (s) => s.lifecycle === "active";
  const visible = summaries.filter(filter);
  if (visible.length === 0) {
    console.log(`(no topics in ${workspace.dirName})`);
    if (summaries.length > 0 && !boolFlag(args, "all")) {
      console.log(`Pass --all to include stale topics (${summaries.length} total).`);
    }
    return 0;
  }
  console.log(`workspace: ${workspace.resolvedRoot}`);
  console.log(`dir:       ${workspaceDir(workspace)}`);
  if (workspace.aliased)
    console.log(`(aliased)`);
  console.log("");
  printTopicList(visible);
  return 0;
}
function printTopicList(summaries) {
  for (const t of summaries) {
    const sessions = Object.entries(t.sessions).filter(([, id]) => id).map(([a, id]) => `${a}=${id.slice(0, 8)}`).join(", ") || "none";
    const tag = t.lifecycle === "stale" ? "[stale]" : "";
    console.log(`  ${t.topic.padEnd(36)} round=${t.roundCount} sessions=[${sessions}] last=${t.lastUsedAt.slice(0, 19)}Z ${tag}`);
    if (t.summary)
      console.log(`    ${t.summary}`);
  }
}
function cmdShow(argv) {
  const args = parseFlags(argv, { string: ["workspace"], _: "topic" });
  const topic = args.positional[0];
  if (!topic) {
    console.error("Usage: handoff show <topic>");
    return 2;
  }
  const cwd = strFlag(args, "workspace") ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  const snap = loadSnapshot(workspace, topic);
  if (!snap) {
    console.error(`Topic "${topic}" not found in this workspace.`);
    return 1;
  }
  console.log(JSON.stringify(snap, null, 2));
  console.log("");
  console.log("--- history ---");
  for (const event of readHistory(workspace, topic)) {
    console.log(JSON.stringify(event));
  }
  return 0;
}
async function cmdArchive(argv) {
  const args = parseFlags(argv, { string: ["workspace"], _: "topic" });
  const topic = args.positional[0];
  if (!topic) {
    console.error("Usage: handoff archive <topic>");
    return 2;
  }
  const cwd = strFlag(args, "workspace") ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  try {
    const result = await archiveTopic(workspace, topic, "manual");
    console.log(`archived: ${result.archivedSnapshot}`);
    console.log(`history:  ${result.archivedHistory}`);
    const pointer = readPointer(workspace);
    if (pointer?.current_topic === topic) {
      clearPointer(workspace);
      console.log(`cleared:  .handoff/current.json (was pointing at ${topic})`);
    }
    return 0;
  } catch (err) {
    if (err instanceof TopicNotFoundError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
}
async function cmdPrune(argv) {
  const args = parseFlags(argv, {
    string: ["workspace", "keep-count", "keep-days", "history-keep"]
  });
  const cwd = strFlag(args, "workspace") ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  const opts = {};
  const keepCountStr = strFlag(args, "keep-count");
  const keepDaysStr = strFlag(args, "keep-days");
  if (keepCountStr)
    opts.keepCount = Number.parseInt(keepCountStr, 10);
  if (keepDaysStr)
    opts.keepDays = Number.parseInt(keepDaysStr, 10);
  const result = pruneArchives(workspace, opts);
  console.log(`removed ${result.removed.length} archive file(s)`);
  for (const path of result.removed)
    console.log(`  ${path}`);
  const histKeepStr = strFlag(args, "history-keep");
  if (histKeepStr) {
    const keep = Number.parseInt(histKeepStr, 10);
    if (!Number.isFinite(keep) || keep < 1) {
      console.error(`--history-keep must be a positive integer (got "${histKeepStr}")`);
      return 2;
    }
    const { trimmed } = await trimActiveHistories(workspace, keep);
    const totalRemoved = trimmed.reduce((acc, t) => acc + t.removed, 0);
    console.log(`trimmed ${trimmed.length} history file(s), removed ${totalRemoved} line(s)`);
    for (const t of trimmed)
      console.log(`  ${t.topic}: removed ${t.removed}, kept ${t.kept}`);
  }
  return 0;
}
function cmdUse(argv) {
  const args = parseFlags(argv, { string: ["workspace"], _: "topic" });
  const topic = args.positional[0];
  if (!topic) {
    console.error("Usage: handoff use <topic>");
    return 2;
  }
  try {
    validateTopic2(topic);
  } catch (err) {
    if (err instanceof TopicSlugError2) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  const cwd = strFlag(args, "workspace") ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  if (!loadSnapshot(workspace, topic)) {
    console.error(`Note: topic "${topic}" doesn't exist yet in this workspace. ` + `Pointer set anyway; first \`handoff send --current\` will create it.`);
  }
  setPointer(workspace, topic);
  console.log(`Current topic for ${workspace.basename}: ${topic}`);
  return 0;
}
function cmdClear(argv) {
  const args = parseFlags(argv, { string: ["workspace"] });
  const cwd = strFlag(args, "workspace") ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  clearPointer(workspace);
  console.log(`Cleared current topic pointer for ${workspace.basename}.`);
  return 0;
}
function cmdStatus(argv) {
  const args = parseFlags(argv, { string: ["workspace"] });
  const cwd = strFlag(args, "workspace") ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  const pointer = readPointer(workspace);
  const summaries = listTopicSummaries(workspace);
  const active = summaries.filter((s) => s.lifecycle === "active");
  const stale = summaries.filter((s) => s.lifecycle === "stale");
  console.log(`workspace: ${workspace.resolvedRoot}`);
  console.log(`dir:       ${workspaceDir(workspace)}${workspace.aliased ? " (aliased)" : ""}`);
  console.log(`current:   ${pointer?.current_topic ?? "(none \u2014 set with `handoff use <slug>`)"}`);
  console.log("");
  if (active.length > 0) {
    console.log(`active topics (${active.length}):`);
    printTopicList(active);
  } else {
    console.log("(no active topics)");
  }
  if (stale.length > 0) {
    console.log("");
    console.log(`stale topics (${stale.length}):`);
    printTopicList(stale);
  }
  const running = listRunning(workspace);
  if (running.length > 0) {
    console.log("");
    console.log(`running rounds (${running.length}):`);
    for (const r of running) {
      console.log(`  ${r.topic.padEnd(36)} agent=${r.agent} pid=${r.pid} run=${r.run_id} started=${r.started_at}`);
    }
  }
  return 0;
}
function cmdDoctor(argv) {
  const args = parseFlags(argv, { string: ["workspace"] });
  const cwd = strFlag(args, "workspace") ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  const pointer = readPointer(workspace);
  const aliases = listAliases();
  console.log("agent-handoff doctor");
  console.log("==================");
  console.log("");
  console.log("binaries on PATH");
  for (const bin of ["bun", "node", "git", "claude", "codex", "cursor-agent"]) {
    const found = whichVersion(bin);
    console.log(`  ${bin.padEnd(14)} ${found ? `${found.path}  (${found.version})` : "(not found)"}`);
  }
  if (whichVersion("git") === null) {
    console.log("  \u26A0 git missing \u2014 every cwd inside a repo gets its own workspace hash. " + "Topics fragment instead of sharing state across worktrees / subdirs.");
  }
  console.log("");
  console.log("environment");
  console.log(`  cwd:                ${process.cwd()}`);
  console.log(`  AGENT_HANDOFF_DEPTH:  ${process.env[NEST_DEPTH_VAR] ?? "(unset)"}`);
  console.log(`  AGENT_HANDOFF_TOKEN:  ${process.env[NEST_TOKEN_VAR] ? "(set)" : "(unset)"}`);
  console.log(`  AGENT_HANDOFF_TOPIC:  ${process.env[CONTEXT_TOPIC_VAR] ?? "(unset)"}`);
  console.log(`  AGENT_HANDOFF_RUN_ID: ${process.env[CONTEXT_RUN_ID_VAR] ?? "(unset)"}`);
  console.log(`  XDG_DATA_HOME:      ${process.env.XDG_DATA_HOME ?? "(unset; using ~/.local/share)"}`);
  console.log(`  state dir:          ${resolveStateDir2()}`);
  console.log("");
  console.log("workspace resolution");
  console.log(`  resolvedRoot:       ${workspace.resolvedRoot}`);
  console.log(`  basename:           ${workspace.basename}`);
  console.log(`  hash:               ${workspace.hash}`);
  console.log(`  dirName:            ${workspace.dirName}`);
  console.log(`  fromGit:            ${workspace.fromGit}`);
  console.log(`  gitProbe:           ${workspace.gitProbe}`);
  console.log(`  aliased:            ${workspace.aliased}`);
  console.log("");
  console.log("pointer");
  if (pointer) {
    console.log(`  set_at:             ${pointer.set_at}`);
    console.log(`  current_topic:      ${pointer.current_topic ?? "(null)"}`);
    console.log(`  workspace_hash:     ${pointer.workspace_hash}`);
  } else {
    console.log("  (no pointer file at .handoff/current.json)");
  }
  console.log("");
  console.log("aliases");
  if (Object.keys(aliases).length === 0) {
    console.log("  (none)");
  } else {
    for (const [path, hash] of Object.entries(aliases)) {
      console.log(`  ${path} \u2192 ${hash}`);
    }
  }
  console.log("");
  console.log("agent adapters");
  for (const [name, adapter] of Object.entries(AGENTS)) {
    console.log(`  ${name.padEnd(8)} resume=${adapter.supportsResume} modes=[${adapter.supportedModes.join(",")}]`);
  }
  return 0;
}
function cmdAlias(argv) {
  const args = parseFlags(argv, {
    string: ["path", "hash"],
    boolean: ["list", "remove", "suggest"],
    _: "action"
  });
  if (boolFlag(args, "suggest")) {
    const candidates = suggestMovedWorkspaces();
    if (candidates.length === 0) {
      console.log("(no moved-workspace candidates detected)");
      return 0;
    }
    console.log("Workspaces with topics whose recorded path no longer exists.");
    console.log("Candidates for `handoff alias <new-path> <hash>`:");
    console.log("");
    for (const c of candidates) {
      console.log(`  hash=${c.hash}  topics=${c.topicCount}  last=${c.lastUsedAt ?? "?"}`);
      console.log(`    recorded root: ${c.recordedRoot}`);
      console.log(`    suggested:     handoff alias <new-resolved-path> ${c.hash}`);
      console.log("");
    }
    return 0;
  }
  if (boolFlag(args, "list") || args.positional.length === 0) {
    const aliases = listAliases();
    if (Object.keys(aliases).length === 0) {
      console.log("(no aliases)");
      return 0;
    }
    for (const [path2, hash2] of Object.entries(aliases)) {
      console.log(`${path2} \u2192 ${hash2}`);
    }
    return 0;
  }
  if (boolFlag(args, "remove")) {
    const path2 = args.positional[0];
    if (!path2) {
      console.error("Usage: handoff alias --remove <resolved-path>");
      return 2;
    }
    const removed = removeAlias(path2);
    console.log(removed ? `removed alias for ${path2}` : `(no alias for ${path2})`);
    return 0;
  }
  const path = args.positional[0];
  const hash = args.positional[1];
  if (!path || !hash) {
    console.error(`Usage:
` + `  handoff alias <resolved-path> <workspace-hash>   add
` + `  handoff alias --list                             list
` + "  handoff alias --remove <resolved-path>           remove");
    return 2;
  }
  if (!/^[0-9a-f]{12}$/i.test(hash)) {
    console.error(`Invalid hash "${hash}" \u2014 must be 12 hex chars.`);
    return 2;
  }
  setAlias(path, hash.toLowerCase());
  console.log(`alias: ${path} \u2192 ${hash.toLowerCase()}`);
  return 0;
}
async function cmdResetSession(argv) {
  const args = parseFlags(argv, {
    string: ["agent", "workspace", "reason"],
    _: "topic"
  });
  const topic = args.positional[0];
  if (!topic) {
    console.error("Usage: handoff reset-session <topic> --agent <name> [--reason manual|expired|crashed]");
    return 2;
  }
  const agentName = strFlag(args, "agent");
  if (!agentName) {
    console.error("Missing required --agent");
    return 2;
  }
  if (agentName !== "claude" && agentName !== "codex" && agentName !== "cursor") {
    console.error(`Unknown agent "${agentName}". Supported: claude, codex, cursor.`);
    return 2;
  }
  const reasonStr = strFlag(args, "reason") ?? "manual";
  if (reasonStr !== "manual" && reasonStr !== "expired" && reasonStr !== "crashed") {
    console.error(`Invalid --reason "${reasonStr}". Must be manual | expired | crashed.`);
    return 2;
  }
  const cwd = strFlag(args, "workspace") ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  try {
    const result = await resetSession(workspace, topic, agentName, reasonStr);
    if (result.previousSessionId === null) {
      console.log(`(${agentName} session for ${topic} was already null; no-op)`);
    } else {
      console.log(`reset ${agentName} session for ${topic} (was ${result.previousSessionId.slice(0, 8)}\u2026)`);
      console.log(`Next consult/debug round will mint a fresh session.`);
    }
    return 0;
  } catch (err) {
    if (err instanceof TopicNotFoundError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
}
async function cmdTail(argv) {
  const args = parseFlags(argv, {
    string: ["workspace"],
    boolean: ["from-start"]
  });
  const topic = args.positional[0];
  if (!topic) {
    console.error("Usage: handoff tail <topic> [--from-start]");
    return 2;
  }
  try {
    validateTopic2(topic);
  } catch (err) {
    if (err instanceof TopicSlugError2) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  const cwd = strFlag(args, "workspace") ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  const file = join21(workspaceDir(workspace), `${topic}.history.jsonl`);
  let offset = 0;
  if (boolFlag(args, "from-start")) {
    offset = 0;
  } else {
    try {
      offset = statSync6(file).size;
    } catch {
      offset = 0;
    }
  }
  offset = await tailFlush(file, offset);
  console.error(`[handoff] tailing ${topic} (Ctrl-C to stop)`);
  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
  });
  while (!stop) {
    await new Promise((r) => setTimeout(r, 500));
    offset = await tailFlush(file, offset);
  }
  return 0;
}
function cmdCancel(argv) {
  const args = parseFlags(argv, { string: ["agent", "run-id", "signal", "workspace"] });
  const topic = args.positional[0];
  if (!topic) {
    console.error("Usage: handoff cancel <topic> [--agent <name>] [--run-id <id>] [--signal SIGINT|SIGTERM|SIGKILL]");
    return 2;
  }
  try {
    validateTopic2(topic);
  } catch (err) {
    if (err instanceof TopicSlugError2) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  const cwd = strFlag(args, "workspace") ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  const sigRaw = strFlag(args, "signal") ?? "SIGINT";
  const allowedSignals = ["SIGINT", "SIGTERM", "SIGKILL", "SIGHUP"];
  if (!allowedSignals.includes(sigRaw)) {
    console.error(`--signal must be one of ${allowedSignals.join(", ")} (got "${sigRaw}")`);
    return 2;
  }
  const signal = sigRaw;
  const explicitAgent = strFlag(args, "agent");
  const runIdFilter = strFlag(args, "run-id");
  let target;
  const runningForTopic = listRunning(workspace).filter((r) => r.topic === topic);
  if (explicitAgent) {
    let resolved;
    try {
      resolved = resolveAgent(explicitAgent);
    } catch (err) {
      if (err instanceof UnknownAgentError) {
        console.error(err.message);
        return 2;
      }
      throw err;
    }
    const matches = runningForTopic.filter((r) => r.agent === resolved.name && (!runIdFilter || r.run_id === runIdFilter));
    const selected = selectRunningTarget(matches, topic, runIdFilter);
    if (!selected)
      return matches.length > 1 ? 2 : 1;
    target = { agent: selected.agent, pid: selected.pid, runId: selected.run_id };
  } else {
    const matches = runningForTopic.filter((r) => !runIdFilter || r.run_id === runIdFilter);
    const selected = selectRunningTarget(matches, topic, runIdFilter);
    if (!selected)
      return matches.length > 1 ? 2 : 1;
    target = { agent: selected.agent, pid: selected.pid, runId: selected.run_id };
  }
  const result = cancelRunning(workspace, topic, target.agent, signal, { runId: target.runId });
  if (!result.delivered) {
    console.error(`Failed to deliver ${signal} to ${target.agent} pid=${target.pid}.`);
    return 1;
  }
  console.log(`Sent ${signal} to ${target.agent} pid=${target.pid} run=${target.runId} (topic=${topic}).`);
  return 0;
}
function selectRunningTarget(matches, topic, runIdFilter) {
  if (matches.length === 0) {
    console.error(runIdFilter ? `No running round for "${topic}" with run_id=${runIdFilter}.` : `No running rounds for "${topic}".`);
    return null;
  }
  if (matches.length > 1) {
    console.error(`Multiple running rounds for "${topic}":`);
    for (const r of matches) {
      console.error(`  ${r.agent.padEnd(8)} pid=${r.pid} run=${r.run_id} started=${r.started_at}`);
    }
    console.error("Pass --agent <name> and/or --run-id <id> to disambiguate.");
    return null;
  }
  return matches[0];
}
async function cmdWatch(argv) {
  const args = parseFlags(argv, {
    string: ["workspace", "agent"],
    boolean: ["from-start"]
  });
  const topic = args.positional[0];
  if (!topic) {
    console.error("Usage: handoff watch <topic> [--agent <name>] [--from-start]");
    return 2;
  }
  try {
    validateTopic2(topic);
  } catch (err) {
    if (err instanceof TopicSlugError2) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  const cwd = strFlag(args, "workspace") ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  const snapshot = loadSnapshot(workspace, topic);
  if (!snapshot) {
    console.error(`Topic "${topic}" not found in this workspace.`);
    return 1;
  }
  const filterAgent = strFlag(args, "agent");
  const targets = [];
  for (const [agentName, sessionId] of Object.entries(snapshot.sessions)) {
    if (filterAgent && agentName !== filterAgent)
      continue;
    if (!sessionId) {
      console.error(`[handoff] ${agentName}: no session id recorded for "${topic}"`);
      continue;
    }
    const res = resolveLocalSession(agentName, sessionId, workspace.resolvedRoot);
    if (res.kind === "file") {
      console.error(`[handoff] ${agentName}: tailing ${res.path}`);
      targets.push({ agent: agentName, path: res.path, kind: "file" });
    } else if (res.kind === "sqlite-cursor") {
      console.error(`[handoff] ${agentName}: polling sqlite ${res.path}`);
      targets.push({ agent: agentName, path: res.path, kind: "sqlite-cursor" });
    } else {
      console.error(`[handoff] ${agentName}: ${res.reason}`);
    }
  }
  if (targets.length === 0) {
    console.error("Nothing to tail.");
    return 1;
  }
  const offsets = new Map;
  const cursorRoots = new Map;
  for (const t of targets) {
    if (t.kind === "file") {
      let size = 0;
      try {
        size = boolFlag(args, "from-start") ? 0 : statSync6(t.path).size;
      } catch {
        size = 0;
      }
      offsets.set(t.path, size);
    } else {
      cursorRoots.set(t.path, boolFlag(args, "from-start") ? null : "PRIME");
    }
  }
  for (const t of targets) {
    if (t.kind === "file") {
      const next = await tailRaw(t.path, offsets.get(t.path) ?? 0, t.agent);
      offsets.set(t.path, next);
    } else {
      if (cursorRoots.get(t.path) === "PRIME") {
        const r = readCursorChat(t.path);
        cursorRoots.set(t.path, r.rootBlobId);
      } else {
        const r = readCursorChat(t.path);
        for (const w of r.warnings)
          console.error(`[handoff] ${t.agent}: ${w}`);
        for (const turn of r.turns)
          printCursorTurn(t.agent, turn);
        cursorRoots.set(t.path, r.rootBlobId);
      }
    }
  }
  console.error("[handoff] watching (Ctrl-C to stop)");
  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
  });
  while (!stop) {
    await new Promise((r) => setTimeout(r, 500));
    for (const t of targets) {
      if (t.kind === "file") {
        const next = await tailRaw(t.path, offsets.get(t.path) ?? 0, t.agent);
        offsets.set(t.path, next);
      } else {
        const seenRoot = cursorRoots.get(t.path) ?? null;
        const r = readCursorChat(t.path, { sinceRootBlobId: seenRoot });
        if (r.rootBlobId !== seenRoot) {
          for (const w of r.warnings)
            console.error(`[handoff] ${t.agent}: ${w}`);
          for (const turn of r.turns)
            printCursorTurn(t.agent, turn);
          cursorRoots.set(t.path, r.rootBlobId);
        }
      }
    }
  }
  return 0;
}
function printCursorTurn(agent, turn) {
  const text = turn.text.length > 200 ? `${turn.text.slice(0, 197)}\u2026` : turn.text;
  console.log(`[${agent}] ${turn.role.padEnd(10)} ${text || "(no body)"}`);
}
async function tailRaw(file, fromOffset, agent) {
  let size;
  try {
    size = statSync6(file).size;
  } catch {
    return fromOffset;
  }
  if (size <= fromOffset)
    return fromOffset;
  const fd = openSync2(file, "r");
  try {
    const length = size - fromOffset;
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, fromOffset);
    const text = buf.toString("utf-8");
    for (const line of text.split(`
`)) {
      const trimmed = line.trim();
      if (!trimmed)
        continue;
      printAgentTranscriptLine(agent, trimmed);
    }
    return size;
  } finally {
    closeSync2(fd);
  }
}
function printAgentTranscriptLine(agent, line) {
  const turn = parseTurn2(line);
  if (!turn)
    return;
  const ts = turn.ts ? `${turn.ts.replace("T", " ").replace(/\.\d+Z$/, "Z")}  ` : "";
  const text = turn.text.length > 200 ? `${turn.text.slice(0, 197)}\u2026` : turn.text;
  console.log(`[${agent}] ${ts}${turn.role.padEnd(10)} ${text || "(no body)"}`);
}
function cmdHistory(argv) {
  const args = parseFlags(argv, {
    string: ["workspace", "agent", "last", "format"],
    boolean: ["full", "no-tools", "skip-system", "stats"]
  });
  const topic = args.positional[0];
  if (!topic) {
    console.error(`Usage: handoff history <topic> [--agent <name>] [--last N] [--full]
` + `                          [--format compact|json|raw] [--no-tools]
` + "                          [--skip-system] [--stats]");
    return 2;
  }
  try {
    validateTopic2(topic);
  } catch (err) {
    if (err instanceof TopicSlugError2) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  const cwd = strFlag(args, "workspace") ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  const snapshot = loadSnapshot(workspace, topic);
  if (!snapshot) {
    console.error(`Topic "${topic}" not found in this workspace.`);
    return 1;
  }
  const last = Number.parseInt(strFlag(args, "last") ?? "20", 10);
  if (!Number.isFinite(last) || last < 1) {
    console.error(`--last must be a positive integer (got "${strFlag(args, "last")}")`);
    return 2;
  }
  const formatRaw = strFlag(args, "format") ?? (boolFlag(args, "full") ? "json" : "compact");
  if (!["compact", "json", "raw"].includes(formatRaw)) {
    console.error(`--format must be compact|json|raw (got "${formatRaw}")`);
    return 2;
  }
  const format = formatRaw;
  const filterAgent = strFlag(args, "agent");
  const sessions = Object.entries(snapshot.sessions);
  let exitCode = 0;
  for (const [agentName, sessionId] of sessions) {
    if (filterAgent && agentName !== filterAgent)
      continue;
    if (!sessionId) {
      console.log(`# ${agentName}: (no session id recorded)
`);
      continue;
    }
    const res = resolveLocalSession(agentName, sessionId, workspace.resolvedRoot);
    if (res.kind === "unsupported" || res.kind === "missing") {
      console.log(`# ${agentName} (${sessionId}): ${res.reason}
`);
      continue;
    }
    console.log(`# ${agentName} (${sessionId})`);
    console.log(`# ${res.path}`);
    console.log("");
    let turns;
    if (res.kind === "sqlite-cursor") {
      const result = readCursorChat(res.path);
      for (const w of result.warnings)
        console.error(`[handoff] cursor: ${w}`);
      if (format === "raw") {
        for (const t of result.turns)
          console.log(JSON.stringify(t.raw));
        console.log("");
        continue;
      }
      turns = result.turns.map(cursorTurnToTranscript2);
    } else {
      if (format === "raw") {
        try {
          process.stdout.write(readFileSync13(res.path, "utf-8"));
        } catch (err) {
          console.error(`failed to read ${res.path}: ${err.message}`);
          exitCode = 1;
        }
        continue;
      }
      let lines;
      try {
        lines = readFileSync13(res.path, "utf-8").split(`
`).filter((l) => l.length > 0);
      } catch (err) {
        console.error(`failed to read ${res.path}: ${err.message}`);
        exitCode = 1;
        continue;
      }
      turns = lines.map((l) => parseTurn2(l)).filter((t) => t !== null);
    }
    const filtered = turns.filter((t) => {
      if (boolFlag(args, "no-tools") && isToolTurn2(t))
        return false;
      if (boolFlag(args, "skip-system") && isSystemTurn(t))
        return false;
      return true;
    });
    if (boolFlag(args, "stats")) {
      printStats(filtered);
      console.log("");
      continue;
    }
    const tail = filtered.slice(-last);
    for (const turn of tail) {
      printTurn(turn, format, boolFlag(args, "full"));
    }
    console.log("");
  }
  return exitCode;
}
function printStats(turns) {
  const byRole = new Map;
  const byTool = new Map;
  for (const t of turns) {
    byRole.set(t.role, (byRole.get(t.role) ?? 0) + 1);
    if (isToolTurn2(t)) {
      const m = /^([\w.-]+)\s*\(/.exec(t.text);
      const name = m?.[1] ?? "(unknown)";
      byTool.set(name, (byTool.get(name) ?? 0) + 1);
    }
  }
  const total = turns.length;
  console.log(`turns: ${total}`);
  for (const [role, n] of [...byRole.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${role.padEnd(12)} ${n}`);
  }
  if (byTool.size > 0) {
    const top = [...byTool.entries()].sort((a, b) => b[1] - a[1]);
    const summary = top.map(([name, n]) => `${name}\xD7${n}`).join(", ");
    console.log(`tool calls: ${summary}`);
  }
}
function printTurn(turn, format, full) {
  if (format === "json") {
    console.log(JSON.stringify(turn.raw));
    return;
  }
  const ts = turn.ts ? `${turn.ts.replace("T", " ").replace(/\.\d+Z$/, "Z")}  ` : "";
  const limit = full ? Number.POSITIVE_INFINITY : 200;
  const body = turn.text.length > limit ? `${turn.text.slice(0, limit - 1)}\u2026` : turn.text || "(no body)";
  console.log(`${ts}${turn.role.padEnd(10)} ${body}`);
}
async function tailFlush(file, fromOffset) {
  let size;
  try {
    size = statSync6(file).size;
  } catch {
    return fromOffset;
  }
  if (size <= fromOffset)
    return fromOffset;
  const fd = openSync2(file, "r");
  try {
    const length = size - fromOffset;
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, fromOffset);
    const text = buf.toString("utf-8");
    for (const line of text.split(`
`)) {
      const trimmed = line.trim();
      if (!trimmed)
        continue;
      try {
        const event = JSON.parse(trimmed);
        printEvent(event);
      } catch {}
    }
    return size;
  } finally {
    closeSync2(fd);
  }
}
function printEvent(e) {
  const ts = e.ts.replace("T", " ").replace(/\.\d+Z$/, "Z");
  if (e.kind === "invocation") {
    console.log(`${ts}  round=${e.round} agent=${e.agent} mode=${e.mode} ` + `verdict=${e.verdict} duration=${e.duration_ms ?? "?"}ms ` + `session=${e.session_id ?? "none"}`);
  } else if (e.kind === "created") {
    console.log(`${ts}  CREATED agent=${e.agent} mode=${e.mode} ` + `session=${e.session_id ?? "none"} summary=${e.summary ?? "(none)"}`);
  } else if (e.kind === "archived") {
    console.log(`${ts}  ARCHIVED reason=${e.reason}`);
  } else if (e.kind === "session_reset") {
    console.log(`${ts}  RESET agent=${e.agent} reason=${e.reason} ` + `was=${e.previous_session_id ?? "none"}`);
  }
}
function cmdLog(argv) {
  const args = parseFlags(argv, {
    string: ["since", "workspace"],
    boolean: ["all-workspaces"]
  });
  const sinceFlag = strFlag(args, "since") ?? "1d";
  const cutoffMs = parseSince(sinceFlag);
  if (cutoffMs === null) {
    console.error(`Invalid --since "${sinceFlag}". Format: <N>{m,h,d} (e.g. 30m, 2h, 7d).`);
    return 2;
  }
  const cutoff = Date.now() - cutoffMs;
  const cwd = strFlag(args, "workspace") ?? process.cwd();
  const allWorkspaces = boolFlag(args, "all-workspaces");
  const entries = [];
  const workspaceDirs = allWorkspaces ? listAllWorkspaceDirs() : [resolveWorkspace(cwd).dirName];
  const sessionsRoot = join21(resolveStateDir2(), "sessions");
  for (const wsDirName of workspaceDirs) {
    const dir = join21(sessionsRoot, wsDirName);
    let names;
    try {
      names = readdirSync11(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".history.jsonl"))
        continue;
      const topic = name.slice(0, -".history.jsonl".length);
      const path = join21(dir, name);
      let raw;
      try {
        raw = readFileSync13(path, "utf-8");
      } catch {
        continue;
      }
      for (const line of raw.split(`
`)) {
        const trimmed = line.trim();
        if (!trimmed)
          continue;
        try {
          const event = JSON.parse(trimmed);
          if (Date.parse(event.ts) >= cutoff) {
            entries.push({ event, topic, workspace: wsDirName });
          }
        } catch {}
      }
    }
  }
  entries.sort((a, b) => Date.parse(a.event.ts) - Date.parse(b.event.ts));
  if (entries.length === 0) {
    console.log(`(no events in last ${sinceFlag})`);
    return 0;
  }
  for (const { event, topic, workspace } of entries) {
    const ts = event.ts.replace("T", " ").replace(/\.\d+Z$/, "Z");
    const wsTag = allWorkspaces ? `${workspace}/` : "";
    if (event.kind === "invocation") {
      console.log(`${ts}  ${wsTag}${topic}  round=${event.round} ${event.agent}/${event.mode} ` + `verdict=${event.verdict} ${event.duration_ms ?? "?"}ms`);
    } else if (event.kind === "created") {
      console.log(`${ts}  ${wsTag}${topic}  CREATED by ${event.agent}/${event.mode}`);
    } else if (event.kind === "archived") {
      console.log(`${ts}  ${wsTag}${topic}  ARCHIVED (${event.reason})`);
    } else if (event.kind === "session_reset") {
      console.log(`${ts}  ${wsTag}${topic}  RESET ${event.agent} (${event.reason})`);
    }
  }
  return 0;
}
async function cmdUi(argv) {
  const args = parseFlags(argv, {
    string: ["workspace", "host", "port"],
    boolean: ["open", "all-workspaces", "unsafe-host", "no-transcripts", "include-transcripts"]
  });
  const cwd = strFlag(args, "workspace") ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  const allWorkspaces = boolFlag(args, "all-workspaces");
  const host = strFlag(args, "host") ?? "127.0.0.1";
  const portRaw = strFlag(args, "port") ?? "17345";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    console.error(`--port must be 0..65535 (got "${portRaw}")`);
    return 2;
  }
  return startUiServer({
    workspace,
    allWorkspaces,
    host,
    port,
    open: boolFlag(args, "open"),
    unsafeHost: boolFlag(args, "unsafe-host"),
    noTranscripts: boolFlag(args, "no-transcripts"),
    includeTranscripts: boolFlag(args, "include-transcripts"),
    buildSnapshot: (options) => buildUiSnapshot(workspace, options)
  });
}
async function cmdPlan(argv) {
  const args = parseFlags(argv, {
    string: ["workspace", "diff", "export", "set", "set-file"],
    boolean: ["edit", "path", "inspect", "history", "delete"]
  });
  const topic = args.positional[0];
  if (!topic) {
    console.error("Usage: handoff plan <topic> [--edit | --path | --inspect | --history | " + "--diff R1..R2 | --export <path> | --set <text> | --set-file <path> | --delete]");
    return 2;
  }
  try {
    validateTopic2(topic);
  } catch (err) {
    if (err instanceof TopicSlugError2) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  const cwd = strFlag(args, "workspace") ?? process.cwd();
  const workspace = resolveWorkspace(cwd);
  if (boolFlag(args, "edit")) {
    return cmdPlanEdit(workspace, topic);
  }
  const setText = strFlag(args, "set");
  if (typeof setText === "string") {
    writePlan(workspace, topic, setText.endsWith(`
`) ? setText : `${setText}
`);
    console.error(`[handoff] wrote plan: ${planPath(workspace, topic)}`);
    return 0;
  }
  const setFile = strFlag(args, "set-file");
  if (setFile) {
    if (!existsSync18(setFile)) {
      console.error(`File not found: ${setFile}`);
      return 2;
    }
    const body = readFileSync13(setFile, "utf-8");
    writePlan(workspace, topic, body);
    console.error(`[handoff] wrote plan: ${planPath(workspace, topic)} (from ${setFile})`);
    return 0;
  }
  if (boolFlag(args, "delete")) {
    const path = planPath(workspace, topic);
    if (existsSync18(path)) {
      unlinkSync5(path);
      console.error(`[handoff] deleted plan: ${path}`);
    } else {
      console.error(`(no plan to delete at ${path})`);
    }
    return 0;
  }
  const exportPath = strFlag(args, "export");
  if (exportPath) {
    const state2 = readPlan(workspace, topic);
    if (state2.content === null) {
      console.error(`(no plan exists for topic ${topic})`);
      return 1;
    }
    new AtomicFile2(exportPath).write(state2.content);
    console.error(`[handoff] exported plan to ${exportPath}`);
    return 0;
  }
  if (boolFlag(args, "path")) {
    process.stdout.write(`${planPath(workspace, topic)}
`);
    return 0;
  }
  if (boolFlag(args, "history")) {
    const rounds = listPlanHistoryRounds(workspace, topic);
    if (rounds.length === 0) {
      console.log("(no plan history; pass --snapshot-plan-on-edit to handoff send to capture)");
      return 0;
    }
    for (const r of rounds) {
      console.log(`round ${r}`);
    }
    return 0;
  }
  const diffSpec = strFlag(args, "diff");
  if (diffSpec) {
    const m = /^(\d+)\.\.(\d+)$/.exec(diffSpec);
    if (!m) {
      console.error(`--diff format: <round>..<round>, got ${diffSpec}`);
      return 2;
    }
    const r1 = Number.parseInt(m[1], 10);
    const r2 = Number.parseInt(m[2], 10);
    const a = readPlanSnapshot(workspace, topic, r1);
    const b = readPlanSnapshot(workspace, topic, r2);
    if (a === null || b === null) {
      console.error(`one or both snapshots missing: r1=${r1} r2=${r2}`);
      return 1;
    }
    const tmp1 = `/tmp/handoff-plan-${topic}-${r1}.md`;
    const tmp2 = `/tmp/handoff-plan-${topic}-${r2}.md`;
    writeFileSync7(tmp1, a, "utf-8");
    writeFileSync7(tmp2, b, "utf-8");
    spawnSync5("git", ["--no-pager", "diff", "--no-index", "--", tmp1, tmp2], {
      stdio: "inherit"
    });
    return 0;
  }
  if (boolFlag(args, "inspect")) {
    const state2 = readPlan(workspace, topic);
    if (state2.content === null) {
      console.log(`(no plan to inject for topic ${topic})`);
      return 0;
    }
    const composed = composePromptWithPlan(workspace, topic, "<USER_PROMPT_GOES_HERE>");
    process.stdout.write(composed.prompt);
    if (!composed.prompt.endsWith(`
`))
      process.stdout.write(`
`);
    return 0;
  }
  const state = readPlan(workspace, topic);
  if (state.content === null) {
    console.log(`(no plan for topic ${topic}; create with --edit or --set or --set-file)`);
    return 0;
  }
  process.stdout.write(state.content);
  if (!state.content.endsWith(`
`))
    process.stdout.write(`
`);
  console.error(`[handoff] ${planPath(workspace, topic)} (last edited ${formatAge(state.lastModified)})`);
  return 0;
}
function cmdPlanEdit(workspace, topic) {
  const path = planPath(workspace, topic);
  if (!existsSync18(path)) {
    writePlan(workspace, topic, "");
  }
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
  const result = spawnSync5(editor, [path], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`[handoff] editor exited with code ${result.status}`);
    return result.status ?? 1;
  }
  return 0;
}
function readPrompt(file, inline) {
  if (inline && inline.length > 0)
    return inline;
  if (file && existsSync18(file))
    return readFileSync13(file, "utf-8");
  if (!process.stdin.isTTY) {
    try {
      return readFileSync13(0, "utf-8");
    } catch {
      return null;
    }
  }
  return null;
}
var CLEAN_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "WINDIR"
]);
function buildChildEnv(clean) {
  if (!clean)
    return process.env;
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined)
      continue;
    if (key.startsWith("AGENT_HANDOFF_") || key.startsWith("LC_") || CLEAN_ENV_KEYS.has(key)) {
      env[key] = value;
    }
  }
  return env;
}
function strFlag(p, key) {
  const v = p.flags[key];
  return typeof v === "string" ? v : undefined;
}
function boolFlag(p, key) {
  return p.flags[key] === true;
}

class UnknownFlagError extends Error {
  flag;
  known;
  constructor(flag, known) {
    const suggestion = closest(flag, known);
    const hint = suggestion ? ` Did you mean --${suggestion}?` : "";
    super(`Unknown flag --${flag}.${hint}`);
    this.flag = flag;
    this.known = known;
    this.name = "UnknownFlagError";
  }
}
function parseFlags(argv, spec) {
  const flags = {};
  const positional = [];
  const stringSet = new Set(spec.string ?? []);
  const boolSet = new Set(spec.boolean ?? []);
  const known = [...stringSet, ...boolSet];
  for (let i = 0;i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      const key = eqIdx >= 0 ? token.slice(2, eqIdx) : token.slice(2);
      const valueInline = eqIdx >= 0 ? token.slice(eqIdx + 1) : null;
      if (boolSet.has(key)) {
        flags[key] = valueInline === null ? true : valueInline !== "false";
      } else if (stringSet.has(key)) {
        if (valueInline !== null) {
          flags[key] = valueInline;
        } else {
          const next = argv[i + 1];
          if (next !== undefined && !next.startsWith("--")) {
            flags[key] = next;
            i++;
          }
        }
      } else {
        throw new UnknownFlagError(key, known);
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}
function closest(target, candidates) {
  let best = null;
  for (const c of candidates) {
    const d = levenshtein(target, c);
    if (d > 2)
      continue;
    if (best === null || d < best.dist)
      best = { name: c, dist: d };
  }
  return best?.name ?? null;
}
function whichVersion(bin) {
  const which = spawnSync5("which", [bin], { encoding: "utf-8" });
  if (which.status !== 0)
    return null;
  const path = which.stdout.trim();
  if (!path)
    return null;
  const ver = spawnSync5(bin, ["--version"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  const version = (ver.stdout || ver.stderr).split(`
`)[0]?.trim() ?? "";
  return { path, version: version || "(no --version output)" };
}
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0)
    return n;
  if (n === 0)
    return m;
  const dp = new Array(n + 1);
  for (let j = 0;j <= n; j++)
    dp[j] = j;
  for (let i = 1;i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1;j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}
function printUsage() {
  console.log(`agent-handoff \u2014 hand work between CLI agents with topic-pinned continuity

Usage:
  handoff send --agent <name> --mode <mode> [--topic <slug>|--current] [options]
  handoff list [--all|--stale] [--workspace <path>]
  handoff show <topic> [--workspace <path>]
  handoff status [--workspace <path>]
  handoff use <topic> [--workspace <path>]
  handoff clear [--workspace <path>]
  handoff archive <topic> [--workspace <path>]
  handoff reset-session <topic> --agent <name> [--reason ...]
  handoff prune [--keep-count N] [--keep-days N] [--workspace <path>]
  handoff alias <resolved-path> <hash> | --list | --remove <path> | --suggest
  handoff doctor [--workspace <path>]
  handoff ui [--workspace <path>] [--all-workspaces]
           [--host 127.0.0.1] [--port 17345] [--no-transcripts]
  handoff tail <topic> [--from-start] [--workspace <path>]
  handoff log [--since 1d] [--all-workspaces] [--workspace <path>]
  handoff watch <topic> [--agent <name>] [--from-start] [--workspace <path>]
  handoff history <topic> [--agent <name>] [--last N] [--full|--stats]
  handoff cancel <topic> [--agent <name>] [--run-id <id>]
               [--signal SIGINT|SIGTERM|SIGKILL]
  handoff plan <topic> [--edit|--path|--inspect|--history|--diff R1..R2|
                      --export <path>|--set-file <path>|--delete]

Send options:
  --agent <claude|codex|cursor>  Target agent.
  --mode <execute|review|audit|debug|consult>
                                 Mode of work; agent must support it.
  --topic <slug>                 Topic slug. Top-level agent workflows should
                                 pass this explicitly.
  --current                      Opt into .handoff/current.json. Intended for
                                 human terminal convenience, not parallel
                                 agent routing.
  --summary "<text>"             One-line description (set on create).
  --prompt "<text>"              Inline prompt.
  --prompt-file <path>           Read prompt from file. (Or pipe stdin.)
  --workspace <path>             Override cwd.
  --resume                       Confirm intent to resume a stale topic.
  --new-topic                    Confirm intent to create a fresh slug
                                 when other active topics exist.
  --archive-and-new              Archive existing snapshot+history; create fresh.
  --allow-nested                 Override nested-call refusal.
  --store-trace                  Persist full prompt+output as a trace file
                                 under traces/<topic>/<round>-<agent>.json.
  --no-plan                      Skip auto-injection of the topic's plan.
  --snapshot-plan-on-edit        After send, snapshot plan to history if
                                 content changed since last snapshot.
  --clean-env                    Spawn the child with a minimal environment:
                                 PATH/HOME/shell/locale/temp/XDG plus
                                 AGENT_HANDOFF_* context only.

Discovery:
  handoff use <topic>              Set the per-cwd default topic for --current.
  handoff status                   Show current pointer + active/stale topics.
  handoff list                     List active topics (use --all for all).
  handoff doctor                   Print resolution diagnostic.

Live monitoring:
  handoff tail <topic>             Stream new history events for one topic.
                                 Pass --from-start to print existing events too.
  handoff log --since 24h          Time-ordered events across topics in this
                                 workspace. Pass --all-workspaces to merge
                                 across every workspace under the state dir.
                                 Duration formats: 30m, 2h, 7d.
  handoff ui                       Start a read-only local browser UI over
                                 topics, rounds, running files, traces, and
                                 native transcripts for this workspace.
                                 Pass --all-workspaces to aggregate every
                                 workspace bucket under the state dir.
                                 Non-loopback --host requires --unsafe-host.
                                 On unsafe hosts, transcripts are disabled
                                 unless --include-transcripts is explicit.
  handoff watch <topic>            Tail native agent transcript files.
  handoff history <topic>          Print compact native transcript history.
  handoff cancel <topic>           Signal a live child agent process. Use
                                 --run-id when multiple matching runs exist.

Plan artifacts (execution scaffolding, NOT project memory):
  handoff plan <topic>             View / manage the per-topic plan. Plans
                                 live in shared state and are auto-injected
                                 into send prompts (with provenance header)
                                 unless --no-plan. They are throwaway \u2014
                                 once execution lands, the git diff is the
                                 artifact. Promote to repo via --export
                                 when worth preserving.

State dir:    ${resolveStateDir2()}

Topic resolution for send:
  --topic wins. --current explicitly reads .handoff/current.json. Otherwise,
  handoff uses inherited AGENT_HANDOFF_TOPIC from a parent handoff invocation.
`);
}
var argv = process.argv.slice(2);
main(argv).then((code) => process.exit(code)).catch((err) => {
  if (err instanceof UnknownFlagError) {
    console.error(err.message);
    process.exit(2);
  }
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  if (err instanceof Error && err.stack)
    console.error(err.stack);
  process.exit(1);
});
export {
  UnknownFlagError
};
