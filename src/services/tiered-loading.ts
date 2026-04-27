/**
 * Tiered Context Loading (L0/L1/L2).
 *
 * Three representation tiers for each memory, inspired by OpenViking's
 * SemanticDagExecutor pattern. Token savings come from injecting the
 * cheapest tier that preserves enough signal for the model to act on.
 *
 *   L0  — Abstract/headline (~10-20 tokens). Stored in `summary`.
 *   L1  — Condensed overview (~100-200 tokens). Stored in `overview`.
 *   L2  — Full content (variable). Stored in `content`.
 *
 * Tier selection is driven by a token budget: the caller declares how
 * many tokens are available for context injection, and `assignTiers`
 * decides the best tier per memory to maximize information within budget.
 *
 * Strategy: compression-first — every memory starts at L0, the top slice
 * gets reserved L2 budget, and supporting memories are promoted to L1.
 */

import type { SearchResult } from '../db/memory-repository.js';

export type ContextTier = 'L0' | 'L1' | 'L2';

export interface TierAssignment {
  memoryId: string;
  tier: ContextTier;
  estimatedTokens: number;
}

export interface TierBudgetResult {
  assignments: TierAssignment[];
  totalTokens: number;
  budgetUsed: number;
}

export interface TierAssignmentOptions {
  forceRichTopHit?: boolean;
}

const TOKENS_PER_CHAR = 0.25;
const MAX_L2_MEMORIES = 2;
const L2_BUDGET_SHARE = 0.6;
const TARGET_L2_SHARE = 0.2;
const TARGET_L1_SHARE = 0.3;
type TierTokenMap = Record<ContextTier, TierAssignment>;

/**
 * Estimate token count for a string using a simple character-based heuristic.
 * Accurate enough for budget allocation (±20% vs real tokenizer).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length * TOKENS_PER_CHAR);
}

/**
 * Get the content string for a memory at the requested tier.
 * Falls through to the next available tier if the requested one is empty.
 */
export function getContentAtTier(memory: SearchResult, tier: ContextTier): string {
  if (tier === 'L0') {
    return memory.summary || truncateToHeadline(memory.content);
  }
  if (tier === 'L1') {
    if (memory.overview) return memory.overview;
    return memory.content;
  }
  return memory.content;
}

/**
 * Determine the best tier for a single memory given a remaining budget.
 * Tries L2 first, falls back to L1, then L0.
 */
export function selectTierForBudget(
  memory: SearchResult,
  remainingBudget: number,
): TierAssignment {
  const l2Tokens = estimateTokens(memory.content);
  if (l2Tokens <= remainingBudget) {
    return { memoryId: memory.id, tier: 'L2', estimatedTokens: l2Tokens };
  }

  const l1Content = memory.overview || memory.content;
  const l1Tokens = estimateTokens(l1Content);
  if (l1Tokens <= remainingBudget && memory.overview) {
    return { memoryId: memory.id, tier: 'L1', estimatedTokens: l1Tokens };
  }

  const l0Content = memory.summary || truncateToHeadline(memory.content);
  const l0Tokens = estimateTokens(l0Content);
  return { memoryId: memory.id, tier: 'L0', estimatedTokens: l0Tokens };
}

/**
 * Assign tiers to a ranked list of memories under a token budget.
 *
 * Compression-first policy:
 *   1. Start every memory at L0 so the whole result set remains visible.
 *   2. Reserve L2 for the top 1-2 results only.
 *   3. Promote only a bounded support slice to L1.
 *   4. Keep the lower-ranked tail at L0 for real compression.
 */
export function assignTiers(
  memories: SearchResult[],
  tokenBudget: number,
  options: TierAssignmentOptions = {},
): TierBudgetResult {
  const tierOptions = memories.map(buildTierOptions);
  const assignments = tierOptions.map(({ L0 }) => ({ ...L0 }));
  const topSliceCount = getTopSliceCount(memories.length);
  const l1Quota = getL1Quota(memories.length, topSliceCount);
  let remaining = tokenBudget - sumTokens(assignments);
  if (options.forceRichTopHit && memories.length > 0) {
    remaining = promoteFirstMemoryToRichContext(assignments, tierOptions, remaining);
  }
  const remainingL2Budget = Math.floor(tokenBudget * L2_BUDGET_SHARE);
  promoteTopSliceToL2(assignments, tierOptions, remaining, remainingL2Budget, topSliceCount);
  remaining = tokenBudget - sumTokens(assignments);
  promoteSupportingSliceToL1(assignments, tierOptions, remaining, topSliceCount, l1Quota);

  const totalTokens = sumTokens(assignments);
  return {
    assignments,
    totalTokens,
    budgetUsed: totalTokens,
  };
}

