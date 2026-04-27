/**
 * Search and link pipeline — orchestrates retrieval (search → repair loop →
 * expansion → MMR → trace) and post-ingest link generation.
 *
 * Extracted from MemoryService to keep that file focused on ingest orchestration.
 */

import { config } from '../config.js';
import type pg from 'pg';
import type { CoreRuntimeConfig } from '../app/runtime-container.js';
import type { SearchResult } from '../db/repository-types.js';
import type { SearchStore, SemanticLinkStore, MemoryStore, EntityStore } from '../db/stores.js';
import { embedText } from './embedding.js';
import { rewriteQuery } from './extraction.js';
import {
  resolveRerankDepth,
  shouldRunRepairLoop,
  shouldAcceptRepair,
} from './retrieval-policy.js';
import { applyMMR } from '../db/mmr.js';
import { personalizedPageRank } from '../db/ppr.js';
import { TraceCollector } from './retrieval-trace.js';
import { isInScope } from './namespace-retrieval.js';
import { expandQueryViaEntities, augmentQueryWithEntities, coRetrieveByEntityNames } from './query-expansion.js';
import { rerankCandidates } from './reranker.js';
import { shouldUseAbstractHybridFallback } from './abstract-query-policy.js';
import { applyAgenticRetrieval } from './agentic-retrieval.js';
import type { RetrievalMode, SearchStrategy } from './memory-service-types.js';
import { timed } from './timing.js';
import { expandTemporalQuery } from './temporal-query-expansion.js';
import { preserveProtectedResults } from './temporal-result-protection.js';
import { buildTemporalFingerprint } from './temporal-fingerprint.js';
import { expandLiteralQuery, isLiteralDetailQuery } from './literal-query-expansion.js';
import { applySubjectAwareRanking, expandSubjectQuery } from './subject-aware-ranking.js';
import { DEFAULT_RRF_K, weightedRRF } from './rrf-fusion.js';
import { applyIterativeRetrieval } from './iterative-retrieval.js';
import { applyCurrentStateRanking } from './current-state-ranking.js';
import { applyConcisenessPenalty } from './conciseness-preference.js';
import { protectLiteralListAnswerCandidates } from './literal-list-protection.js';
import { applyTemporalQueryConstraints } from './temporal-query-constraints.js';

const TEMPORAL_NEIGHBOR_WINDOW_MINUTES = 30;
const SEMANTIC_RRF_WEIGHT = 1.2;
const ENTITY_RRF_WEIGHT = 1.3;
const KEYWORD_RRF_WEIGHT = 1.0;

export type SearchPipelineRuntimeConfig = Pick<
  CoreRuntimeConfig,
  | 'adaptiveRetrievalEnabled'
  | 'adaptiveSimpleLimit'
  | 'adaptiveMediumLimit'
  | 'adaptiveComplexLimit'
  | 'adaptiveMultiHopLimit'
  | 'adaptiveAggregationLimit'
  | 'agenticRetrievalEnabled'
  | 'crossEncoderDtype'
  | 'crossEncoderEnabled'
  | 'crossEncoderModel'
  | 'entityGraphEnabled'
  | 'entitySearchMinSimilarity'
  | 'hybridSearchEnabled'
  | 'iterativeRetrievalEnabled'
  | 'linkExpansionBeforeMMR'
  | 'linkExpansionEnabled'
  | 'linkExpansionMax'
  | 'linkSimilarityThreshold'
  | 'literalListProtectionEnabled'
  | 'literalListProtectionMaxProtected'
  | 'maxSearchResults'
  | 'mmrEnabled'
  | 'mmrLambda'
  | 'pprDamping'
  | 'pprEnabled'
  | 'queryAugmentationEnabled'
  | 'queryAugmentationMaxEntities'
  | 'queryAugmentationMinSimilarity'
  | 'queryExpansionEnabled'
  | 'queryExpansionMinSimilarity'
  | 'repairConfidenceFloor'
  | 'repairDeltaThreshold'
  | 'repairLoopEnabled'
  | 'repairLoopMinSimilarity'
  | 'rerankSkipMinGap'
  | 'rerankSkipTopSimilarity'
  | 'retrievalProfileSettings'
  | 'temporalQueryConstraintBoost'
  | 'temporalQueryConstraintEnabled'
>;
/**
 * Decide whether to auto-skip cross-encoder reranking.
 * Skip when the top vector result is high-confidence and well-separated
 * from the runner-up — reranking rarely changes the ranking in this case.
 * Thresholds are configurable via RERANK_SKIP_TOP_SIMILARITY (default 0.85)
 * and RERANK_SKIP_MIN_GAP (default 0.05). Saves ~150ms per query on CPU.
 */
function shouldAutoSkipReranking(
  results: SearchResult[],
  policyConfig: Pick<SearchPipelineRuntimeConfig, 'rerankSkipTopSimilarity' | 'rerankSkipMinGap'> = config,
): boolean {
  if (results.length < 2) return true;
  const topSim = results[0]?.score ?? 0;
  const secondSim = results[1]?.score ?? 0;
  return topSim >= policyConfig.rerankSkipTopSimilarity
    && (topSim - secondSim) >= policyConfig.rerankSkipMinGap;
}

