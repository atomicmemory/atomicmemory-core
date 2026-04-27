/**
 * Provenance-first retrieval formatting helpers.
 *
 * Supports two modes:
 *   - Full: each memory's complete content is included (default)
 *   - Staged (L0): only summaries are included, with memory IDs for
 *     on-demand expansion via POST /v1/memories/expand. Reduces injection
 *     tokens by ~80% for typical workloads.
 */

import { config } from '../config.js';
import type { SearchResult } from '../db/memory-repository.js';
import type { ContextTier, TierAssignment } from './tiered-loading.js';
import {
  assignTiers as assignTierBudgets,
  estimateTokens,
  getContentAtTier,
} from './tiered-loading.js';
import { isAnswerBearing, sortBySessionPriority } from './session-packaging.js';
import { deduplicateCompositeMembersHard } from './composite-dedup.js';
import { prefersAbstractAwareRetrieval } from './abstract-query-policy.js';
import type { RetrievalMode } from './memory-service-types.js';
import { escapeXml } from '../xml-escape.js';
import { spansMultipleDates, buildTimelinePack, formatTimelinePack } from './timeline-pack.js';
import { buildRepeatedEventEndpointBlock } from './temporal-endpoint-evidence.js';
import { preserveQueryTermVisibility, sumAssignmentTokens } from './query-term-visibility.js';
import { formatDateLabel, formatDuration } from './temporal-format.js';

/**
 * Packaging observability signal — records whether and how packaging
 * reordered memories vs. raw retrieval score order. Enables A/B evals
 * to distinguish packaging-caused flips from retrieval noise.
 */
export interface PackagingSignal {
  /** True if packaging changed the memory order from score-descending. */
  reordered: boolean;
  /** Number of distinct episodes (sessions) in the result set. */
  episodeCount: number;
  /** Number of memories classified as answer-bearing by session-packaging heuristics. */
  answerBearingCount: number;
  /** Number of memories classified as context (non-answer-bearing). */
  contextCount: number;
  /** Kendall tau distance: number of pairwise swaps between score order and packaged order (0 = identical). */
  reorderDistance: number;
}

/**
 * Compare score-descending order to the order produced by packaging
 * (session-priority sort, answer-bearing promotion, chronological).
 */
export function computePackagingSignal(memories: SearchResult[]): PackagingSignal {
  if (memories.length === 0) {
    return { reordered: false, episodeCount: 0, answerBearingCount: 0, contextCount: 0, reorderDistance: 0 };
  }

  const scoreOrder = [...memories].sort((a, b) => b.score - a.score).map((m) => m.id);
  const packagedOrder = sortBySessionPriority(memories).map((m) => m.id);

  const reordered = !scoreOrder.every((id, i) => id === packagedOrder[i]);
  const episodeCount = new Set(memories.map((m) => m.episode_id).filter(Boolean)).size;
  const answerBearingCount = memories.filter((m) => isAnswerBearing(m.content)).length;
  const contextCount = memories.length - answerBearingCount;
  const reorderDistance = kendallTauDistance(scoreOrder, packagedOrder);

  return { reordered, episodeCount, answerBearingCount, contextCount, reorderDistance };
}

/** Count pairwise inversions between two orderings of the same IDs. */
function kendallTauDistance(orderA: string[], orderB: string[]): number {
  const posB = new Map(orderB.map((id, i) => [id, i]));
  let inversions = 0;
  for (let i = 0; i < orderA.length; i++) {
    for (let j = i + 1; j < orderA.length; j++) {
      const posI = posB.get(orderA[i]) ?? 0;
      const posJ = posB.get(orderA[j]) ?? 0;
      if (posI > posJ) inversions++;
    }
  }
  return inversions;
}

export interface RetrievalCitation {
  memory_id: string;
  source_site: string;
  created_at: string;
  importance: number;
}

export interface RetrievalFormatOptions {
  stagedLoadingEnabled?: boolean;
}

