/**
 * Internal types shared between memory-service and its helpers.
 */

import { type TrustScore } from './trust-scoring.js';
import { type ExtractedEntity, type ExtractedRelation } from './extraction.js';
import { type MemoryNetwork } from './memory-network.js';
import type { AUDNAction } from './extraction.js';
import { type ClaimSlotInput } from '../db/claim-repository.js';

export interface FactInput {
  fact: string;
  headline: string;
  importance: number;
  type: 'preference' | 'project' | 'knowledge' | 'person' | 'plan';
  keywords: string[];
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  network?: MemoryNetwork;
  opinionConfidence?: number | null;
}

export interface ClaimTarget {
  claimId: string;
  versionId: string;
  memoryId: string;
  cmoId: string | null;
}

export type Outcome = 'stored' | 'updated' | 'deleted' | 'skipped';

export type IngestTraceAction = AUDNAction | 'SKIP';

export type IngestTraceReasonCode =
  | 'verbatim-store'
  | 'write-security-sanitization'
  | 'write-security-trust'
  | 'entropy-gate'
  | 'direct-store-no-candidates'
  | 'workspace-direct-store'
  | 'fast-audn-noop'
  | 'quick-duplicate-noop'
  | 'deferred-audn-store'
  | 'llm-audn-add'
  | 'llm-audn-noop'
  | 'llm-audn-clarify'
  | 'llm-audn-update'
  | 'llm-audn-delete'
  | 'llm-audn-supersede'
  | 'invalid-target-fallback';

export interface IngestTraceCandidate {
  id: string;
  similarity: number;
  contentPreview: string;
}

export interface IngestTraceDecision {
  source: 'direct-store' | 'fast-audn' | 'quick-dedup' | 'deferred-audn' | 'llm-audn' | 'write-security' | 'entropy-gate' | 'verbatim';
  action: IngestTraceAction;
  reasonCode: IngestTraceReasonCode;
  targetMemoryId: string | null;
  rawAction?: string;
  candidateIds?: string[];
}

export interface IngestFactTrace {
  factText: string;
  headline: string;
  factType: FactInput['type'] | 'verbatim';
  importance: number;
  logicalTimestamp?: string;
  writeSecurity?: {
    allowed: boolean;
    blockedBy: string | null;
    trustScore: number;
  };
  entropyGate?: {
    score: number;
    entityNovelty: number;
    semanticNovelty: number;
    accepted: boolean;
  };
  candidates?: IngestTraceCandidate[];
  decision: IngestTraceDecision;
  outcome: Outcome;
  memoryId: string | null;
}

export interface FactResult {
  outcome: Outcome;
  memoryId: string | null;
  embedding?: number[];
  trace?: IngestFactTrace;
}

export interface AtomicFactProjection {
  factText: string;
  embedding: number[];
  factType: FactInput['type'];
  importance: number;
  keywords: string[];
  metadata?: Record<string, unknown>;
}

export interface ForesightProjection {
  content: string;
  embedding: number[];
  foresightType: 'plan' | 'goal' | 'scheduled' | 'expected_state';
  validFrom?: Date;
  validTo?: Date | null;
  metadata?: Record<string, unknown>;
}

const TRUST_PASS: TrustScore = {
  score: 1.0, domainTrust: 1.0, contentPenalty: 0, injectionPenalty: 0,
  sanitization: { passed: true, findings: [], highestSeverity: 'none' as const },
};

/** Mutable state accumulated across a batch for entropy gating. */
export interface EntropyContext {
  seenEntities: Set<string>;
  previousEmbedding: number[] | null;
}

/** Retrieval/search mode for search results. */
export type RetrievalMode = 'flat' | 'tiered' | 'abstract-aware';

/** Retrieval strategy controls which indexed representation powers search. */
export type SearchStrategy = 'memory' | 'fact-hybrid';

/**
 * Shared context bundle passed through the AUDN decision pipeline.
 * Reduces parameter count across tryOpinionIntercept, storeClarification,
 * executeMutationDecision, and related helpers.
 */
export interface AudnFactContext {
  userId: string;
  fact: FactInput;
  embedding: number[];
  sourceSite: string;
  sourceUrl: string;
  episodeId: string;
  trustScore: number;
  claimSlot?: ClaimSlotInput | null;
  logicalTimestamp?: Date;
  /** Phase 5 Step 10: workspace scope for workspace-originated facts. */
  workspace?: import('../db/repository-types.js').WorkspaceContext;
}

export interface IngestResult {
  episodeId: string;
  factsExtracted: number;
  memoriesStored: number;
  memoriesUpdated: number;
  memoriesDeleted: number;
  memoriesSkipped: number;
  /**
   * IDs of memories newly created during this ingest (outcome === 'stored').
   * Length matches `memoriesStored`.
   */
  storedMemoryIds: string[];
  /**
   * IDs of memories mutated during this ingest (outcome === 'updated').
   * Length matches `memoriesUpdated`.
   */
  updatedMemoryIds: string[];
  /**
   * Union of stored + updated IDs in traversal order. Internal consumers
   * (post-write processors, in-process callers) iterate over every
   * touched memory without caring about the outcome split.
   */
  memoryIds: string[];
  linksCreated: number;
  compositesCreated: number;
  ingestTraceId?: string;
}