export interface SearchPipelineOptions {
  namespaceScope?: string;
  retrievalMode?: RetrievalMode;
  searchStrategy?: SearchStrategy;
  /** Skip the LLM repair loop for latency-critical paths (UC1: <200ms). */
  skipRepairLoop?: boolean;
  /** Skip cross-encoder reranking for latency-critical paths. */
  skipReranking?: boolean;
  /**
   * Runtime-owned config threaded through all search-pipeline helpers.
   * When present, gates and thresholds across the entire retrieval path
   * read from this instead of the static module-level config singleton.
   * Falls back to the static config import if omitted.
   */
  runtimeConfig?: SearchPipelineRuntimeConfig;
}

/** Focused store bundle for search-pipeline functions. */
export interface SearchPipelineStores {
  search: SearchStore;
  link: SemanticLinkStore;
  memory: MemoryStore;
  entity: EntityStore | null;
  /** Raw pool access — only used by personalizedPageRank. */
  pool: pg.Pool;
}

/**
 * Core search pipeline implementation with explicit trace collection.
 */
export async function runSearchPipelineWithTrace(
  stores: SearchPipelineStores,
  userId: string,
  query: string,
  limit: number,
  sourceSite?: string,
  referenceTime?: Date,
  options: SearchPipelineOptions = {},
): Promise<{ filtered: SearchResult[]; trace: TraceCollector }> {
  const trace = new TraceCollector(query, userId);
  const policyConfig: SearchPipelineRuntimeConfig = options.runtimeConfig ?? config;
  const mmrPoolMultiplier = policyConfig.mmrEnabled ? 3 : 1;
  const candidateDepth = resolveRerankDepth(limit, policyConfig) * mmrPoolMultiplier;

  // Phase 1: Embed the raw query to use for entity matching
  const rawQueryEmbedding = await timed('search.embed', () => embedText(query, 'query'));

  // Phase 2: Entity-grounded query augmentation (zero-LLM)
  const augmentation = await timed('search.augmentation', () => applyQueryAugmentation(
    stores, userId, query, rawQueryEmbedding, trace, policyConfig,
  ));
  const queryEmbedding = augmentation.augmentedEmbedding;
  const searchQuery = augmentation.searchQuery;

  const initialResults = await timed('search.vector', () => runInitialRetrieval(
    stores, userId, searchQuery, queryEmbedding, candidateDepth, sourceSite, referenceTime, options.searchStrategy, policyConfig,
  ));
  const seededResults = await timed('search.hybrid-fallback', () => maybeApplyAbstractHybridFallback(
    stores, userId, query, searchQuery, queryEmbedding, candidateDepth, sourceSite, referenceTime,
    options.retrievalMode, options.searchStrategy, initialResults, trace, policyConfig,
  ));

  console.log(`[search] Query: "${query}", Results: ${seededResults.length}`);

  trace.stage('initial', seededResults, {
    candidateDepth,
    hybrid: policyConfig.hybridSearchEnabled,
    augmentation: {
      searchQuery,
      matched: searchQuery !== query,
    },
  });

  // Entity name co-retrieval
  const withCoRetrieval = await timed('search.co-retrieval', () => applyEntityNameCoRetrieval(
    stores, userId, query, queryEmbedding, seededResults, candidateDepth, trace, policyConfig,
  ));

  const withSubjectExpansion = await timed('search.subject-query-expansion', () => applySubjectQueryExpansion(
    stores, userId, query, queryEmbedding, withCoRetrieval, candidateDepth, trace,
  ));

  const withLiteralExpansion = await timed('search.literal-query-expansion', () => applyLiteralQueryExpansion(
    stores, userId, query, queryEmbedding, withSubjectExpansion, candidateDepth, trace,
  ));

  const temporalExpansion = await timed('search.temporal-query-expansion', () => applyTemporalQueryExpansion(
    stores, userId, query, queryEmbedding, withLiteralExpansion, candidateDepth, referenceTime, trace,
  ));

  // Query expansion
  const withExpansion = await timed('search.query-expansion', () => applyQueryExpansion(
    stores, userId, query, queryEmbedding, temporalExpansion.memories, candidateDepth, trace, policyConfig,
  ));

  const repaired = options.skipRepairLoop
    ? { memories: withExpansion, queryText: searchQuery }
    : await timed('search.repair-loop', () => applyRepairLoop(
      stores,
      query,
      queryEmbedding,
      withExpansion,
      candidateDepth,
      userId,
      sourceSite,
      referenceTime,
      trace,
      policyConfig,
      options.searchStrategy,
      temporalExpansion.temporalAnchorFingerprints,
    ));

  const iterated = await timed('search.iterative-retrieval', async () => {
    if (!policyConfig.iterativeRetrievalEnabled) return repaired.memories;
    const iterative = await applyIterativeRetrieval(
      stores.search,
      userId,
      query,
      queryEmbedding,
      repaired.memories,
      candidateDepth,
      sourceSite,
      referenceTime,
    );
    if (iterative.triggered) {
      trace.stage('iterative-retrieval', iterative.memories, {
        estimatedFactCount: iterative.estimatedFactCount,
        seedIds: iterative.seedIds,
        reason: iterative.reason,
      });
    }
    return iterative.memories;
  });

  // Agentic multi-round retrieval
  const results = await timed('search.agentic-retrieval', async () => {
    if (!policyConfig.agenticRetrievalEnabled) return iterated;
    const agenticResult = await applyAgenticRetrieval(
      stores.search, userId, query, iterated, candidateDepth, sourceSite, referenceTime, policyConfig,
    );
    if (agenticResult.triggered) {
      trace.stage('agentic-retrieval', agenticResult.memories, {
        subQueries: agenticResult.subQueries,
        reason: agenticResult.reason,
      });
    }
    return agenticResult.memories;
  });

  const selected = await timed('search.expansion-reranking', () => applyExpansionAndReranking(
    stores,
    userId,
    searchQuery,
    results,
    queryEmbedding,
    limit,
    referenceTime,
    temporalExpansion.temporalAnchorFingerprints,
    trace,
    options.skipReranking,
    policyConfig,
  ));

  const namespaceScope = options.namespaceScope ?? null;
  trace.setRetrievalSummary({
    candidateIds: selected.map((result) => result.id),
    candidateCount: selected.length,
    queryText: repaired.queryText,
    skipRepair: options.skipRepairLoop ?? false,
  });
  if (namespaceScope) {
    trace.event('namespace-filtering', { scope: namespaceScope });
  }
  const filtered = namespaceScope
    ? selected.filter((r) => isInScope(r.namespace, namespaceScope))
    : selected;

  return { filtered, trace };
}