export function buildCitations(memories: SearchResult[]): RetrievalCitation[] {
  return memories.map((memory) => ({
    memory_id: memory.id,
    source_site: memory.source_site,
    created_at: memory.created_at.toISOString(),
    importance: memory.importance,
  }));
}

/** Sort memories by created_at ascending so temporal order is preserved in presentation. */
function sortChronologically(memories: SearchResult[]): SearchResult[] {
  return [...memories].sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
}

/**
 * A2 injection: session-priority sort with answer-bearing tags, grouped by
 * namespace. Flat subject headers for all groups (no timeline packs).
 * Used by the packaging ablation to isolate session-pack effects from
 * timeline-pack effects.
 */
function formatSessionPackInjection(memories: SearchResult[]): string {
  if (memories.length === 0) return '';
  const groups = groupByNamespace(memories);
  const sections = [...groups.entries()].map(([ns, groupMemories]) =>
    formatSubjectSection(ns, groupMemories),
  );
  return appendTemporalSummary(sections, memories);
}

/** Simple dash-delimited injection format (no XML). */
export function formatSimpleInjection(memories: SearchResult[]): string {
  if (memories.length === 0) return '';
  const groups = groupByNamespace(memories);
  const sections = [...groups.entries()].map(([ns, groupMemories]) => {
    if (spansMultipleDates(groupMemories)) {
      const pack = buildTimelinePack(ns, groupMemories);
      return formatTimelinePack(pack);
    }
    return formatSubjectSection(ns, groupMemories);
  });
  return appendTemporalSummary(sections, memories);
}

/** Group memories by namespace for subject-partitioned injection. */
function groupByNamespace(memories: SearchResult[]): Map<string, SearchResult[]> {
  const groups = new Map<string, SearchResult[]>();
  for (const m of memories) {
    const ns = m.namespace || 'general';
    if (!groups.has(ns)) groups.set(ns, []);
    groups.get(ns)!.push(m);
  }
  return groups;
}

/** Format a single namespace group as a subject section with answer/context labels. */
function formatSubjectSection(ns: string, groupMemories: SearchResult[]): string {
  const sorted = sortBySessionPriority(groupMemories);
  const lines = sorted.map((m) => {
    const date = m.created_at.toISOString().slice(0, 10);
    const kind = isAnswerBearing(m.content) ? 'answer' : 'context';
    return `- [${date}] [${kind}] ${m.content}`;
  }).join('\n');
  return `### Subject: ${ns}\n${lines}`;
}

/** Join sections and append temporal summary if present. */
function appendTemporalSummary(sections: string[], memories: SearchResult[]): string {
  const sortedAll = sortChronologically(memories);
  const timeline = buildTemporalSummary(sortedAll);
  const mainContent = sections.join('\n\n');
  return timeline ? `${mainContent}\n\n${timeline}` : mainContent;
}

/**
 * Build a timeline summary with computed time gaps between distinct dates.
 * Helps weak LLMs answer temporal questions without doing date arithmetic.
 */
function buildTemporalSummary(sortedMemories: SearchResult[]): string {
  const uniqueDates = getUniqueDates(sortedMemories);
  if (uniqueDates.length < 2) return '';

  const gaps: string[] = [];
  for (let i = 1; i < uniqueDates.length; i++) {
    const prev = uniqueDates[i - 1];
    const curr = uniqueDates[i];
    const diffMs = curr.getTime() - prev.getTime();
    const diffDays = Math.round(diffMs / 86400000);
    if (diffDays === 0) continue;
    const duration = formatDuration(diffDays);
    gaps.push(`- ${formatDateLabel(prev)} → ${formatDateLabel(curr)}: ${duration}`);
  }

  if (gaps.length === 0) return '';

  const first = uniqueDates[0];
  const last = uniqueDates[uniqueDates.length - 1];
  const totalDays = Math.round((last.getTime() - first.getTime()) / 86400000);
  const totalLine = `Total span: ${formatDateLabel(first)} to ${formatDateLabel(last)} (${formatDuration(totalDays)})`;
  const evidenceLines = buildTemporalEvidenceLines(sortedMemories, uniqueDates);
  const evidenceBlock = evidenceLines.length > 0
    ? `\nKey temporal evidence:\n${evidenceLines.join('\n')}`
    : '';

  return `Timeline:\n${gaps.join('\n')}\n${totalLine}${evidenceBlock}`;
}

