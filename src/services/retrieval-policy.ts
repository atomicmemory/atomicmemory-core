/**
 * Adaptive retrieval and repair-loop policy helpers.
 */

import type { CoreRuntimeConfig } from '../app/runtime-container.js';
import type { SearchResult } from '../db/memory-repository.js';
import { isTemporalOrderingQuery } from './temporal-query-expansion.js';

const SIMPLE_QUERY_LIMIT = 5;
const MEDIUM_QUERY_LIMIT = 5;
const COMPLEX_QUERY_LIMIT = 8;
const MULTI_HOP_QUERY_LIMIT = 12;
export const AGGREGATION_QUERY_LIMIT = 25;

type AdaptiveLimitConfig = Pick<
  CoreRuntimeConfig,
  | 'adaptiveRetrievalEnabled'
  | 'maxSearchResults'
  | 'adaptiveSimpleLimit'
  | 'adaptiveMediumLimit'
  | 'adaptiveComplexLimit'
  | 'adaptiveMultiHopLimit'
  | 'adaptiveAggregationLimit'
>;

/** Hard ceiling for aggregation queries (prevents runaway candidate pools). */
const AGGREGATION_HARD_CAP = 50;

/**
 * Markers indicating temporal/relational complexity (multi-hop or comparison).
 *
 * The "current" marker reclassifies current-state attribute queries from
 * MEDIUM/5 → MULTI_HOP/12 so the retrieval window is broad enough to
 * distinguish current state from historical mentions (commit 122ae26).
 *
 * Validated 2026-04-01: 0/15 false positives across 2,173 benchmark queries
 * (7 datasets). 4 borderline date-pinned queries are harmless (extra depth,
 * no accuracy impact). See: docs/.../current-marker-fp-analysis-2026-04-01.md
 *
 * If editing this list, re-run the FP scan:
 *   classifyQueryDetailed() against all eval dataset queries.
 */
const MULTI_HOP_MARKERS: string[] = ['compare', 'difference between', 'relationship between', 'how does .* relate', 'connection between', 'all the times', 'everything about', 'full history', 'current'];

/**
 * Toggle "current" in MULTI_HOP_MARKERS for controlled A/B eval comparisons.
 * Not for production use — only called by run-balanced12-validation.ts.
 */
function addCurrentToMultiHopMarkers(): void {
  if (!MULTI_HOP_MARKERS.includes('current')) MULTI_HOP_MARKERS.push('current');
}
function removeCurrentFromMultiHopMarkers(): void {
  const idx = MULTI_HOP_MARKERS.indexOf('current');
  if (idx >= 0) MULTI_HOP_MARKERS.splice(idx, 1);
}
const COMPLEX_MARKERS = ['before', 'after', 'change', 'switched', 'why', 'how', 'relationship', 'history', 'used to', 'when', 'timeline', 'order', 'how long', 'sequence'];

/**
 * Aggregation query markers: count, sum, total, list-all patterns.
 * These need high recall across many sessions to avoid undercounting.
 */
const AGGREGATION_MARKERS = [
  'how many', 'how much',
  'total amount', 'total cost', 'total spent', 'total price',
  'total duration', 'total number', 'total time',
  'list all', 'list every', 'name all', 'name every',
  'what are all', 'what were all',
];

export interface ResolvedLimit {
  limit: number;
  classification: QueryClassification;
}

export function resolveSearchLimit(
  query: string,
  requestedLimit: number | undefined,
  runtimeConfig: AdaptiveLimitConfig,
): number {
  return resolveSearchLimitDetailed(query, requestedLimit, runtimeConfig).limit;
}