async function runInitialRetrieval(
  stores: SearchPipelineStores,
  userId: string,
  searchQuery: string,
  queryEmbedding: number[],
  candidateDepth: number,
  sourceSite?: string,
  referenceTime?: Date,
  searchStrategy: SearchStrategy = 'memory',
  policyConfig: SearchPipelineRuntimeConfig = config,
): Promise<SearchResult[]> {
  if (searchStrategy === 'fact-hybrid') {
    return stores.search.searchAtomicFactsHybrid(
      userId,
      searchQuery,
      queryEmbedding,
      candidateDepth,
      sourceSite,
      referenceTime,
    );
  }
  return runMemoryRrfRetrieval(
    stores,
    userId,
    searchQuery,
    queryEmbedding,
    candidateDepth,
    sourceSite,
    referenceTime,
    policyConfig.hybridSearchEnabled,
    policyConfig,
  );
}

async function maybeApplyAbstractHybridFallback(
  stores: SearchPipelineStores,
  userId: string,
  rawQuery: string,
  searchQuery: string,
  queryEmbedding: number[],
  candidateDepth: number,
  sourceSite: string | undefined,
  referenceTime: Date | undefined,
  retrievalMode: RetrievalMode | undefined,
  searchStrategy: SearchStrategy | undefined,
  initialResults: SearchResult[],
  trace: TraceCollector,
  policyConfig: SearchPipelineRuntimeConfig = config,
): Promise<SearchResult[]> {
  if (searchStrategy === 'fact-hybrid') return initialResults;
  if (policyConfig.hybridSearchEnabled || policyConfig.entityGraphEnabled) return initialResults;
  if (!shouldUseAbstractHybridFallback(retrievalMode, rawQuery, initialResults.length)) {
    return initialResults;
  }
  const fallbackResults = await runMemoryRrfRetrieval(
    stores,
    userId,
    searchQuery,
    queryEmbedding,
    candidateDepth,
    sourceSite,
    referenceTime,
    true,
    policyConfig,
  );
  trace.stage('abstract-hybrid-fallback', fallbackResults, { candidateDepth });
  return fallbackResults;
}

/**
 * Run the repair loop: rewrite the query and merge results if improvement is detected.
 */
async function applyRepairLoop(
  stores: SearchPipelineStores,
  query: string,
  queryEmbedding: number[],
  initialResults: SearchResult[],
  candidateDepth: number,
  userId: string,
  sourceSite: string | undefined,
  referenceTime: Date | undefined,
  trace: TraceCollector,
  policyConfig: SearchPipelineRuntimeConfig,
  searchStrategy: SearchStrategy = 'memory',
  protectedIds: string[] = [],
): Promise<{ memories: SearchResult[]; queryText: string }> {
  if (!shouldRunRepairLoop(query, initialResults, policyConfig)) {
    return { memories: initialResults, queryText: query };
  }

  const rewrittenQuery = await rewriteQuery(query);
  if (rewrittenQuery === query) {
    trace.stage('repair-skipped', initialResults, { reason: 'rewrite-unchanged' });
    return { memories: initialResults, queryText: query };
  }

  const rewrittenEmbedding = await embedText(rewrittenQuery, 'query');
  const repairedResults = searchStrategy === 'fact-hybrid'
    ? await stores.search.searchAtomicFactsHybrid(userId, rewrittenQuery, rewrittenEmbedding, candidateDepth, sourceSite, referenceTime)
    : await runMemoryRrfRetrieval(
      stores,
      userId,
      rewrittenQuery,
      rewrittenEmbedding,
      candidateDepth,
      sourceSite,
      referenceTime,
      policyConfig.hybridSearchEnabled,
      policyConfig,
    );

  const decision = shouldAcceptRepair(initialResults, repairedResults, policyConfig);
  if (decision.accepted) {
    const mergedPool = mergeStageResults(
      initialResults,
      repairedResults,
      initialResults.length + repairedResults.length,
      policyConfig.retrievalProfileSettings.repairPrimaryWeight,
      policyConfig.retrievalProfileSettings.repairRewriteWeight,
    );
    const merged = preserveProtectedResults(
      mergedPool.slice(0, candidateDepth),
      mergedPool,
      protectedIds,
      candidateDepth,
    );
    trace.stage('repair-accepted', merged, {
      rewrittenQuery,
      reason: decision.reason,
      simDelta: decision.simDelta,
    });
    return { memories: merged, queryText: rewrittenQuery };
  }

  trace.stage('repair-rejected', initialResults, {
    rewrittenQuery,
    reason: decision.reason,
    simDelta: decision.simDelta,
  });
  return { memories: initialResults, queryText: query };
}