function getUniqueDates(memories: SearchResult[]): Date[] {
  const seen = new Set<string>();
  const dates: Date[] = [];
  for (const m of memories) {
    const key = m.created_at.toISOString().slice(0, 10);
    if (!seen.has(key)) {
      seen.add(key);
      dates.push(m.created_at);
    }
  }
  return dates;
}

function buildTemporalEvidenceLines(
  memories: SearchResult[],
  dates: Date[],
): string[] {
  return dates
    .slice(0, 4)
    .map((date) => buildTemporalEvidenceLine(memories, date))
    .filter((line): line is string => line !== null);
}

function buildTemporalEvidenceLine(memories: SearchResult[], date: Date): string | null {
  const key = formatDateLabel(date);
  const sameDate = memories.filter((memory) => formatDateLabel(memory.created_at) === key);
  const selected = sameDate.find((memory) => isAnswerBearing(memory.content)) ?? sameDate[0];
  if (!selected) return null;
  return `- ${key}: ${truncateTemporalEvidence(selected.content)}`;
}

function truncateTemporalEvidence(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177)}...`;
}

export function formatInjection(
  memories: SearchResult[],
  options: RetrievalFormatOptions = {},
): string {
  if (memories.length === 0) return '';
  const stagedLoadingEnabled = options.stagedLoadingEnabled ?? config.stagedLoadingEnabled;
  if (stagedLoadingEnabled) return formatStagedInjection(memories);
  return formatFullInjection(memories);
}

function formatFullInjection(memories: SearchResult[]): string {
  const sorted = sortChronologically(memories);
  const lines = sorted.map((memory, index) => formatFullLine(memory, index));
  return `<atomicmem_context count="${memories.length}">\n${lines.join('\n')}\n</atomicmem_context>`;
}

function formatStagedInjection(memories: SearchResult[]): string {
  const sorted = sortChronologically(memories);
  const lines = sorted.map((memory, index) => formatStagedLine(memory, index));
  const ids = sorted.map((m) => m.id).join(',');
  return [
    `<atomicmem_context count="${memories.length}" mode="staged" expand_ids="${ids}">`,
    lines.join('\n'),
    '<expand_hint>To see full content for any memory, request expansion by ID.</expand_hint>',
    '</atomicmem_context>',
  ].join('\n');
}

function formatFullLine(memory: SearchResult, index: number): string {
  const attrs = buildCommonAttrs(memory, index);
  return `<memory ${attrs}>\n${escapeXml(memory.content)}\n</memory>`;
}

function formatStagedLine(memory: SearchResult, index: number): string {
  const attrs = buildCommonAttrs(memory, index);
  const summary = memory.summary || truncateContent(memory.content);
  return `<memory ${attrs} staged="true">\n${escapeXml(summary)}\n</memory>`;
}

function buildCommonAttrs(memory: SearchResult, index: number): string {
  return [
    `index="${index + 1}"`,
    `source="${escapeXml(memory.source_site)}"`,
    `memory_id="${memory.id}"`,
    `created_at="${memory.created_at.toISOString()}"`,
    `importance="${memory.importance.toFixed(1)}"`,
    `similarity="${memory.similarity.toFixed(2)}"`,
    `score="${memory.score.toFixed(2)}"`,
    `age="${formatAge(memory.created_at)}"`,
  ].join(' ');
}

const STAGED_TRUNCATE_LENGTH = 60;

/** Fallback when no summary is stored: first 60 chars + ellipsis. */
function truncateContent(content: string): string {
  if (content.length <= STAGED_TRUNCATE_LENGTH) return content;
  return content.slice(0, STAGED_TRUNCATE_LENGTH) + '...';
}


/**
 * Format injection using tier assignments from the budget allocator.
 * Uses a compact line-oriented format so tier metadata does not erase
 * the token savings from L0/L1 compression.
 */
export function formatTieredInjection(
  memories: SearchResult[],
  assignments: TierAssignment[],
  query = '',
): string {
  if (memories.length === 0) return '';
  const sorted = sortChronologically(memories);
  const tierMap = new Map(assignments.map((a) => [a.memoryId, a.tier]));
  const lines = sorted.map((memory) => {
    const tier = tierMap.get(memory.id) ?? 'L0';
    return formatTieredLine(memory, tier);
  });
  const expandableIds = assignments
    .filter((a) => a.tier !== 'L2')
    .map((a) => a.memoryId)
    .join(',');
  const sections = expandableIds
    ? [lines.join('\n'), `Expandable IDs: ${expandableIds}`]
    : [lines.join('\n')];
  const repeatedEventEndpoints = buildRepeatedEventEndpointBlock(sorted, query);
  const enrichedSections = repeatedEventEndpoints
    ? [...sections, repeatedEventEndpoints]
    : sections;
  return appendTemporalSummary(enrichedSections, memories);
}

function formatTieredLine(memory: SearchResult, tier: ContextTier): string {
  const date = memory.created_at.toISOString().slice(0, 10);
  const kind = memory.memory_type === 'composite' ? 'composite' : 'atomic';
  const content = getContentAtTier(memory, tier);
  return `- [${date}] [${tier}] [${kind}] ${content}`;
}

function formatAge(date: Date): string {
  const hours = (Date.now() - date.getTime()) / 3600000;
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

const DEFAULT_INJECTION_TOKEN_BUDGET = 2000;

export interface InjectionBuildResult {
  injectionText: string;
  tierAssignments?: TierAssignment[];
  expandIds?: string[];
  estimatedContextTokens?: number;
}

/**
 * Build injection text from search results, optionally using tiered packaging.
 * Flat mode returns the existing chronological format.
 * Tiered mode assigns L0/L1/L2 tiers under a token budget.
 */
export function buildInjection(
  memories: SearchResult[],
  query: string,
  mode: RetrievalMode,
  tokenBudget?: number,
): InjectionBuildResult {
  if (memories.length === 0) {
    return { injectionText: '' };
  }

  if (mode === 'flat') {
    return { injectionText: formatSimpleInjection(memories) };
  }

  const deduplicated = deduplicateCompositeMembersHard(memories);
  const budget = tokenBudget ?? DEFAULT_INJECTION_TOKEN_BUDGET;
  const forceRichTopHit = prefersAbstractAwareRetrieval(mode, query);

  // Compute the repeated-event endpoint block before tier assignment so
  // its token cost is subtracted from the assignment budget. Otherwise the
  // appended block silently exceeds the caller's budget and is missing
  // from estimatedContextTokens. The block is appended inside
  // formatTieredInjection; we just account for its tokens up front.
  const sortedForEndpoints = sortChronologically(deduplicated);
  const endpointBlock = buildRepeatedEventEndpointBlock(sortedForEndpoints, query);
  const endpointTokens = endpointBlock ? estimateTokens(endpointBlock) : 0;
  const assignmentBudget = Math.max(0, budget - endpointTokens);

  const result = assignTierBudgets(deduplicated, assignmentBudget, { forceRichTopHit });
  const assignments = preserveQueryTermVisibility(deduplicated, result.assignments, query, assignmentBudget);
  const expandIds = assignments
    .filter((a) => a.tier !== 'L2')
    .map((a) => a.memoryId);

  return {
    injectionText: formatTieredInjection(deduplicated, assignments, query),
    tierAssignments: assignments,
    expandIds: expandIds.length > 0 ? expandIds : undefined,
    estimatedContextTokens: sumAssignmentTokens(assignments) + endpointTokens,
  };
}