export function resolveSearchLimitDetailed(
  query: string,
  requestedLimit: number | undefined,
  runtimeConfig: AdaptiveLimitConfig,
): ResolvedLimit {
  if (requestedLimit !== undefined) {
    return { limit: clampLimit(requestedLimit, runtimeConfig.maxSearchResults), classification: { limit: requestedLimit, label: 'medium' } };
  }
  if (!runtimeConfig.adaptiveRetrievalEnabled) {
    return { limit: clampLimit(runtimeConfig.maxSearchResults, runtimeConfig.maxSearchResults), classification: { limit: runtimeConfig.maxSearchResults, label: 'medium' } };
  }
  const classification = applyConfiguredLimit(classifyQueryDetailed(query), runtimeConfig);
  // Aggregation queries bypass the normal maxSearchResults clamp to improve
  // recall for count/sum/list-all questions spanning many sessions.
  const limit = classification.label === 'aggregation'
    ? Math.max(1, Math.min(AGGREGATION_HARD_CAP, classification.limit))
    : clampLimit(classification.limit, runtimeConfig.maxSearchResults);
  return { limit, classification };
}

export function shouldRunRepairLoop(
  query: string,
  memories: SearchResult[],
  runtimeConfig: Pick<CoreRuntimeConfig, 'repairLoopEnabled' | 'repairLoopMinSimilarity'> & AdaptiveLimitConfig,
): boolean {
  if (!runtimeConfig.repairLoopEnabled) return false;
  // Selective repair: only escalate queries where the rewrite improves retrieval.
  // Multi-hop and aggregation always benefit. Complex queries benefit unless they
  // are temporal-ordering (the rewrite strips time-specific phrasing and hurts
  // sequencing evidence). Simple/medium queries are fast-pathed without repair.
  const classification = classifyQueryDetailed(query);
  const isEligible = classification.label === 'multi-hop'
    || classification.label === 'aggregation'
    || (classification.label === 'complex' && !isTemporalOrderingQuery(query));
  if (!isEligible) return false;
  if (memories.length === 0) return true;
  if (memories[0].similarity < runtimeConfig.repairLoopMinSimilarity) return true;
  return isComplexQuery(query.toLowerCase()) && memories.length < resolveSearchLimit(query, undefined, runtimeConfig);
}

export interface RepairDecision {
  accepted: boolean;
  reason:
    | 'no-repair-needed'
    | 'rewrite-unchanged'
    | 'delta-below-threshold'
    | 'below-confidence-floor'
    | 'sabotage-detected'
    | 'accepted';
  initialTopSim: number;
  repairedTopSim: number;
  simDelta: number;
}

/**
 * Decides whether to accept repaired results over initial results.
 * Gates on two heuristics:
 *   1. Similarity-delta anti-thrash: reject if top-1 similarity didn't improve enough.
 *   2. Confidence floor: reject if repaired top-1 similarity is still too low.
 * Both thresholds default to 0 (always accept) to preserve current behavior.
 */
export function shouldAcceptRepair(
  initial: SearchResult[],
  repaired: SearchResult[],
  runtimeConfig: Pick<CoreRuntimeConfig, 'repairDeltaThreshold' | 'repairConfidenceFloor'>,
): RepairDecision {
  const initialTopSim = initial.length > 0 ? initial[0].similarity : 0;
  const repairedTopSim = repaired.length > 0 ? repaired[0].similarity : 0;
  const simDelta = repairedTopSim - initialTopSim;
  const base = { initialTopSim, repairedTopSim, simDelta };

  // Anti-sabotage gating: If initial results are strong (>0.6) and repair degrades 
  // similarity, always reject.
  if (initialTopSim > 0.6 && simDelta < 0) {
    return { ...base, accepted: false, reason: 'sabotage-detected' };
  }

  const deltaThreshold = runtimeConfig.repairDeltaThreshold || 0.01;
  if (simDelta < deltaThreshold) {
    return { ...base, accepted: false, reason: 'delta-below-threshold' };
  }

  if (runtimeConfig.repairConfidenceFloor > 0 && repairedTopSim < runtimeConfig.repairConfidenceFloor) {
    return { ...base, accepted: false, reason: 'below-confidence-floor' };
  }

  return { ...base, accepted: true, reason: 'accepted' };
}

