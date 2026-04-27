/**
 * Conflict policy helpers for AUDN clarification and candidate expansion.
 */

import { config } from '../config.js';
import type { AUDNDecision } from './extraction.js';

export interface CandidateMemory {
  id: string;
  content: string;
  similarity: number;
  importance: number;
  agent_id?: string;
}

const UNCERTAIN_MARKERS = ['maybe', 'might', 'not sure', 'i think', 'perhaps', 'tomorrow'];
const UNCERTAIN_PATTERNS = [
  /\b(?:need|needs|needed|will|should)\s+to\s+check\b/i,
  /\bcheck\s+(?:later|tomorrow|again|back)\b/i,
];
const GENERIC_CONFLICT_MARKERS = [
  'user',
  'users',
  'january',
  'february',
  'march',
  'april',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const SAFETY_RISK_MARKERS = ['allergic', 'life-threatening', 'anaphyl', 'avoid', 'cannot eat', "can't eat", 'severe'];
const SAFETY_CLEARANCE_MARKERS = ['ate', 'eat', 'eating', 'cookie', 'meal', 'dish', 'okay', 'fine', 'safe'];
const SAFE_REUSE_MIN_SIMILARITY = config.audnSafeReuseMinSimilarity;
const SAFE_REUSE_MIN_SHARED_KEYWORDS = 2;
const TRANSITION_MARKERS = ['switched away from', 'switched from', 'migrated from', 'moved from', 'previously used'];

interface PolicyContext {
  decision: AUDNDecision;
  factText: string;
  candidates: CandidateMemory[];
  factKeywords: string[];
  factType: string | null;
}

type Policy = (ctx: PolicyContext) => AUDNDecision | null;

const POLICIES: Policy[] = [
  resolveExplicitReplacementOnClarify,
  preserveLowConfidenceClarify,
  detectUncertainConflict,
  resolveCriticalConflict,
  preserveRecommendationAttribution,
  separateStateTransition,
  supersedeInsteadOfUpdate,
];

export function applyClarificationOverrides(
  decision: AUDNDecision,
  factText: string,
  candidates: CandidateMemory[],
  factKeywords: string[] = [],
  factType: string | null = null,
): AUDNDecision {
  const ctx: PolicyContext = { decision, factText, candidates, factKeywords, factType };
  for (const policy of POLICIES) {
    const result = policy(ctx);
    if (result !== null) return result;
  }
  return preserveAtomicFacts(decision, factText, candidates, factKeywords, factType);
}

/**
 * AUDN returned CLARIFY but the new fact carries an explicit replacement
 * signal ("replacing X", "no longer Y", "instead of Z", "correction: ..."):
 *   - With a target that's present in the candidate set: upgrade to
 *     SUPERSEDE so the stale memory is expired.
 *   - Without a target, or with a stale/invalid target ID that doesn't
 *     resolve to any candidate: keep the CLARIFY hold. memory-audn would
 *     reject a SUPERSEDE against a missing target and fall back to
 *     canonical storage, which leaves the old memory active — same bug
 *     as routing through promoteToAdd.
 */
function resolveExplicitReplacementOnClarify(ctx: PolicyContext): AUDNDecision | null {
  if (ctx.decision.action !== 'CLARIFY') return null;
  if (!containsExplicitReplacementSignal(ctx.factText)) return null;
  const targetId = ctx.decision.targetMemoryId;
  const targetInCandidates = targetId !== null && targetId !== undefined
    && ctx.candidates.some((candidate) => candidate.id === targetId);
  return targetInCandidates ? supersede(ctx.decision) : ctx.decision;
}

function preserveLowConfidenceClarify(ctx: PolicyContext): AUDNDecision | null {
  if (!shouldClarifyConflict(ctx.decision)) return null;
  if (containsExplicitReplacementSignal(ctx.factText)) return null;
  return ctx.decision;
}

function detectUncertainConflict(ctx: PolicyContext): AUDNDecision | null {
  if (!isUncertainConflict(ctx.factText, ctx.candidates)) return null;
  return clarify(ctx.decision, 'Uncertain contradiction detected in new fact');
}

/**
 * If the new fact contradicts a high-importance memory, require clarification
 * unless an explicit replacement signal is present (and the action is
 * already destructive). Otherwise promote to ADD so a non-contradictory
 * specialization doesn't overwrite the original.
 */
function resolveCriticalConflict(ctx: PolicyContext): AUDNDecision | null {
  if (!isCriticalConflict(ctx.decision, ctx.factText, ctx.candidates)) return null;
  const target = resolveDecisionTarget(ctx.decision, ctx.candidates);
  if (target && containsContradictionSignal(ctx.factText, target.content)) {
    if (canApplyExplicitReplacement(ctx.decision, ctx.factText)) {
      return ctx.decision.action === 'UPDATE' ? supersede(ctx.decision) : ctx.decision;
    }
    return clarify(ctx.decision, 'Critical existing memory requires clarification before replacement');
  }
  return promoteToAdd(ctx.decision);
}

function preserveRecommendationAttribution(ctx: PolicyContext): AUDNDecision | null {
  if (!shouldPreserveRecommendationAttribution(ctx.decision, ctx.factText, ctx.candidates)) return null;
  return promoteToAdd(ctx.decision);
}

function separateStateTransition(ctx: PolicyContext): AUDNDecision | null {
  if (!shouldSeparateStateTransition(ctx.decision, ctx.factText)) return null;
  return promoteToAdd(ctx.decision);
}

function supersedeInsteadOfUpdate(ctx: PolicyContext): AUDNDecision | null {
  if (!shouldSupersedeInsteadOfUpdate(ctx.decision, ctx.factText, ctx.candidates)) return null;
  return supersede(ctx.decision);
}

export function extractConflictKeywords(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  return [...new Set(words.filter((word) => !UNCERTAIN_MARKERS.includes(word) && !GENERIC_CONFLICT_MARKERS.includes(word)))];
}

export function mergeCandidates(
  primary: CandidateMemory[],
  secondary: CandidateMemory[],
): CandidateMemory[] {
  const merged = new Map<string, CandidateMemory>();
  for (const candidate of [...primary, ...secondary]) {
    const existing = merged.get(candidate.id);
    if (!existing || candidate.similarity > existing.similarity) {
      merged.set(candidate.id, candidate);
    }
  }
  return [...merged.values()].sort((left, right) => right.similarity - left.similarity);
}

function shouldClarifyConflict(decision: AUDNDecision): boolean {
  if (decision.action === 'CLARIFY') return true;
  if (decision.action !== 'SUPERSEDE' && decision.action !== 'DELETE') return false;
  if (decision.contradictionConfidence === null) return false;
  // DELETE is more destructive than SUPERSEDE — require higher confidence
  const threshold = decision.action === 'DELETE'
    ? Math.min(config.clarificationConflictThreshold + 0.1, 1.0)
    : config.clarificationConflictThreshold;
  return decision.contradictionConfidence < threshold;
}

function isUncertainConflict(factText: string, candidates: CandidateMemory[]): boolean {
  if (candidates.length === 0) return false;
  const lower = factText.toLowerCase();
  return UNCERTAIN_MARKERS.some((marker) => lower.includes(marker))
    || UNCERTAIN_PATTERNS.some((pattern) => pattern.test(factText));
}

function isCriticalConflict(
  decision: AUDNDecision,
  factText: string,
  candidates: CandidateMemory[],
): boolean {
  // Only apply critical-conflict protection to destructive actions (SUPERSEDE/DELETE).
  // ADD is not a conflict — it stores new info alongside existing memories.
  if (decision.action === 'ADD' || decision.action === 'NOOP') return false;
  const criticalCandidate = candidates.find(
    (candidate) => candidate.importance >= 0.9 && hasSharedKeyword(factText, candidate.content),
  );
  if (!criticalCandidate) return false;
  if (decision.action === 'UPDATE') return hasSafetyConflictSignal(factText, criticalCandidate.content);
  return true;
}

function hasSafetyConflictSignal(factText: string, candidateText: string): boolean {
  return containsAny(candidateText, SAFETY_RISK_MARKERS) && containsAny(factText, SAFETY_CLEARANCE_MARKERS);
}

function containsAny(text: string, markers: string[]): boolean {
  const lower = text.toLowerCase();
  return markers.some((marker) => lower.includes(marker));
}

function hasSharedKeyword(left: string, right: string): boolean {
  const leftWords = new Set(extractConflictKeywords(left));
  return extractConflictKeywords(right).some((word) => leftWords.has(word));
}

function supersede(decision: AUDNDecision): AUDNDecision {
  return {
    ...decision,
    action: 'SUPERSEDE',
    updatedContent: null,
  };
}

function shouldSupersedeInsteadOfUpdate(
  decision: AUDNDecision,
  factText: string,
  candidates: CandidateMemory[],
): boolean {
  if (decision.action !== 'UPDATE') return false;
  if (!decision.targetMemoryId || !decision.updatedContent) return false;
  const target = candidates.find((c) => c.id === decision.targetMemoryId);
  if (!target) return false;
  return containsContradictionSignal(factText, target.content);
}

const SWITCH_MARKERS = ['switched', 'changed', 'moved to', 'replaced', 'replacing', 'no longer', 'instead of', 'now using', 'now use', 'corrected from', 'correction:', 'correction '];
const EXPLICIT_REPLACEMENT_PATTERNS = [
  /\breplac(?:e|ed|ing)\b/i,
  /\bno longer\b/i,
  /\binstead of\b/i,
  /\bcorrect(?:ed|ion)\b/i,
];

function containsExplicitReplacementSignal(factText: string): boolean {
  return EXPLICIT_REPLACEMENT_PATTERNS.some((pattern) => pattern.test(factText));
}

function canApplyExplicitReplacement(decision: AUDNDecision, factText: string): boolean {
  if (decision.action !== 'SUPERSEDE' && decision.action !== 'UPDATE') return false;
  return containsExplicitReplacementSignal(factText);
}

function containsContradictionSignal(factText: string, candidateText: string): boolean {
  if (containsExplicitReplacementSignal(factText)) return true;
  const candidateKeywords = extractConflictKeywords(candidateText);
  const negationPattern = candidateKeywords.some((kw) => {
    const negated = new RegExp(`(not|no longer|stopped|quit|don'?t)\\s+\\w*\\s*${kw}`, 'i');
    return negated.test(factText);
  });
  return negationPattern;
}

function shouldPreserveRecommendationAttribution(
  decision: AUDNDecision,
  factText: string,
  candidates: CandidateMemory[],
): boolean {
  if (decision.action !== 'SUPERSEDE' && decision.action !== 'DELETE') return false;
  if (!/\b(recommended|suggested)\b/i.test(factText)) return false;
  const target = resolveDecisionTarget(decision, candidates);
  if (!target) return false;
  return !containsContradictionSignal(factText, target.content);
}

function clarify(decision: AUDNDecision, note: string): AUDNDecision {
  return {
    ...decision,
    action: 'CLARIFY',
    clarificationNote: decision.clarificationNote ?? note,
    contradictionConfidence: decision.contradictionConfidence ?? 0.35,
  };
}

function preserveAtomicFacts(
  decision: AUDNDecision,
  factText: string,
  candidates: CandidateMemory[],
  factKeywords: string[],
  factType: string | null,
): AUDNDecision {
  if (!shouldPreserveAtomicBoundary(factText, factType)) return decision;
  if (decision.action !== 'UPDATE' && decision.action !== 'NOOP') return decision;
  if (isStateTransitionFact(factText)) return promoteToAdd(decision);
  const target = resolveDecisionTarget(decision, candidates);
  if (!target) return promoteToAdd(decision);
  if (decision.action === 'UPDATE' && isContentGrowthExcessive(decision.updatedContent, target.content)) {
    return promoteToAdd(decision);
  }
  if (isSafeReuse(target, factText, factKeywords)) return decision;
  return promoteToAdd(decision);
}

const MAX_UPDATE_GROWTH_RATIO = 1.5;

/** Reject UPDATE if merged content would grow more than 50% vs original. */
function isContentGrowthExcessive(updatedContent: string | null, originalContent: string): boolean {
  if (!updatedContent) return false;
  return updatedContent.length > originalContent.length * MAX_UPDATE_GROWTH_RATIO;
}

function resolveDecisionTarget(
  decision: AUDNDecision,
  candidates: CandidateMemory[],
): CandidateMemory | null {
  if (decision.targetMemoryId) {
    return candidates.find((candidate) => candidate.id === decision.targetMemoryId) ?? null;
  }
  return candidates[0] ?? null;
}

function isSafeReuse(candidate: CandidateMemory, factText: string, factKeywords: string[]): boolean {
  if (candidate.similarity < SAFE_REUSE_MIN_SIMILARITY) return false;
  const sharedFactKeywords = countSharedFactKeywords(factKeywords, candidate.content);
  if (sharedFactKeywords >= SAFE_REUSE_MIN_SHARED_KEYWORDS) return true;
  return sharedFactKeywords === 1
    && candidate.similarity >= 0.95
    && countSharedKeywords(factText, candidate.content) >= SAFE_REUSE_MIN_SHARED_KEYWORDS;
}

function countSharedKeywords(left: string, right: string): number {
  const leftWords = new Set(extractConflictKeywords(left));
  return extractConflictKeywords(right).filter((word) => leftWords.has(word)).length;
}

function countSharedFactKeywords(keywords: string[], content: string): number {
  const lowerContent = content.toLowerCase();
  return keywords
    .map((keyword) => keyword.trim().toLowerCase())
    .filter((keyword) => keyword.length > 0)
    .filter((keyword) => lowerContent.includes(keyword))
    .length;
}

function isStateTransitionFact(text: string): boolean {
  const lower = text.toLowerCase();
  return TRANSITION_MARKERS.some((marker) => lower.includes(marker));
}

function shouldSeparateStateTransition(decision: AUDNDecision, factText: string): boolean {
  if (!isStateTransitionFact(factText)) return false;
  return decision.action === 'UPDATE' || decision.action === 'NOOP' || decision.action === 'SUPERSEDE';
}

function shouldPreserveAtomicBoundary(_factText: string, _factType: string | null): boolean {
  // Apply atomic boundary protection to ALL fact types.
  // Previously gated to factType==='project' and recommendation facts only,
  // which allowed non-project facts to be merged via UPDATE/NOOP without
  // the similarity+keyword safety check. This caused 21-vs-51 memory count
  // swings across runs (AUDN non-determinism in merge decisions).
  return true;
}

function promoteToAdd(decision: AUDNDecision): AUDNDecision {
  return {
    ...decision,
    action: 'ADD',
    targetMemoryId: null,
    updatedContent: null,
  };
}

/** Trust context for multi-agent conflict resolution. */
export interface TrustContext {
  callerAgentId: string;
  callerTrustLevel: number;
  candidateTrustLevels: Map<string, number>;
}

/**
 * Applies trust-based overrides to AUDN decisions when the caller agent has
 * lower trust than the target memory's agent. Forces CLARIFY instead of
 * SUPERSEDE/DELETE/UPDATE to prevent low-trust agents from silently overwriting
 * high-trust memories.
 */
function applyTrustOverrides(
  decision: AUDNDecision,
  candidates: CandidateMemory[],
  trustContext: TrustContext | undefined,
): AUDNDecision {
  if (!trustContext) return decision;
  if (!isDestructiveAction(decision)) return decision;
  if (!decision.targetMemoryId) return decision;

  const targetCandidate = candidates.find((c) => c.id === decision.targetMemoryId);
  if (!targetCandidate?.agent_id) return decision;

  const targetAgentId = targetCandidate.agent_id;
  if (targetAgentId === trustContext.callerAgentId) return decision;

  const targetTrust = trustContext.candidateTrustLevels.get(targetAgentId) ?? 0.5;
  if (trustContext.callerTrustLevel >= targetTrust) return decision;

  return clarify(
    decision,
    `Low-trust agent (${trustContext.callerTrustLevel.toFixed(2)}) cannot ${decision.action.toLowerCase()} ` +
    `memory from higher-trust agent (${targetTrust.toFixed(2)})`,
  );
}

function isDestructiveAction(decision: AUDNDecision): boolean {
  return decision.action === 'SUPERSEDE' || decision.action === 'DELETE' || decision.action === 'UPDATE';
}
