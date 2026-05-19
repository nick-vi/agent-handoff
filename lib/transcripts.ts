import { readFileSync } from 'node:fs';
import { readCursorChat, type CursorTurn } from './agents/cursor-sqlite.ts';
import { resolveLocalSession } from './local-sessions.ts';
import type { AgentName } from './schema/v1.ts';

export type TranscriptTurn = {
  role: string;
  text: string;
  ts: string | null;
  raw: unknown;
};

export type ResolvedTranscript = {
  sourcePath: string;
  turns: TranscriptTurn[];
  warnings: string[];
};

type TurnEnvelope = {
  type?: string;
  role?: string;
  message?: { role?: string; content?: unknown };
  content?: unknown;
  payload?: {
    type?: string;
    role?: string;
    content?: unknown;
    name?: string;
    arguments?: string;
  };
  timestamp?: string;
  ts?: string;
};

export function resolveTranscriptTurns(
  agent: AgentName,
  sessionId: string,
  workspaceRoot: string
): ResolvedTranscript | null {
  const res = resolveLocalSession(agent, sessionId, workspaceRoot);
  if (res.kind === 'missing' || res.kind === 'unsupported') return null;
  if (res.kind === 'sqlite-cursor') {
    const result = readCursorChat(res.path);
    return {
      sourcePath: res.path,
      turns: result.turns.map(cursorTurnToTranscript),
      warnings: result.warnings,
    };
  }

  let lines: string[];
  try {
    lines = readFileSync(res.path, 'utf-8').split('\n').filter((line) => line.length > 0);
  } catch {
    return null;
  }
  return {
    sourcePath: res.path,
    turns: lines.map((line) => parseTurn(line)).filter((turn): turn is TranscriptTurn => turn !== null),
    warnings: [],
  };
}

export function cursorTurnToTranscript(turn: CursorTurn): TranscriptTurn {
  return { role: turn.role, text: turn.text, ts: null, raw: turn.raw };
}

export function isToolTurn(t: TranscriptTurn): boolean {
  return t.role === 'tool_call' || t.role === 'tool' || t.role === 'function_call';
}

export function isSystemTurn(t: TranscriptTurn): boolean {
  if (t.role === 'system' || t.role === 'developer') return true;
  if (t.role === 'user') {
    const head = t.text.trimStart().slice(0, 30);
    if (head.startsWith('<environment_context>')) return true;
    if (head.startsWith('<user_info>')) return true;
  }
  return false;
}

/**
 * Recognize meaningful turns inside agent transcript JSONL and map them
 * onto a uniform `(role, text)` shape regardless of which agent wrote it.
 */
export function parseTurn(line: string): TranscriptTurn | null {
  let parsed: TurnEnvelope;
  try {
    parsed = JSON.parse(line) as TurnEnvelope;
  } catch {
    return null;
  }
  const ts = parsed.timestamp ?? parsed.ts ?? null;

  if (parsed.type === 'response_item' && parsed.payload) {
    const p = parsed.payload;
    if (p.type === 'message' && p.role) {
      return { role: p.role, text: extractTextFromContent(p.content), ts, raw: parsed };
    }
    if (p.type === 'function_call' && p.name) {
      const argsPreview = (p.arguments ?? '').replace(/\s+/g, ' ').trim();
      const args = argsPreview.length > 80 ? `${argsPreview.slice(0, 77)}…` : argsPreview;
      return { role: 'tool_call', text: `${p.name}(${args})`, ts, raw: parsed };
    }
    return null;
  }
  if (parsed.type === 'event_msg' || parsed.type === 'session_meta' || parsed.type === 'turn_context') {
    return null;
  }

  if (parsed.type === 'user' || parsed.type === 'assistant') {
    const role = parsed.message?.role ?? parsed.type;
    return {
      role,
      text: extractTextFromContent(parsed.message?.content),
      ts,
      raw: parsed,
    };
  }
  if (['system', 'attachment', 'queue-operation', 'last-prompt'].includes(parsed.type ?? '')) {
    return null;
  }

  const role = parsed.role ?? parsed.message?.role ?? parsed.type ?? '';
  if (!role || ['state', 'cache_event'].includes(role)) return null;
  return {
    role,
    text: extractTextFromContent(parsed.message?.content ?? parsed.content),
    ts,
    raw: parsed,
  };
}

export function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part);
        continue;
      }
      if (!part || typeof part !== 'object') continue;
      const p = part as {
        type?: string;
        text?: unknown;
        thinking?: unknown;
        name?: unknown;
        input?: unknown;
        arguments?: unknown;
        content?: unknown;
        source?: unknown;
      };
      if (typeof p.text === 'string') parts.push(p.text);
      else if (typeof p.thinking === 'string') parts.push(`<thinking> ${p.thinking}`);
      else if (p.type === 'tool_use' && p.name) {
        const args = toolArgsText(p.input ?? p.arguments);
        parts.push(`<tool: ${String(p.name)}>${args ? `\n${args}` : ''}`);
      }
      else if (p.type === 'tool_result') {
        const result = typeof p.content === 'string'
          ? p.content
          : extractTextFromContent(p.content);
        parts.push(`<tool_result>${result ? `\n${result}` : ''}`);
      }
      else if (p.type === 'image' || p.source) parts.push('[image]');
      else if (p.type) parts.push(`<${p.type}>`);
    }
    return parts.join(' ').trim();
  }
  return '';
}

function toolArgsText(value: unknown): string {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