/**
 * Run LLM-based query expansion: extract entity names and concepts from the
 * query, look them up in the entity graph, traverse relations, and merge
 * bridging memories into the candidate pool.
 */
async function applyQueryExpansion(
  stores: SearchPipelineStores,
  userId: string,
  query: string,
  queryEmbedding: number[],
  initialResults: SearchResult[],
  candidateDepth: number,
  trace: TraceCollector,
  policyConfig: SearchPipelineRuntimeConfig = config,
): Promise<SearchResult[]> {
  if (!policyConfig.queryExpansionEnabled || !policyConfig.entityGraphEnabled || !stores.entity) {
    return initialResults;
  }

  const excludeIds = new Set(initialResults.map((r) => r.id));
  const { memories, expansion } = await expandQueryViaEntities(
    stores.entity!, stores.search, userId, query, queryEmbedding, excludeIds, policyConfig.linkExpansionMax, policyConfig,
  );

  if (memories.length === 0) {
    trace.stage('query-expansion', initialResults, {
      entities: expansion.extractedEntities,
      concepts: expansion.extractedConcepts,
      matched: 0,
      expanded: 0,
    });
    return initialResults;
  }

  const merged = mergeStageResults(initialResults, memories, candidateDepth, 1, 1);
  trace.stage('query-expansion', merged, {
    entities: expansion.extractedEntities,
    concepts: expansion.extractedConcepts,
    matched: expansion.matchedEntityIds.length,
    expanded: expansion.expandedMemoryIds.length,
  });
  return merged;
}

/**
 * Zero-LLM query augmentation: match the query embedding against entity graph,
 * append matched entity names to the query, and re-embed for better vector targeting.
 * If disabled or no entities match, returns the original query and embedding unchanged.
 */
async function applyQueryAugmentation(
  stores: SearchPipelineStores,
  userId: string,
  query: string,
  queryEmbedding: number[],
  trace: TraceCollector,
  policyConfig: SearchPipelineRuntimeConfig = config,
): Promise<{ searchQuery: string; augmentedEmbedding: number[] }> {
  if (!policyConfig.queryAugmentationEnabled || !policyConfig.entityGraphEnabled || !stores.entity) {
    return { searchQuery: query, augmentedEmbedding: queryEmbedding };
  }

  const result = await augmentQueryWithEntities(
    stores.entity!, userId, query, queryEmbedding, policyConfig,
  );

  if (result.augmentedQuery === query) {
    trace.stage('query-augmentation', [], { matched: 0 });
    return { searchQuery: query, augmentedEmbedding: queryEmbedding };
  }

  const augmentedEmbedding = await embedText(result.augmentedQuery, 'query');
  trace.stage('query-augmentation', [], {
    augmentedQuery: result.augmentedQuery,
    matched: result.matchedEntities.length,
    entities: result.matchedEntities.map((e) => `${e.name} (${e.entityType}, ${e.similarity.toFixed(2)})`),
  });

  return { searchQuery: result.augmentedQuery, augmentedEmbedding };
}

/**
 * Entity name co-retrieval: when the query mentions a known entity by name,
 * pull in ALL memories linked to that entity. This is a zero-LLM exact-match
 * path that ensures fragmented entity facts are reunited at retrieval time.
 *
 * Example: "What plan is Acme Corp on?" → finds "Acme Corp" entity →
 * retrieves pricing, seats, contact, and plan memories together.
 */
async function applyEntityNameCoRetrieval(
  stores: SearchPipelineStores,
  userId: string,
  query: string,
  queryEmbedding: number[],
  initialResults: SearchResult[],
  candidateDepth: number,
  trace: TraceCollector,
  policyConfig: SearchPipelineRuntimeConfig = config,
): Promise<SearchResult[]> {
  if (!policyConfig.entityGraphEnabled || !stores.entity) return initialResults;

  const excludeIds = new Set(initialResults.map((r) => r.id));
  const { memories, matchedNames } = await coRetrieveByEntityNames(
    stores.entity!, stores.search, userId, query, queryEmbedding, excludeIds, policyConfig.linkExpansionMax,
  );

  if (memories.length === 0) {
    trace.stage('entity-coretrieval', initialResults, { candidates: matchedNames, coRetrieved: 0 });
    return initialResults;
  }

  const merged = mergeStageResults(initialResults, memories, candidateDepth, 1, 1);
  trace.stage('entity-coretrieval', merged, {
    matchedNames,
    coRetrieved: memories.length,
  });
  return merged;
}

