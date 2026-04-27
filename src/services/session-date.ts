/**
 * Shared parser for transcript-level session dates.
 *
 * Benchmark and SDK callers can include a first-line header:
 * `[Session date: ...]`. Core uses it as the logical observation timestamp
 * for extraction, storage backdating, and context packaging.
 */

const SESSION_DATE_PATTERN = /^\[Session date:\s*([^\]]+)\]/i;

export function extractSessionTimestamp(conversationText: string): string | null {
  const firstLine = conversationText.split('\n', 1)[0] ?? '';
  const match = firstLine.match(SESSION_DATE_PATTERN);
  return match?.[1]?.trim() || null;
}

export function parseSessionDate(conversationText: string): Date | null {
  const timestamp = extractSessionTimestamp(conversationText);
  if (!timestamp) return null;
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function resolveSessionDate(explicitTimestamp: Date | undefined, conversationText: string): Date | undefined {
  return explicitTimestamp ?? parseSessionDate(conversationText) ?? undefined;
}