/**
 * Build the tiered injection payload: each memory rendered at its assigned tier.
 */
export function buildTieredPayload(
  memories: SearchResult[],
  assignments: TierAssignment[],
): Array<{ id: string; tier: ContextTier; content: string }> {
  const tierMap = new Map(assignments.map((a) => [a.memoryId, a.tier]));
  return memories.map((memory) => {
    const tier = tierMap.get(memory.id) ?? 'L0';
    return {
      id: memory.id,
      tier,
      content: getContentAtTier(memory, tier),
    };
  });
}

const HEADLINE_MAX_WORDS = 10;

function truncateToHeadline(content: string): string {
  const words = content.split(/\s+/);
  if (words.length <= HEADLINE_MAX_WORDS) return content;
  return words.slice(0, HEADLINE_MAX_WORDS).join(' ') + '...';
}

function buildTierOptions(memory: SearchResult): TierTokenMap {
  return {
    L0: buildAssignment(memory, 'L0'),
    L1: buildAssignment(memory, 'L1'),
    L2: buildAssignment(memory, 'L2'),
  };
}

function buildAssignment(memory: SearchResult, tier: ContextTier): TierAssignment {
  const content = getContentAtTier(memory, tier);
  return {
    memoryId: memory.id,
    tier,
    estimatedTokens: estimateTokens(content),
  };
}

function promoteFirstMemoryToRichContext(
  assignments: TierAssignment[],
  tierOptions: TierTokenMap[],
  remainingBudget: number,
): number {
  if (assignments.length === 0) return remainingBudget;
  const preferredUpgrade = chooseRichTopHit(tierOptions[0], remainingBudget, assignments[0].estimatedTokens);
  if (!preferredUpgrade) return remainingBudget;
  assignments[0] = preferredUpgrade;
  return remainingBudget - (preferredUpgrade.estimatedTokens - tierOptions[0].L0.estimatedTokens);
}

function chooseRichTopHit(
  options: TierTokenMap,
  remainingBudget: number,
  baselineTokens: number,
): TierAssignment | null {
  const l2Extra = options.L2.estimatedTokens - baselineTokens;
  if (l2Extra <= remainingBudget) return options.L2;

  const l1Extra = options.L1.estimatedTokens - baselineTokens;
  if (options.L1.estimatedTokens > baselineTokens && l1Extra <= remainingBudget) {
    return options.L1;
  }
  return null;
}

function promoteTopSliceToL2(
  assignments: TierAssignment[],
  tierOptions: TierTokenMap[],
  remainingBudget: number,
  remainingL2Budget: number,
  topSliceCount: number,
): void {
  let remaining = remainingBudget;
  let remainingL2 = remainingL2Budget;
  for (let index = 0; index < topSliceCount; index++) {
    const next = tierOptions[index].L2;
    const extraTokens = next.estimatedTokens - assignments[index].estimatedTokens;
    if (extraTokens > remaining || extraTokens > remainingL2) continue;
    assignments[index] = next;
    remaining -= extraTokens;
    remainingL2 -= extraTokens;
  }
}

function promoteSupportingSliceToL1(
  assignments: TierAssignment[],
  tierOptions: TierTokenMap[],
  remainingBudget: number,
  topSliceCount: number,
  l1Quota: number,
): void {
  let remaining = remainingBudget;
  const stopIndex = Math.min(assignments.length, topSliceCount + l1Quota);
  for (let index = topSliceCount; index < stopIndex; index++) {
    const next = tierOptions[index].L1;
    const extraTokens = next.estimatedTokens - assignments[index].estimatedTokens;
    if (extraTokens > remaining || next.estimatedTokens === assignments[index].estimatedTokens) continue;
    assignments[index] = next;
    remaining -= extraTokens;
  }
}

function getTopSliceCount(totalMemories: number): number {
  if (totalMemories === 0) return 0;
  return Math.min(MAX_L2_MEMORIES, Math.max(1, Math.round(totalMemories * TARGET_L2_SHARE)));
}

function getL1Quota(totalMemories: number, topSliceCount: number): number {
  const remainingAfterTopSlice = totalMemories - topSliceCount;
  if (remainingAfterTopSlice <= 1) return Math.max(0, remainingAfterTopSlice);

  const targetL1Count = Math.max(1, Math.floor(totalMemories * TARGET_L1_SHARE));
  return Math.min(remainingAfterTopSlice - 1, targetL1Count);
}

function sumTokens(assignments: TierAssignment[]): number {
  return assignments.reduce((sum, assignment) => sum + assignment.estimatedTokens, 0);
}