async function applyTemporalQueryExpansion(
  stores: SearchPipelineStores,
  userId: string,
  query: string,
  queryEmbedding: number[],
  initialResults: SearchResult[],
  candidateDepth: number,
  referenceTime: Date | undefined,
  trace: TraceCollector,
): Promise<{ memories: SearchResult[]; temporalAnchorFingerprints: string[] }> {
  const excludeIds = new Set(initialResults.map((result) => result.id));
  const { memories, keywords, anchorIds } = await expandTemporalQuery(
    stores.search,
    userId,
    query,
    queryEmbedding,
    excludeIds,
    candidateDepth,
    referenceTime,
  );
  const anchorFingerprints = anchorIds
    .map((id) => {
      const anchor = initialResults.find((result) => result.id === id) ?? memories.find((result) => result.id === id);
      return anchor ? buildTemporalFingerprint(anchor.content) : null;
    })
    .filter((fingerprint): fingerprint is string => fingerprint !== null);

  if (memories.length === 0) {
    trace.stage('temporal-query-expansion', initialResults, { keywords, expanded: 0 });
    return { memories: initialResults, temporalAnchorFingerprints: anchorFingerprints };
  }

  const mergedPool = mergeStageResults(
    initialResults,
    memories,
    initialResults.length + memories.length,
    1,
    1,
  );
  const merged = preserveProtectedResults(
    mergedPool.slice(0, candidateDepth),
    mergedPool,
    anchorFingerprints,
    candidateDepth,
  );
  trace.stage('temporal-query-expansion', merged, {
    keywords,
    anchorIds,
    expanded: memories.length,
  });
  return { memories: merged, temporalAnchorFingerprints: anchorFingerprints };
}

async function applyLiteralQueryExpansion(
  stores: SearchPipelineStores,
  userId: string,
  query: string,
  queryEmbedding: number[],
  initialResults: SearchResult[],
  candidateDepth: number,
  trace: TraceCollector,
): Promise<SearchResult[]> {
  if (!isLiteralDetailQuery(query)) {
    trace.stage('literal-query-expansion', initialResults, { keywords: [], expanded: 0 });
    return initialResults;
  }

  const excludeIds = new Set(initialResults.map((result) => result.id));
  const { memories, keywords } = await expandLiteralQuery(
    stores.search,
    userId,
    query,
    queryEmbedding,
    excludeIds,
    candidateDepth,
  );

  if (memories.length === 0) {
    trace.stage('literal-query-expansion', initialResults, { keywords, expanded: 0 });
    return initialResults;
  }

  const merged = mergeStageResults(
    initialResults,
    memories,
    initialResults.length + memories.length,
    1,
    1,
  );
  trace.stage('literal-query-expansion', merged, { keywords, expanded: memories.length });
  return merged;
}

async function applySubjectQueryExpansion(
  stores: SearchPipelineStores,
  userId: string,
  query: string,
  queryEmbedding: number[],
  initialResults: SearchResult[],
  candidateDepth: number,
  trace: TraceCollector,
): Promise<SearchResult[]> {
  const excludeIds = new Set(initialResults.map((result) => result.id));
  const { memories, anchors } = await expandSubjectQuery(
    stores.search,
    userId,
    query,
    queryEmbedding,
    excludeIds,
    candidateDepth,
  );

  if (memories.length === 0) {
    trace.stage('subject-query-expansion', initialResults, { anchors, expanded: 0 });
    return initialResults;
  }

  const merged = mergeStageResults(
    initialResults,
    memories,
    initialResults.length + memories.length,
    1,
    1,
  );
  trace.stage('subject-aware-expansion', merged, { anchors, expanded: memories.length });
  return merged;
}

/**
 * Apply link expansion (graph or PPR), temporal neighbor expansion, and MMR reranking.
 */
async function applyExpansionAndReranking(
  stores: SearchPipelineStores,
  userId: string,
  query: string,
  results: SearchResult[],
  queryEmbedding: number[],
  limit: number,
  referenceTime: Date | undefined,
  temporalAnchorFingerprints: string[],
  trace: TraceCollector,
  skipReranking?: boolean,
  policyConfig: SearchPipelineRuntimeConfig = config,
): Promise<SearchResult[]> {
  const reranked = await applyCrossEncoderStage(query, results, skipReranking, trace, policyConfig);
  const ranked = applyRankingProtectionStages(
    query,
    reranked,
    temporalAnchorFingerprints,
    trace,
    policyConfig,
  );

  return selectAndExpandCandidates(
    stores,
    userId,
    ranked.candidates,
    queryEmbedding,
    limit,
    referenceTime,
    ranked.protectedFingerprints,
    trace,
    policyConfig,
  );
}

interface RankedCandidateState {
  candidates: SearchResult[];
  protectedFingerprints: string[];
}

