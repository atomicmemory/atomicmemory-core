/**
 * Query-term visibility preservation for tiered context packaging.
 *
 * Tiered loading can compress a memory to L0/L1 and hide exact words from the
 * user query. This helper upgrades only those compressed memories whose richer
 * tiers reveal missing query terms without exceeding the caller's token budget.
 */

import type { SearchResult } from '../db/memory-repository.js';
import type { TierAssignment } from './tiered-loading.js';
import { estimateTokens, getContentAtTier } from './tiered-loading.js';

const QUERY_TERM_MIN_LENGTH = 4;
const QUERY_TERM_STOP_WORDS = new Set([
  'what', 'when', 'where', 'which', 'with', 'from', 'that', 'this',
  'recently', 'attend', 'attended', 'does', 'have', 'has', 'did',
]);

/** Upgrade compressed memories when exact query terms are otherwise hidden. */
export function preserveQueryTermVisibility(
  memories: SearchResult[],
  assignments: TierAssignment[],
  query: string,
  tokenBudget: number,
): TierAssignment[] {
  const terms = extractQueryVisibilityTerms(query);
  if (terms.length === 0) return assignments;

  const nextAssignments = assignments.map((assignment) => ({ ...assignment }));
  let remaining = tokenBudget - sumAssignmentTokens(nextAssignments);
  for (const memory of memories) {
    const index = nextAssignments.findIndex((assignment) => assignment.memoryId === memory.id);
    if (index === -1 || nextAssignments[index].tier === 'L2') continue;
    const upgraded = chooseVisibleTier(memory, nextAssignments[index], terms, remaining);
    if (!upgraded) continue;
    remaining -= upgraded.estimatedTokens - nextAssignments[index].estimatedTokens;
    nextAssignments[index] = upgraded;
  }
  return nextAssignments;
}

export function sumAssignmentTokens(assignments: Array<{ estimatedTokens: number }>): number {
  return assignments.reduce((sum, assignment) => sum + assignment.estimatedTokens, 0);
}

function chooseVisibleTier(
  memory: SearchResult,
  assignment: TierAssignment,
  terms: string[],
  remainingBudget: number,
): TierAssignment | null {
  const current = getContentAtTier(memory, assignment.tier).toLowerCase();
  const missingTerms = terms.filter((term) => !current.includes(term) && memory.content.toLowerCase().includes(term));
  if (missingTerms.length === 0) return null;

  for (const tier of ['L1', 'L2'] as const) {
    const content = getContentAtTier(memory, tier).toLowerCase();
    const revealsTerm = missingTerms.some((term) => content.includes(term));
    const tokens = estimateTokens(content);
    const extra = tokens - assignment.estimatedTokens;
    if (revealsTerm && extra <= remainingBudget) {
      return { memoryId: memory.id, tier, estimatedTokens: tokens };
    }
  }
  return null;
}

function extractQueryVisibilityTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((term) => term.length >= QUERY_TERM_MIN_LENGTH)
    .filter((term) => !QUERY_TERM_STOP_WORDS.has(term));
  return [...new Set(terms)];
}
