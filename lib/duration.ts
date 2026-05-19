/**
 * Duration parsing for the `--since` flag of `handoff log` (and any
 * future time-window filters). Tiny, intentional grammar — no
 * "1h30m" composite units; the use case is "give me the last
 * <something>", not arbitrary durations.
 *
 * Grammar: `<positive-int>(m|h|d)`
 *   m = minutes, h = hours, d = days
 *
 * Returns milliseconds; null on invalid input. Caller decides what
 * "now − duration" means.
 */

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseSince(spec: string): number | null {
  const match = /^(\d+)([mhd])$/.exec(spec.trim());
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 10);
  const unit = match[2]!;
  if (!Number.isFinite(n) || n <= 0) return null;
  const multiplier = UNIT_MS[unit];
  if (!multiplier) return null;
  return n * multiplier;
}
