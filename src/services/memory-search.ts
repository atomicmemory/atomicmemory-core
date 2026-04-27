/**
 * Search and retrieval orchestration for MemoryService.
 * Pure orchestration: delegates formatting to retrieval-format, dedup to
 * composite-dedup, side effects to retrieval-side-effects, lesson recording
 * to lesson-service, and the main retrieval to search-pipeline.
 */

import { type SearchResult } from '../db/memory-repository.js';
import { checkLessons, recordConsensusLessons, type LessonCheckResult } from './lesson-service.js';
import { validateConsensus, type ConsensusResult } from './consensus-validation.js';
import { embedText } from './embedding.js';
import { resolveSearchLimitDetailed, classifyQueryDetailed } from './retrieval-policy.js';
import { runSearchPipelineWithTrace } from './search-pipeline.js';
import { buildCitations as buildRichCitations, buildInjection, computePackagingSignal } from './retrieval-format.js';
import { finalizePackagingTrace } from './packaging-observability.js';
import { isCurrentStateQuery } from './current-state-ranking.js';
import { TraceCollector } from './retrieval-trace.js';
import { excludeStaleComposites } from './composite-staleness.js';
import { applyFlatPackagingPolicy } from './composite-dedup.js';
import { recordSearchSideEffects } from './retrieval-side-effects.js';
import type { AgentScope, WorkspaceContext } from '../db/repository-types.js';
import type { MemoryServiceDeps, RetrievalOptions, RetrievalResult } from './memory-service-types.js';

/** Check lessons safety gate; returns undefined if lessons disabled. */
async function checkSearchLessons(deps: MemoryServiceDeps, userId: string, query: string): Promise<LessonCheckResult | undefined> {
  if (!deps.config.lessonsEnabled || !deps.stores.lesson) return undefined;
  return checkLessons(deps.stores.lesson, userId, query);
}

/** Try to resolve an atomicmem:// URI query. Returns result or null. */
async function tryUriResolution(
  deps: MemoryServiceDeps,
  query: string,
  userId: string,
  retrievalOptions: RetrievalOptions | undefined,
  trace: TraceCollector,
): Promise<RetrievalResult | null> {
  if (!query.startsWith('atomicmem://')) return null;
  const uriTier = retrievalOptions?.retrievalMode === 'flat' ? 'L2' : 'L1';
  const resolved = await deps.uriResolver.resolve(query, userId, uriTier);
  if (!resolved) return null;

  const resultMemories = Array.isArray(resolved.data) ? resolved.data : [resolved.data];
  trace.event('uri-resolution', { uri: query, type: resolved.type, tier: uriTier });
  trace.finalize(resultMemories);
  return {
    memories: resultMemories,
    injectionText: deps.uriResolver.format(resolved),
    citations: resultMemories.map((m: any) => m.id),
    retrievalMode: retrievalOptions?.retrievalMode ?? 'flat',
  };
}

/** Execute the core search (as-of or pipeline). */
async function executeSearchStep(
  deps: MemoryServiceDeps,
  userId: string,
  query: string,
  effectiveLimit: number,
  sourceSite: string | undefined,
  referenceTime: Date | undefined,
  namespaceScope: string | undefined,
  retrievalOptions: RetrievalOptions | undefined,
  asOf: string | undefined,
  trace: TraceCollector,
): Promise<{ memories: SearchResult[]; activeTrace: TraceCollector }> {
  if (asOf) {
    const memories = await deps.stores.claim.searchClaimVersions(userId, await embedText(query, 'query'), effectiveLimit, asOf, sourceSite);
    trace.stage('as-of-search', memories, { asOf });
    return { memories, activeTrace: trace };
  }
  const pipelineStores = { search: deps.stores.search, link: deps.stores.link, memory: deps.stores.memory, entity: deps.stores.entity, pool: deps.stores.pool };
  const pipelineResult = await runSearchPipelineWithTrace(pipelineStores, userId, query, effectiveLimit, sourceSite, referenceTime, {
    namespaceScope,
    retrievalMode: retrievalOptions?.retrievalMode,
    searchStrategy: retrievalOptions?.searchStrategy,
    skipRepairLoop: retrievalOptions?.skipRepairLoop,
    skipReranking: retrievalOptions?.skipReranking,
    runtimeConfig: deps.config,
  });
  return { memories: pipelineResult.filtered, activeTrace: pipelineResult.trace };
}

