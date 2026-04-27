/**
 * Query-aware temporal endpoint evidence formatting.
 *
 * Produces a compact first/second endpoint block for repeated-event temporal
 * questions, such as "How many months lapsed between the first and second
 * doctor's appointment?". The formatter only emits when retrieved memories
 * contain two distinct dates that match the event terms in the query.
 */

import type { SearchResult } from '../db/memory-repository.js';
import { formatDateLabel, formatDuration } from './temporal-format.js';

const REPEATED_EVENT_QUERY = /\bbetween\b[\s\S]*\bfirst\b[\s\S]*\bsecond\b|\bfirst\b[\s\S]*\bsecond\b/i;
const EVIDENCE_MAX_CHARS = 160;
const QUERY_TERM_MIN_LENGTH = 4;

const QUERY_EVENT_STOP_WORDS = new Set([
  'between', 'first', 'second', 'months', 'month', 'weeks', 'week',
  'days', 'many', 'much', 'long', 'lapsed', 'elapsed', 'passed',
  'what', 'when', 'where', 'which', 'with', 'from', 'that', 'this',
]);

const EVENT_SYNONYMS: Record<string, string[]> = {
  appointment: ['appointment', 'appointments', 'check-up', 'checkup', 'check up', 'visit'],
  doctor: ['doctor', "doctor's", 'doctors', 'doc', 'medical', 'health'],
};

/** Reverse index: each synonym → its canonical key. Built once at module load. */
const SYNONYM_TO_CANONICAL: Map<string, string> = (() => {
  const index = new Map<string, string>();
  for (const [canonical, synonyms] of Object.entries(EVENT_SYNONYMS)) {
    for (const synonym of synonyms) index.set(synonym, canonical);
  }
  return index;
})();

interface EndpointCandidate {
  dateKey: string;
  memory: SearchResult;
  score: number;
}

/**
 * A concept group is the synonym list for one canonical event term in the
 * query. "Doctor appointment" produces two groups (the doctor synonyms and
 * the appointment synonyms); a candidate must hit AT LEAST ONE synonym in
 * EVERY group to qualify, otherwise a memory mentioning only "doctor" and
 * another mentioning only "appointment" would falsely become endpoints.
 */
type ConceptGroup = string[];

/** Build endpoint lines for repeated-event temporal comparisons. */
export function buildRepeatedEventEndpointBlock(
  memories: SearchResult[],
  query: string,
): string {
  if (!isRepeatedEventQuery(query)) return '';
  const conceptGroups = extractEventConceptGroups(query);
  if (conceptGroups.length === 0) return '';

  const candidates = findEndpointCandidates(memories, conceptGroups);
  const endpoints = selectDistinctDateEndpoints(candidates);
  if (endpoints.length < 2) return '';

  const [first, second] = endpoints;
  const days = diffDays(first.memory.created_at, second.memory.created_at);
  return [
    'Repeated event endpoints:',
    formatEndpointLine('first matching event', first),
    formatEndpointLine('second matching event', second),
    `- elapsed between endpoints: ${formatDuration(days)}`,
  ].join('\n');
}

function isRepeatedEventQuery(query: string): boolean {
  return REPEATED_EVENT_QUERY.test(query.toLowerCase());
}

/**
 * Extract one ConceptGroup per distinct canonical event term in the query.
 * Plural and synonym forms collapse to the same group via SYNONYM_TO_CANONICAL;
 * unknown terms become singleton groups.
 */
function extractEventConceptGroups(query: string): ConceptGroup[] {
  const source = extractOrdinalClauses(query);
  const rawTerms = source
    .toLowerCase()
    .replace(/\b([a-z]+)'s\b/g, '$1')
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .split(/\s+/)
    .filter((term) => term.length >= QUERY_TERM_MIN_LENGTH)
    .filter((term) => !QUERY_EVENT_STOP_WORDS.has(term));

  const seenCanonicals = new Set<string>();
  const groups: ConceptGroup[] = [];
  for (const term of rawTerms) {
    const canonical = SYNONYM_TO_CANONICAL.get(term);
    if (canonical) {
      if (!seenCanonicals.has(canonical)) {
        seenCanonicals.add(canonical);
        groups.push(EVENT_SYNONYMS[canonical]);
      }
    } else {
      groups.push([term]);
    }
  }
  return groups;
}

function extractOrdinalClauses(query: string): string {
  const pieces = query.toLowerCase().split(/\b(?:first|second)\b/).slice(1);
  return pieces.join(' ') || query;
}

function findEndpointCandidates(
  memories: SearchResult[],
  conceptGroups: ConceptGroup[],
): EndpointCandidate[] {
  return memories
    .map((memory) => scoreEndpointCandidate(memory, conceptGroups))
    .filter((candidate): candidate is EndpointCandidate => candidate !== null)
    .sort((left, right) => left.memory.created_at.getTime() - right.memory.created_at.getTime());
}

/**
 * A candidate qualifies only if every concept group in the query has at
 * least one synonym present in the memory's content. Score is the number
 * of groups matched (ties broken by date order downstream).
 */
function scoreEndpointCandidate(
  memory: SearchResult,
  conceptGroups: ConceptGroup[],
): EndpointCandidate | null {
  const content = memory.content.toLowerCase();
  const matched = conceptGroups.filter((group) => group.some((synonym) => content.includes(synonym))).length;
  if (matched < conceptGroups.length) return null;
  return { dateKey: formatDateLabel(memory.created_at), memory, score: matched };
}

function selectDistinctDateEndpoints(candidates: EndpointCandidate[]): EndpointCandidate[] {
  const byDate = new Map<string, EndpointCandidate>();
  for (const candidate of candidates) {
    const existing = byDate.get(candidate.dateKey);
    if (!existing || candidate.score > existing.score) byDate.set(candidate.dateKey, candidate);
  }
  return [...byDate.values()].sort((left, right) =>
    left.memory.created_at.getTime() - right.memory.created_at.getTime(),
  ).slice(0, 2);
}

function formatEndpointLine(label: string, candidate: EndpointCandidate): string {
  return `- ${label}: ${candidate.dateKey} — ${truncateEvidence(candidate.memory.content)}`;
}

function truncateEvidence(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= EVIDENCE_MAX_CHARS) return normalized;
  return `${normalized.slice(0, EVIDENCE_MAX_CHARS - 3)}...`;
}

function diffDays(first: Date, second: Date): number {
  return Math.round((second.getTime() - first.getTime()) / 86400000);
}
