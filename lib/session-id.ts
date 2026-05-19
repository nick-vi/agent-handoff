import type { AgentName } from './schema/v1.ts';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionId(_agent: AgentName, sessionId: string): boolean {
  return UUID_PATTERN.test(sessionId);
}

export function sanitizeSessionId(
  agent: AgentName,
  sessionId: string | null | undefined
): string | null | undefined {
  if (sessionId === null || sessionId === undefined) return sessionId;
  if (isValidSessionId(agent, sessionId)) return sessionId;
  throw new Error(`Invalid ${agent} session id: ${sessionId}`);
}