/** Filter workspace-scoped, stale composites, and consensus-violating memories. */
async function postProcessResults(
  deps: MemoryServiceDeps,
  rawMemories: SearchResult[],
  activeTrace: TraceCollector,
  userId: string,
  query: string,
  asOf: string | undefined,
): Promise<{ memories: SearchResult[]; consensusResult?: ConsensusResult }> {
  let memories = rawMemories.filter((m) => !m.workspace_id);

  if (!asOf) {
    const compositeResult = await excludeStaleComposites(deps.stores.memory, userId, memories);
    if (compositeResult.removedCompositeIds.length > 0) {
      memories = compositeResult.filtered;
      activeTrace.stage('stale-composite-filter', memories, {
        removedCount: compositeResult.removedCompositeIds.length,
        removedIds: compositeResult.removedCompositeIds,
      });
    }
  }

  if (!deps.config.consensusValidationEnabled || memories.length < deps.config.consensusMinMemories) {
    return { memories };
  }

  const consensusResult = await validateConsensus(query, memories);
  if (consensusResult.removedMemoryIds.length > 0) {
    const removedSet = new Set(consensusResult.removedMemoryIds);
    memories = memories.filter((m) => !removedSet.has(m.id));
    activeTrace.stage('consensus-filter', memories, {
      removedCount: consensusResult.removedMemoryIds.length,
      removedIds: consensusResult.removedMemoryIds,
    });
    if (deps.config.lessonsEnabled && deps.stores.lesson) {
      recordConsensusLessons(deps.stores.lesson, userId, consensusResult, memories).catch(
        (err) => console.error('Consensus lesson recording failed:', err),
      );
    }
  }
  return { memories, consensusResult };
}

/** Package memories, build injection text, and assemble the final response. */
function assembleResponse(
  deps: MemoryServiceDeps,
  postProcessed: { memories: SearchResult[]; consensusResult?: ConsensusResult },
  query: string,
  userId: string,
  activeTrace: TraceCollector,
  retrievalOptions: RetrievalOptions | undefined,
  asOf: string | undefined,
  sourceSite: string | undefined,
  lessonCheck: LessonCheckResult | undefined,
): RetrievalResult {
  const mode = retrievalOptions?.retrievalMode ?? 'flat';
  const packaged = applyFlatPackagingPolicy(postProcessed.memories, query, mode, activeTrace);
  const outputMemories = isCurrentStateQuery(query) ? packaged.sort((a, b) => b.score - a.score) : packaged;

  recordSearchSideEffects(deps, outputMemories, userId, query, sourceSite, asOf);

  const { injectionText, tierAssignments, expandIds, estimatedContextTokens } =
    buildInjection(outputMemories, query, mode, retrievalOptions?.tokenBudget);
  const { packagingSummary, assemblySummary } = finalizePackagingTrace(activeTrace, {
    outputMemories, mode, injectionText, estimatedContextTokens, tierAssignments,
    tokenBudget: retrievalOptions?.tokenBudget,
  });
  activeTrace.finalize(outputMemories);

  return {
    memories: outputMemories, injectionText,
    citations: buildRichCitations(outputMemories).map((c) => c.memory_id),
    retrievalMode: mode, tierAssignments, expandIds, estimatedContextTokens,
    lessonCheck, consensusResult: postProcessed.consensusResult,
    packagingSignal: computePackagingSignal(outputMemories),
    retrievalSummary: activeTrace.getRetrievalSummary(),
    packagingSummary, assemblySummary,
  };
}