async function applyCrossEncoderStage(
  query: string,
  results: SearchResult[],
  skipReranking: boolean | undefined,
  trace: TraceCollector,
  policyConfig: SearchPipelineRuntimeConfig,
): Promise<SearchResult[]> {
  const shouldSkipRerank = skipReranking || shouldAutoSkipReranking(results, policyConfig);
  if (!policyConfig.crossEncoderEnabled) return results;
  if (shouldSkipRerank) {
    console.log(`[reranker] Skipped: ${skipReranking ? 'explicit' : 'auto-skip (high-confidence results)'}`);
    return results;
  }

  const rerankerConfig = {
    crossEncoderModel: policyConfig.crossEncoderModel,
    crossEncoderDtype: policyConfig.crossEncoderDtype,
  };
  const candidates = await rerankCandidates(query, results, rerankerConfig);
  trace.stage('cross-encoder', candidates, {
    model: rerankerConfig.crossEncoderModel,
    dtype: rerankerConfig.crossEncoderDtype,
  });
  return candidates;
}

function applyRankingProtectionStages(
  query: string,
  candidates: SearchResult[],
  temporalAnchorFingerprints: string[],
  trace: TraceCollector,
  policyConfig: SearchPipelineRuntimeConfig,
): RankedCandidateState {
  let state = applySubjectRankingStage(query, candidates, temporalAnchorFingerprints, trace);
  state = applyLiteralProtectionStage(query, state, trace, policyConfig);
  state = applyTemporalConstraintStage(query, state, trace, policyConfig);

  const currentStateRanked = applyCurrentStateRanking(query, state.candidates);
  if (currentStateRanked.triggered) {
    trace.stage('current-state-ranking', currentStateRanked.results, {});
    state = { ...state, candidates: currentStateRanked.results };
  }

  return { ...state, candidates: applyConcisenessPenalty(state.candidates) };
}

function applySubjectRankingStage(
  query: string,
  candidates: SearchResult[],
  protectedFingerprints: string[],
  trace: TraceCollector,
): RankedCandidateState {
  const subjectRanked = applySubjectAwareRanking(query, candidates);
  if (subjectRanked.subjects.length === 0) return { candidates, protectedFingerprints };

  trace.stage('subject-aware-ranking', subjectRanked.results, {
    subjects: subjectRanked.subjects,
    keywords: subjectRanked.keywords,
    protected: subjectRanked.protectedFingerprints.length,
  });
  return {
    candidates: subjectRanked.results,
    protectedFingerprints: [...protectedFingerprints, ...subjectRanked.protectedFingerprints],
  };
}

function applyLiteralProtectionStage(
  query: string,
  state: RankedCandidateState,
  trace: TraceCollector,
  policyConfig: SearchPipelineRuntimeConfig,
): RankedCandidateState {
  if (!policyConfig.literalListProtectionEnabled) return state;
  const literalProtected = protectLiteralListAnswerCandidates(
    query,
    state.candidates,
    policyConfig.literalListProtectionMaxProtected,
  );
  trace.stage('literal-list-protection', literalProtected.results, {
    protected: literalProtected.protectedFingerprints.length,
    protected_ids: literalProtected.protectedIds,
    reasons: literalProtected.reasons,
  });
  return {
    candidates: literalProtected.results,
    protectedFingerprints: [...state.protectedFingerprints, ...literalProtected.protectedFingerprints],
  };
}

function applyTemporalConstraintStage(
  query: string,
  state: RankedCandidateState,
  trace: TraceCollector,
  policyConfig: SearchPipelineRuntimeConfig,
): RankedCandidateState {
  if (!policyConfig.temporalQueryConstraintEnabled) return state;
  const constrained = applyTemporalQueryConstraints(query, state.candidates, policyConfig.temporalQueryConstraintBoost);
  trace.stage('temporal-query-constraints', constrained.results, {
    constraints: constrained.constraints,
    protected: constrained.protectedFingerprints.length,
    protected_ids: constrained.protectedIds,
    boost: policyConfig.temporalQueryConstraintBoost,
  });
  return {
    candidates: constrained.results,
    protectedFingerprints: [...state.protectedFingerprints, ...constrained.protectedFingerprints],
  };
}

async function selectAndExpandCandidates(
  stores: SearchPipelineStores,
  userId: string,
  candidates: SearchResult[],
  queryEmbedding: number[],
  limit: number,
  referenceTime: Date | undefined,
  protectedFingerprints: string[],
  trace: TraceCollector,
  policyConfig: SearchPipelineRuntimeConfig,
): Promise<SearchResult[]> {
  if (policyConfig.linkExpansionBeforeMMR && policyConfig.linkExpansionEnabled && policyConfig.mmrEnabled) {
    return selectWithPreMmrExpansion(stores, userId, candidates, queryEmbedding, limit, referenceTime, protectedFingerprints, trace, policyConfig);
  }
  if (policyConfig.mmrEnabled) {
    return selectWithMmrThenExpand(stores, userId, candidates, queryEmbedding, limit, referenceTime, protectedFingerprints, trace, policyConfig);
  }
  return selectWithoutMmr(stores, userId, candidates, queryEmbedding, limit, referenceTime, protectedFingerprints, trace, policyConfig);
}