export function mergeSearchResults(
  primary: SearchResult[],
  repair: SearchResult[],
  limit: number,
  runtimeConfig: Pick<CoreRuntimeConfig, 'retrievalProfileSettings' | 'maxSearchResults'>,
): SearchResult[] {
  const merged = new Map<string, SearchResult>();
  mergeWeightedResults(merged, primary, runtimeConfig.retrievalProfileSettings.repairPrimaryWeight);
  mergeWeightedResults(merged, repair, runtimeConfig.retrievalProfileSettings.repairRewriteWeight);
  return [...merged.values()].sort((left, right) => right.score - left.score).slice(0, clampLimitWide(limit));
}

export function resolveRerankDepth(
  limit: number,
  runtimeConfig: Pick<CoreRuntimeConfig, 'retrievalProfileSettings'>,
): number {
  return Math.max(clampLimitWide(limit), runtimeConfig.retrievalProfileSettings.rerankDepth);
}

export type QueryComplexityLabel = 'simple' | 'medium' | 'complex' | 'multi-hop' | 'aggregation';

export interface QueryClassification {
  limit: number;
  label: QueryComplexityLabel;
  /** The marker that triggered a multi-hop or aggregation classification, if any. */
  matchedMarker?: string;
}

function applyConfiguredLimit(
  classification: QueryClassification,
  runtimeConfig: AdaptiveLimitConfig,
): QueryClassification {
  const limits: Record<QueryComplexityLabel, number> = {
    simple: runtimeConfig.adaptiveSimpleLimit,
    medium: runtimeConfig.adaptiveMediumLimit,
    complex: runtimeConfig.adaptiveComplexLimit,
    'multi-hop': runtimeConfig.adaptiveMultiHopLimit,
    aggregation: runtimeConfig.adaptiveAggregationLimit,
  };
  return { ...classification, limit: limits[classification.label] };
}

function classifyQueryComplexity(query: string): number {
  return classifyQueryDetailed(query).limit;
}

export function classifyQueryDetailed(query: string): QueryClassification {
  const lower = query.toLowerCase();

  const aggMarker = AGGREGATION_MARKERS.find((m) => lower.includes(m));
  if (aggMarker) return { limit: AGGREGATION_QUERY_LIMIT, label: 'aggregation', matchedMarker: aggMarker };

  const hopMarker = MULTI_HOP_MARKERS.find((m) => new RegExp(m).test(lower));
  if (hopMarker) return { limit: MULTI_HOP_QUERY_LIMIT, label: 'multi-hop', matchedMarker: hopMarker };

  if (isComplexQuery(lower)) return { limit: COMPLEX_QUERY_LIMIT, label: 'complex' };
  if (lower.split(/\s+/).length > 9) return { limit: MEDIUM_QUERY_LIMIT, label: 'medium' };
  if (lower.endsWith('?') && lower.split(/\s+/).length <= 5) return { limit: SIMPLE_QUERY_LIMIT, label: 'simple' };
  return { limit: MEDIUM_QUERY_LIMIT, label: 'medium' };
}

function isMultiHopQuery(lowerQuery: string): boolean {
  return MULTI_HOP_MARKERS.some((marker) => new RegExp(marker).test(lowerQuery));
}

function isComplexQuery(lowerQuery: string): boolean {
  return COMPLEX_MARKERS.some((marker) => lowerQuery.includes(marker));
}

export function isAggregationQuery(lowerQuery: string): boolean {
  return AGGREGATION_MARKERS.some((marker) => lowerQuery.includes(marker));
}

function clampLimit(limit: number, maxSearchResults: number): number {
  return Math.max(1, Math.min(maxSearchResults, Math.floor(limit)));
}

/** Wider clamp for pipeline internals — respects aggregation ceiling, not profile cap. */
function clampLimitWide(limit: number): number {
  return Math.max(1, Math.min(AGGREGATION_HARD_CAP, Math.floor(limit)));
}

function mergeWeightedResults(
  merged: Map<string, SearchResult>,
  results: SearchResult[],
  weight: number,
): void {
  for (const memory of results) {
    const weighted = { ...memory, score: memory.score * weight };
    const existing = merged.get(memory.id);
    if (!existing || weighted.score > existing.score) {
      merged.set(memory.id, weighted);
    }
  }
}