/** Full search with lesson check, URI resolution, pipeline, post-processing, and packaging. */
export async function performSearch(
  deps: MemoryServiceDeps,
  userId: string,
  query: string,
  sourceSite?: string,
  limit?: number,
  asOf?: string,
  referenceTime?: Date,
  namespaceScope?: string,
  retrievalOptions?: RetrievalOptions,
): Promise<RetrievalResult> {
  const lessonCheck = await checkSearchLessons(deps, userId, query);
  if (lessonCheck && !lessonCheck.safe) {
    return { memories: [], injectionText: '', citations: [], retrievalMode: retrievalOptions?.retrievalMode ?? 'flat', lessonCheck };
  }

  const { limit: effectiveLimit, classification } = resolveSearchLimitDetailed(query, limit, deps.config);
  const trace = new TraceCollector(query, userId);
  trace.event('query-classification', { label: classification.label, limit: effectiveLimit, matchedMarker: classification.matchedMarker });

  const uriResult = await tryUriResolution(deps, query, userId, retrievalOptions, trace);
  if (uriResult) return uriResult;

  const { memories: rawMemories, activeTrace } = await executeSearchStep(deps, userId, query, effectiveLimit, sourceSite, referenceTime, namespaceScope, retrievalOptions, asOf, trace);
  const filteredMemories = await postProcessResults(deps, rawMemories, activeTrace, userId, query, asOf);
  return assembleResponse(deps, filteredMemories, query, userId, activeTrace, retrievalOptions, asOf, sourceSite, lessonCheck);
}

/**
 * Latency-optimized search that skips repair/reranking for simple and medium
 * queries, but escalates to the full pipeline for multi-hop, aggregation, and
 * complex queries where the LLM rewrite materially improves retrieval.
 */
export async function performFastSearch(
  deps: MemoryServiceDeps,
  userId: string,
  query: string,
  sourceSite?: string,
  limit?: number,
  namespaceScope?: string,
): Promise<RetrievalResult> {
  const label = classifyQueryDetailed(query).label;
  const escalate = label === 'multi-hop' || label === 'aggregation' || label === 'complex';
  return performSearch(deps, userId, query, sourceSite, limit, undefined, undefined, namespaceScope, {
    skipRepairLoop: !escalate,
    skipReranking: !escalate,
  });
}

/**
 * Workspace-scoped search: retrieves memories from the workspace memory pool.
 * Uses workspace-filtered vector search with agent scope and visibility enforcement.
 */
export async function performWorkspaceSearch(
  deps: MemoryServiceDeps,
  userId: string,
  query: string,
  workspace: WorkspaceContext,
  options: {
    agentScope?: AgentScope;
    limit?: number;
    referenceTime?: Date;
    retrievalOptions?: RetrievalOptions;
  } = {},
): Promise<RetrievalResult> {
  const { limit: effectiveLimit } = resolveSearchLimitDetailed(query, options.limit, deps.config);
  const queryEmbedding = await embedText(query, 'query');

  const memories = await deps.stores.search.searchSimilarInWorkspace(
    workspace.workspaceId, queryEmbedding, effectiveLimit,
    options.agentScope ?? 'all', workspace.agentId, options.referenceTime,
  );
  const { filtered: filteredMemories } = await excludeStaleComposites(deps.stores.memory, userId, memories);
  for (const m of filteredMemories) deps.stores.memory.touchMemory(m.id).catch(() => {});

  const mode = options.retrievalOptions?.retrievalMode ?? 'flat';
  const injection = buildInjection(filteredMemories, query, mode, options.retrievalOptions?.tokenBudget);
  return {
    memories: filteredMemories,
    citations: filteredMemories.map((m) => m.id),
    retrievalMode: mode,
    ...injection,
  };
}