async function selectWithPreMmrExpansion(
  stores: SearchPipelineStores,
  userId: string,
  candidates: SearchResult[],
  queryEmbedding: number[],
  limit: number,
  referenceTime: Date | undefined,
  protectedFingerprints: string[],
  trace: TraceCollector,
  policyConfig: SearchPipelineRuntimeConfig,
): Promise<SearchResult[]> {
  const preExpanded = await expandWithLinks(stores, userId, candidates.slice(0, limit), queryEmbedding, referenceTime, policyConfig);
  trace.stage('link-expansion', preExpanded, { order: 'before-mmr' });
  const selected = preserveProtectedResults(applyMMR(preExpanded, queryEmbedding, limit, policyConfig.mmrLambda), preExpanded, protectedFingerprints, limit);
  trace.stage('mmr', selected, { lambda: policyConfig.mmrLambda });
  return selected;
}

async function selectWithMmrThenExpand(
  stores: SearchPipelineStores,
  userId: string,
  candidates: SearchResult[],
  queryEmbedding: number[],
  limit: number,
  referenceTime: Date | undefined,
  protectedFingerprints: string[],
  trace: TraceCollector,
  policyConfig: SearchPipelineRuntimeConfig,
): Promise<SearchResult[]> {
  const mmrResults = preserveProtectedResults(applyMMR(candidates, queryEmbedding, limit, policyConfig.mmrLambda), candidates, protectedFingerprints, limit);
  trace.stage('mmr', mmrResults, { lambda: policyConfig.mmrLambda });
  const expanded = await expandWithLinks(stores, userId, mmrResults, queryEmbedding, referenceTime, policyConfig);
  trace.stage('link-expansion', expanded, { order: 'after-mmr' });
  return expanded;
}

async function selectWithoutMmr(
  stores: SearchPipelineStores,
  userId: string,
  candidates: SearchResult[],
  queryEmbedding: number[],
  limit: number,
  referenceTime: Date | undefined,
  protectedFingerprints: string[],
  trace: TraceCollector,
  policyConfig: SearchPipelineRuntimeConfig,
): Promise<SearchResult[]> {
  const sliced = preserveProtectedResults(candidates.slice(0, limit), candidates, protectedFingerprints, limit);
  const expanded = await expandWithLinks(stores, userId, sliced, queryEmbedding, referenceTime, policyConfig);
  trace.stage('link-expansion', expanded, { order: 'no-mmr' });
  return expanded;
}

/**
 * Expand search results with linked memories (graph traversal or PPR)
 * and temporal neighbors.
 */
async function expandWithLinks(
  stores: SearchPipelineStores,
  userId: string,
  results: SearchResult[],
  queryEmbedding: number[],
  referenceTime?: Date,
  policyConfig: SearchPipelineRuntimeConfig = config,
): Promise<SearchResult[]> {
  if (!policyConfig.linkExpansionEnabled || policyConfig.linkExpansionMax <= 0) return results;

  const resultIds = results.map((r) => r.id);
  const excludeIds = new Set(resultIds);
  const budget = policyConfig.linkExpansionMax;

  const linkedIds = policyConfig.pprEnabled
    ? await expandViaPPR(stores, results, excludeIds, budget, policyConfig)
    : await stores.link.findLinkedMemoryIds(resultIds, excludeIds, budget);

  const temporalNeighbors = await stores.search.findTemporalNeighbors(
    userId,
    results.map((r) => r.created_at),
    queryEmbedding,
    TEMPORAL_NEIGHBOR_WINDOW_MINUTES,
    excludeIds,
    budget,
    referenceTime,
  );

  const linkedMemories = linkedIds.length > 0
    ? await stores.search.fetchMemoriesByIds(userId, linkedIds, queryEmbedding, referenceTime)
    : [];

  const seen = new Set([...resultIds, ...linkedIds]);
  const dedupedTemporal = temporalNeighbors.filter((m) => !seen.has(m.id));

  // Entity graph expansion: find entities matching the query and pull in their linked memories
  const entityMemories = await expandViaEntities(
    stores,
    userId,
    queryEmbedding,
    seen,
    budget,
    policyConfig,
  );

  const expansions = [...linkedMemories, ...dedupedTemporal, ...entityMemories]
    .sort((a, b) => b.score - a.score)
    .slice(0, budget);

  return [...results, ...expansions];
}