export interface RetrievalResult {
  memories: import('../db/repository-types.js').SearchResult[];
  injectionText: string;
  citations: string[];
  retrievalMode: RetrievalMode;
  tierAssignments?: import('./tiered-loading.js').TierAssignment[];
  expandIds?: string[];
  estimatedContextTokens?: number;
  lessonCheck?: import('./lesson-service.js').LessonCheckResult;
  consensusResult?: import('./consensus-validation.js').ConsensusResult;
  packagingSignal?: import('./retrieval-format.js').PackagingSignal;
  retrievalSummary?: import('./retrieval-trace.js').RetrievalTraceSummary;
  packagingSummary?: import('./retrieval-trace.js').PackagingTraceSummary;
  assemblySummary?: import('./retrieval-trace.js').AssemblyTraceSummary;
}

/** Options controlling retrieval packaging. */
export interface RetrievalOptions {
  retrievalMode?: RetrievalMode;
  tokenBudget?: number;
  searchStrategy?: SearchStrategy;
  /** Skip the LLM repair loop for latency-critical paths. */
  skipRepairLoop?: boolean;
  /** Skip cross-encoder reranking for latency-critical paths. */
  skipReranking?: boolean;
}

/**
 * Canonical runtime read-path scope contract.
 *
 * Used by search, expand, and (eventually) list/get/delete to dispatch
 * between user-scoped and workspace-scoped operations. The workspace
 * variant carries agentId for visibility enforcement and agentScope for
 * filtering which agents' memories to include.
 *
 * Note: ingest uses WorkspaceContext directly (needs visibility field
 * for writes). MemoryScope covers reads only until a unified
 * write-context type is introduced (Phase 5).
 */
export type MemoryScope =
  | { kind: 'user'; userId: string }
  | { kind: 'workspace'; userId: string; workspaceId: string; agentId: string; agentScope?: import('../db/repository-types.js').AgentScope };

/** Options bag for scope-dispatching search methods. */
export interface ScopedSearchOptions {
  sourceSite?: string;
  limit?: number;
  asOf?: string;
  referenceTime?: Date;
  namespaceScope?: string;
  retrievalOptions?: RetrievalOptions;
  /** When true, skips the LLM repair loop (used by /search/fast). */
  fast?: boolean;
  /**
   * Request-scoped effective config overlaying the startup singleton.
   * When provided, replaces `deps.config` for the duration of the call.
   * Populated by the route layer after merging a validated body-level
   * `config_override`. Absent → startup config flows through unchanged.
   */
  effectiveConfig?: MemoryServiceDeps['config'];
}

/** Supported observability payload for retrieval responses. */
export interface RetrievalObservability {
  retrieval?: import('./retrieval-trace.js').RetrievalTraceSummary;
  packaging?: import('./retrieval-trace.js').PackagingTraceSummary;
  assembly?: import('./retrieval-trace.js').AssemblyTraceSummary;
}

/**
 * Internal dependency bundle for memory service sub-modules.
 * Exposes the repositories and optional services needed by ingest, search, and CRUD.
 */
export interface MemoryServiceDeps {
  config: import('../app/runtime-container.js').CoreRuntimeConfig & IngestRuntimeConfig;
  /** Domain-facing store interfaces (Phase 5). */
  stores: import('../db/stores.js').CoreStores;
  observationService: import('./observation-service.js').ObservationService | null;
  uriResolver: import('./atomicmem-uri.js').URIResolver;
}

/** Explicit ingest/runtime config subset threaded through current ingest seams. */
export interface IngestRuntimeConfig {
  audnCandidateThreshold: number;
  auditLoggingEnabled: boolean;
  chunkedExtractionEnabled: boolean;
  chunkedExtractionFallbackEnabled: boolean;
  chunkSizeTurns: number;
  chunkOverlapTurns: number;
  compositeGroupingEnabled: boolean;
  compositeMinClusterSize: number;
  consensusExtractionEnabled: boolean;
  consensusExtractionRuns: number;
  extractionCacheEnabled: boolean;
  observationDateExtractionEnabled: boolean;
  quotedEntityExtractionEnabled: boolean;
  entityGraphEnabled: boolean;
  entropyGateAlpha: number;
  entropyGateEnabled: boolean;
  entropyGateThreshold: number;
  fastAudnDuplicateThreshold: number;
  fastAudnEnabled: boolean;
  ingestTraceEnabled: boolean;
  lessonsEnabled: boolean;
  llmModel: string;
  trustScoringEnabled: boolean;
  trustScoreMinThreshold: number;
}