async function runMemoryRrfRetrieval(
  stores: SearchPipelineStores,
  userId: string,
  queryText: string,
  queryEmbedding: number[],
  limit: number,
  sourceSite: string | undefined,
  referenceTime: Date | undefined,
  includeKeywordChannel: boolean,
  policyConfig: SearchPipelineRuntimeConfig = config,
): Promise<SearchResult[]> {
  const semanticResults = await stores.search.searchSimilar(
    userId,
    queryEmbedding,
    limit,
    sourceSite,
    referenceTime,
  );
  const channels = [
    { name: 'semantic', weight: SEMANTIC_RRF_WEIGHT, results: semanticResults },
  ];

  if (policyConfig.entityGraphEnabled && stores.entity) {
    const entityResults = await expandViaEntities(
      stores,
      userId,
      queryEmbedding,
      new Set(),
      limit,
      policyConfig,
    );
    if (entityResults.length > 0) {
      channels.push({ name: 'entity', weight: ENTITY_RRF_WEIGHT, results: entityResults });
    }
  }

  if (includeKeywordChannel) {
    const keywordResults = await stores.search.searchKeyword(userId, queryText, limit, sourceSite);
    if (keywordResults.length > 0) {
      channels.push({ name: 'keyword', weight: KEYWORD_RRF_WEIGHT, results: keywordResults });
    }
  }

  if (channels.length === 1) {
    return semanticResults;
  }

  return weightedRRF(channels, limit, DEFAULT_RRF_K);
}

/**
 * Use Personalized PageRank to find expansion candidates from the link graph.
 */
async function expandViaPPR(
  stores: SearchPipelineStores,
  results: SearchResult[],
  excludeIds: Set<string>,
  budget: number,
  policyConfig: Pick<SearchPipelineRuntimeConfig, 'pprDamping'> = config,
): Promise<string[]> {
  const seedScores = new Map<string, number>();
  for (const r of results) {
    seedScores.set(r.id, r.score);
  }

  const { scores } = await personalizedPageRank(
    stores.pool,
    seedScores,
    { damping: policyConfig.pprDamping },
  );

  return [...scores.entries()]
    .filter(([id]) => !excludeIds.has(id))
    .sort(([, a], [, b]) => b - a)
    .slice(0, budget)
    .map(([id]) => id);
}

function mergeStageResults(
  primary: SearchResult[],
  secondary: SearchResult[],
  limit: number,
  primaryWeight: number,
  secondaryWeight: number,
): SearchResult[] {
  const merged = new Map<string, SearchResult>();
  mergeStageWeightedResults(merged, primary, primaryWeight);
  mergeStageWeightedResults(merged, secondary, secondaryWeight);
  return [...merged.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function mergeStageWeightedResults(
  merged: Map<string, SearchResult>,
  results: SearchResult[],
  weight: number,
): void {
  for (const result of results) {
    const weighted = { ...result, score: result.score * weight };
    const existing = merged.get(result.id);
    if (!existing || weighted.score > existing.score) {
      merged.set(result.id, weighted);
    }
  }
}

/**
 * Generate similarity links between newly ingested memories and existing ones.
 * Only runs when link expansion is enabled.
 */
export async function generateLinks(
  stores: SearchPipelineStores,
  userId: string,
  memoryIds: string[],
  embeddingCache: Map<string, number[]>,
  runtimeConfig: Pick<SearchPipelineRuntimeConfig, 'linkExpansionEnabled' | 'linkSimilarityThreshold'> = config,
): Promise<number> {
  if (!runtimeConfig.linkExpansionEnabled || memoryIds.length === 0) return 0;

  const activeMemoryIds: string[] = [];
  for (const id of memoryIds) {
    const memory = await stores.memory.getMemory(id, userId);
    if (memory) activeMemoryIds.push(id);
  }

  if (activeMemoryIds.length === 0) return 0;

  const allLinks: Array<{ sourceId: string; targetId: string; similarity: number }> = [];
  for (const memoryId of activeMemoryIds) {
    const embedding = embeddingCache.get(memoryId);
    if (!embedding) continue;

    const candidates = await stores.link.findLinkCandidates(
      userId, embedding, runtimeConfig.linkSimilarityThreshold, memoryId,
    );
    for (const candidate of candidates) {
      allLinks.push({ sourceId: memoryId, targetId: candidate.id, similarity: candidate.similarity });
    }
  }
  if (allLinks.length === 0) return 0;
  return stores.link.createLinks(allLinks);
}

/**
 * Entity graph expansion: find entities matching the query embedding,
 * traverse relations to find connected entities (1-hop), then retrieve
 * memories linked to all matched entities.
 */
async function expandViaEntities(
  stores: SearchPipelineStores,
  userId: string,
  queryEmbedding: number[],
  excludeIds: Set<string>,
  budget: number,
  policyConfig: Pick<SearchPipelineRuntimeConfig, 'entityGraphEnabled' | 'entitySearchMinSimilarity'> = config,
): Promise<SearchResult[]> {
  if (!policyConfig.entityGraphEnabled || !stores.entity) return [];

  const matchingEntities = await stores.entity!.searchEntities(
    userId, queryEmbedding, 5, policyConfig.entitySearchMinSimilarity,
  );

  if (matchingEntities.length === 0) return [];

  const directEntityIds = matchingEntities.map((e) => e.id);

  // 1-hop relation traversal: find entities connected via relations
  const relatedEntityIds = await stores.entity!.findRelatedEntityIds(
    userId, directEntityIds, new Set(directEntityIds), budget,
  );

  const allEntityIds = [...directEntityIds, ...relatedEntityIds];
  const memoryIds = await stores.entity!.findMemoryIdsByEntities(userId, allEntityIds, excludeIds, budget);

  if (memoryIds.length === 0) return [];

  return stores.search.fetchMemoriesByIds(userId, memoryIds, queryEmbedding);
}
