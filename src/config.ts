/**
 * Runtime configuration for the prototype backend.
 * Loads validated env-backed defaults, then allows limited in-memory updates
 * for local UI experimentation via PUT /v1/memories/config.
 */

import {
  getRetrievalProfile,
  parseRetrievalProfile,
  type RetrievalProfile,
  type RetrievalProfileName,
} from './services/retrieval-profiles.js';

export type EmbeddingProviderName = 'openai' | 'ollama' | 'openai-compatible' | 'transformers' | 'voyage';
export type LLMProviderName = EmbeddingProviderName | 'groq' | 'anthropic' | 'google-genai';
export type VectorBackendName = 'pgvector' | 'ruvector-mock' | 'zvec-mock';
export type CrossEncoderDtype = 'auto' | 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8' | 'q4' | 'bnb4' | 'q4f16';

export interface RuntimeConfig {
  databaseUrl: string;
  openaiApiKey: string;
  port: number;
  retrievalProfile: RetrievalProfileName;
  retrievalProfileSettings: RetrievalProfile;
  maxSearchResults: number;
  similarityThreshold: number;
  audnCandidateThreshold: number;
  audnSafeReuseMinSimilarity: number;
  crossAgentCandidateThreshold: number;
  clarificationConflictThreshold: number;
  adaptiveRetrievalEnabled: boolean;
  adaptiveSimpleLimit: number;
  adaptiveMediumLimit: number;
  adaptiveComplexLimit: number;
  adaptiveMultiHopLimit: number;
  adaptiveAggregationLimit: number;
  repairLoopEnabled: boolean;
  hybridSearchEnabled: boolean;
  repairLoopMinSimilarity: number;
  repairSkipSimilarity: number;
  mmrEnabled: boolean;
  mmrLambda: number;
  linkExpansionEnabled: boolean;
  linkExpansionMax: number;
  linkSimilarityThreshold: number;
  scoringWeightSimilarity: number;
  scoringWeightImportance: number;
  scoringWeightRecency: number;
  linkExpansionBeforeMMR: boolean;
  pprEnabled: boolean;
  pprDamping: number;
  repairDeltaThreshold: number;
  repairConfidenceFloor: number;
  embeddingProvider: EmbeddingProviderName;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingApiUrl?: string;
  embeddingApiKey?: string;
  voyageApiKey?: string;
  voyageDocumentModel: string;
  voyageQueryModel: string;
  llmProvider: LLMProviderName;
  llmModel: string;
  llmApiUrl?: string;
  llmApiKey?: string;
  groqApiKey?: string;
  ollamaBaseUrl: string;
  vectorBackend: VectorBackendName;
  skipVectorIndexes: boolean;
  llmSeed?: number;
  stagedLoadingEnabled: boolean;
  retrievalTraceEnabled: boolean;
  ingestTraceDir: string;
  ingestTraceEnabled: boolean;
  extractionCacheEnabled: boolean;
  extractionCacheDir: string;
  embeddingCacheEnabled: boolean;
  chunkedExtractionEnabled: boolean;
  chunkedExtractionFallbackEnabled: boolean;
  chunkSizeTurns: number;
  chunkOverlapTurns: number;
  consensusExtractionEnabled: boolean;
  consensusExtractionRuns: number;
  observationDateExtractionEnabled: boolean;
  quotedEntityExtractionEnabled: boolean;
  entropyGateEnabled: boolean;
  entropyGateThreshold: number;
  entropyGateAlpha: number;
  affinityClusteringThreshold: number;
  affinityClusteringMinSize: number;
  affinityClusteringBeta: number;
  affinityClusteringTemporalLambda: number;
  trustScoringEnabled: boolean;
  trustScoreMinThreshold: number;
  trustPenaltyEnabled: boolean;
  auditLoggingEnabled: boolean;
  decayCycleEnabled: boolean;
  decayRetentionThreshold: number;
  decayMinAgeDays: number;
  memoryCapEnabled: boolean;
  memoryCapMax: number;
  memoryCapWarnRatio: number;
  entityGraphEnabled: boolean;
  entityResolutionThreshold: number;
  entitySearchMinSimilarity: number;
  lessonsEnabled: boolean;
  lessonSimilarityThreshold: number;
  consensusValidationEnabled: boolean;
  consensusMinMemories: number;
  queryExpansionEnabled: boolean;
  queryExpansionMinSimilarity: number;
  queryAugmentationEnabled: boolean;
  queryAugmentationMaxEntities: number;
  queryAugmentationMinSimilarity: number;
  crossEncoderEnabled: boolean;
  crossEncoderModel: string;
  crossEncoderDtype: CrossEncoderDtype;
  iterativeRetrievalEnabled: boolean;
  namespaceClassificationEnabled: boolean;
  fastAudnEnabled: boolean;
  fastAudnDuplicateThreshold: number;
  observationNetworkEnabled: boolean;
  agenticRetrievalEnabled: boolean;
  rerankSkipTopSimilarity: number;
  rerankSkipMinGap: number;
  literalListProtectionEnabled: boolean;
  literalListProtectionMaxProtected: number;
  temporalQueryConstraintEnabled: boolean;
  temporalQueryConstraintBoost: number;
  deferredAudnEnabled: boolean;
  deferredAudnBatchSize: number;
  compositeGroupingEnabled: boolean;
  compositeMinClusterSize: number;
  compositeMaxClusterSize: number;
  compositeSimilarityThreshold: number;
  anthropicApiKey?: string;
  googleApiKey?: string;
  costLoggingEnabled: boolean;
  costLogDir: string;
  costRunId: string;
  conflictAutoResolveMs: number;
  /**
   * Dev/test-only: when true, PUT /v1/memories/config mutates the runtime
   * singleton. Production deploys leave this unset (false) — the route
   * returns 410 Gone. Startup-validated; routes read the memoized value
   * through configRouteAdapter, never re-check at request time.
   */
  runtimeConfigMutationEnabled: boolean;
}

/**
 * Fields accepted by `updateRuntimeConfig()`. Provider/model selection
 * (embeddingProvider, embeddingModel, voyage*, llmProvider, llmModel) is
 * intentionally absent: embedding.ts and llm.ts cache stateful provider
 * instances at first call, so mid-flight mutation never took effect in v1.
 * Freezing these as composition-time config is a bug fix. Server deployments
 * still use env-backed startup config; isolated harnesses can pass an explicit
 * RuntimeConfig to createCoreRuntime({ config }).
 */
export interface RuntimeConfigUpdates {
  similarityThreshold?: number;
  audnCandidateThreshold?: number;
  clarificationConflictThreshold?: number;
  maxSearchResults?: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

function parseEmbeddingProvider(
  value: string | undefined,
  fallback: EmbeddingProviderName,
): EmbeddingProviderName {
  if (!value) return fallback;
  const valid: EmbeddingProviderName[] = ['openai', 'ollama', 'openai-compatible', 'transformers', 'voyage'];
  if (!valid.includes(value as EmbeddingProviderName)) {
    throw new Error(`Invalid provider "${value}". Must be one of: ${valid.join(', ')}`);
  }
  return value as EmbeddingProviderName;
}

function parseLlmProvider(value: string | undefined, fallback: LLMProviderName): LLMProviderName {
  if (!value) return fallback;
  const valid: LLMProviderName[] = ['openai', 'ollama', 'openai-compatible', 'groq', 'anthropic', 'google-genai'];
  if (!valid.includes(value as LLMProviderName)) {
    throw new Error(`Invalid provider "${value}". Must be one of: ${valid.join(', ')}`);
  }
  return value as LLMProviderName;
}


function requireFiniteNumber(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function parseCrossEncoderDtype(value: string | undefined): CrossEncoderDtype {
  const dtype = value ?? 'auto';
  const valid: CrossEncoderDtype[] = ['auto', 'fp32', 'fp16', 'q8', 'int8', 'uint8', 'q4', 'bnb4', 'q4f16'];
  if (!valid.includes(dtype as CrossEncoderDtype)) {
    throw new Error(`Invalid CROSS_ENCODER_DTYPE "${dtype}". Must be one of: ${valid.join(', ')}`);
  }
  return dtype as CrossEncoderDtype;
}

function parseLlmSeed(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = optionalEnv(name);
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseVectorBackend(value: string | undefined): VectorBackendName {
  if (!value) return 'pgvector';
  if (value === 'pgvector' || value === 'ruvector-mock' || value === 'zvec-mock') return value;
  throw new Error('Invalid VECTOR_BACKEND. Must be "pgvector", "ruvector-mock", or "zvec-mock"');
}

const embeddingProvider = parseEmbeddingProvider(optionalEnv('EMBEDDING_PROVIDER'), 'openai');
const llmProvider = parseLlmProvider(optionalEnv('LLM_PROVIDER'), 'openai');
const retrievalProfile = parseRetrievalProfile(optionalEnv('RETRIEVAL_PROFILE'));
const retrievalProfileSettings = getRetrievalProfile(retrievalProfile);

/** Require OpenAI key only when at least one provider uses it. */
const needsOpenAIKey = embeddingProvider === 'openai' || llmProvider === 'openai';
const needsGroqKey = llmProvider === 'groq';
const needsAnthropicKey = llmProvider === 'anthropic';
const needsGoogleKey = llmProvider === 'google-genai';
const needsVoyageKey = embeddingProvider === 'voyage';
const groqApiKey = needsGroqKey ? requireEnv('GROQ_API_KEY') : optionalEnv('GROQ_API_KEY');
const openaiApiKey = needsOpenAIKey ? requireEnv('OPENAI_API_KEY') : (optionalEnv('OPENAI_API_KEY') ?? '');
const anthropicApiKey = needsAnthropicKey ? requireEnv('ANTHROPIC_API_KEY') : optionalEnv('ANTHROPIC_API_KEY');
const googleApiKey = needsGoogleKey ? requireEnv('GOOGLE_API_KEY') : optionalEnv('GOOGLE_API_KEY');
const voyageApiKey = needsVoyageKey ? requireEnv('VOYAGE_API_KEY') : optionalEnv('VOYAGE_API_KEY');

export const config: RuntimeConfig = {
  databaseUrl: requireEnv('DATABASE_URL'),
  openaiApiKey,
  port: parseInt(process.env.PORT ?? '3050', 10),
  retrievalProfile,
  retrievalProfileSettings,
  maxSearchResults: retrievalProfileSettings.maxSearchResults,
  similarityThreshold: 0.3,
  audnCandidateThreshold: parseFloat(optionalEnv('AUDN_CANDIDATE_THRESHOLD') ?? '0.7'),
  audnSafeReuseMinSimilarity: parseFloat(optionalEnv('AUDN_SAFE_REUSE_MIN_SIMILARITY') ?? '0.95'),
  crossAgentCandidateThreshold: parseFloat(optionalEnv('CROSS_AGENT_CANDIDATE_THRESHOLD') ?? '0.75'),
  clarificationConflictThreshold: 0.8,
  adaptiveRetrievalEnabled: (process.env.ADAPTIVE_RETRIEVAL_ENABLED ?? String(retrievalProfileSettings.adaptiveRetrievalEnabled)) === 'true',
  adaptiveSimpleLimit: parsePositiveIntEnv('ADAPTIVE_SIMPLE_LIMIT', 5),
  adaptiveMediumLimit: parsePositiveIntEnv('ADAPTIVE_MEDIUM_LIMIT', 5),
  adaptiveComplexLimit: parsePositiveIntEnv('ADAPTIVE_COMPLEX_LIMIT', 8),
  adaptiveMultiHopLimit: parsePositiveIntEnv('ADAPTIVE_MULTI_HOP_LIMIT', 12),
  adaptiveAggregationLimit: parsePositiveIntEnv('ADAPTIVE_AGGREGATION_LIMIT', 25),
  repairLoopEnabled: (process.env.REPAIR_LOOP_ENABLED ?? String(retrievalProfileSettings.repairLoopEnabled)) === 'true',
  hybridSearchEnabled: (process.env.HYBRID_SEARCH_ENABLED ?? String(retrievalProfileSettings.hybridSearchEnabled)) === 'true',
  repairLoopMinSimilarity: parseFloat(process.env.REPAIR_LOOP_MIN_SIMILARITY ?? String(retrievalProfileSettings.repairLoopMinSimilarity)),
  repairSkipSimilarity: parseFloat(process.env.REPAIR_SKIP_SIMILARITY ?? String(retrievalProfileSettings.repairSkipSimilarity ?? 0.55)),
  mmrEnabled: (process.env.MMR_ENABLED ?? String(retrievalProfileSettings.mmrEnabled)) === 'true',
  mmrLambda: parseFloat(process.env.MMR_LAMBDA ?? String(retrievalProfileSettings.mmrLambda)),
  linkExpansionEnabled: (process.env.LINK_EXPANSION_ENABLED ?? String(retrievalProfileSettings.linkExpansionEnabled)) === 'true',
  linkExpansionMax: parseInt(process.env.LINK_EXPANSION_MAX ?? String(retrievalProfileSettings.linkExpansionMax), 10),
  linkSimilarityThreshold: parseFloat(process.env.LINK_SIMILARITY_THRESHOLD ?? String(retrievalProfileSettings.linkSimilarityThreshold)),
  scoringWeightSimilarity: parseFloat(process.env.SCORING_WEIGHT_SIMILARITY ?? String(retrievalProfileSettings.scoringWeightSimilarity)),
  scoringWeightImportance: parseFloat(process.env.SCORING_WEIGHT_IMPORTANCE ?? String(retrievalProfileSettings.scoringWeightImportance)),
  scoringWeightRecency: parseFloat(process.env.SCORING_WEIGHT_RECENCY ?? String(retrievalProfileSettings.scoringWeightRecency)),
  linkExpansionBeforeMMR: (process.env.LINK_EXPANSION_BEFORE_MMR ?? String(retrievalProfileSettings.linkExpansionBeforeMMR)) === 'true',
  pprEnabled: (process.env.PPR_ENABLED ?? 'false') === 'true',
  pprDamping: parseFloat(process.env.PPR_DAMPING ?? '0.5'),
  repairDeltaThreshold: parseFloat(process.env.REPAIR_DELTA_THRESHOLD ?? String(retrievalProfileSettings.repairDeltaThreshold)),
  repairConfidenceFloor: parseFloat(process.env.REPAIR_CONFIDENCE_FLOOR ?? String(retrievalProfileSettings.repairConfidenceFloor)),

  // Embedding provider
  embeddingProvider,
  embeddingModel: optionalEnv('EMBEDDING_MODEL') ?? 'text-embedding-3-small',
  embeddingDimensions: parseInt(requireEnv('EMBEDDING_DIMENSIONS'), 10),
  embeddingApiUrl: optionalEnv('EMBEDDING_API_URL'),
  embeddingApiKey: optionalEnv('EMBEDDING_API_KEY'),
  voyageApiKey: voyageApiKey ?? undefined,
  voyageDocumentModel: optionalEnv('VOYAGE_DOCUMENT_MODEL') ?? 'voyage-4-large',
  voyageQueryModel: optionalEnv('VOYAGE_QUERY_MODEL') ?? 'voyage-4-lite',

  // LLM provider
  llmProvider,
  llmModel: optionalEnv('LLM_MODEL') ?? 'gpt-4o-mini',
  llmApiUrl: optionalEnv('LLM_API_URL'),
  llmApiKey: optionalEnv('LLM_API_KEY'),

  // Groq
  groqApiKey: groqApiKey ?? undefined,
  anthropicApiKey: anthropicApiKey ?? undefined,
  googleApiKey: googleApiKey ?? undefined,

  // Ollama
  ollamaBaseUrl: optionalEnv('OLLAMA_BASE_URL') ?? 'http://localhost:11434',
  vectorBackend: parseVectorBackend(optionalEnv('VECTOR_BACKEND')),
  skipVectorIndexes: (optionalEnv('SKIP_VECTOR_INDEXES') ?? 'false') === 'true',
  llmSeed: parseLlmSeed(optionalEnv('LLM_SEED')),
  stagedLoadingEnabled: (optionalEnv('STAGED_LOADING_ENABLED') ?? 'false') === 'true',
  retrievalTraceEnabled: (optionalEnv('RETRIEVAL_TRACE_ENABLED') ?? 'false') === 'true',
  ingestTraceDir: optionalEnv('INGEST_TRACE_DIR') ?? './.traces/ingest',
  ingestTraceEnabled: (optionalEnv('INGEST_TRACE_ENABLED') ?? 'false') === 'true',
  extractionCacheEnabled: (optionalEnv('EXTRACTION_CACHE_ENABLED') ?? 'false') === 'true',
  extractionCacheDir: optionalEnv('EXTRACTION_CACHE_DIR') ?? './.eval-cache',
  embeddingCacheEnabled: (optionalEnv('EMBEDDING_CACHE_ENABLED') ?? 'false') === 'true',
  chunkedExtractionEnabled: (optionalEnv('CHUNKED_EXTRACTION_ENABLED') ?? 'false') === 'true',
  chunkedExtractionFallbackEnabled: (optionalEnv('CHUNKED_EXTRACTION_FALLBACK_ENABLED') ?? 'false') === 'true',
  chunkSizeTurns: parseInt(optionalEnv('CHUNK_SIZE_TURNS') ?? '4', 10),
  chunkOverlapTurns: parseInt(optionalEnv('CHUNK_OVERLAP_TURNS') ?? '1', 10),
  consensusExtractionEnabled: (optionalEnv('CONSENSUS_EXTRACTION_ENABLED') ?? 'false') === 'true',
  consensusExtractionRuns: parseInt(optionalEnv('CONSENSUS_EXTRACTION_RUNS') ?? '3', 10),
  observationDateExtractionEnabled: (optionalEnv('OBSERVATION_DATE_EXTRACTION_ENABLED') ?? 'false') === 'true',
  quotedEntityExtractionEnabled: (optionalEnv('QUOTED_ENTITY_EXTRACTION_ENABLED') ?? 'false') === 'true',
  entropyGateEnabled: (optionalEnv('ENTROPY_GATE_ENABLED') ?? 'false') === 'true',
  entropyGateThreshold: parseFloat(optionalEnv('ENTROPY_GATE_THRESHOLD') ?? '0.35'),
  entropyGateAlpha: parseFloat(optionalEnv('ENTROPY_GATE_ALPHA') ?? '0.5'),
  affinityClusteringThreshold: parseFloat(optionalEnv('AFFINITY_CLUSTERING_THRESHOLD') ?? '0.85'),
  affinityClusteringMinSize: parseInt(optionalEnv('AFFINITY_CLUSTERING_MIN_SIZE') ?? '3', 10),
  affinityClusteringBeta: parseFloat(optionalEnv('AFFINITY_CLUSTERING_BETA') ?? '0.5'),
  affinityClusteringTemporalLambda: parseFloat(optionalEnv('AFFINITY_CLUSTERING_TEMPORAL_LAMBDA') ?? '0.1'),
  trustScoringEnabled: (optionalEnv('TRUST_SCORING_ENABLED') ?? 'false') === 'true',
  trustScoreMinThreshold: parseFloat(optionalEnv('TRUST_SCORE_MIN_THRESHOLD') ?? '0.3'),
  trustPenaltyEnabled: (optionalEnv('TRUST_PENALTY_ENABLED') ?? 'false') === 'true',
  auditLoggingEnabled: (optionalEnv('AUDIT_LOGGING_ENABLED') ?? 'false') === 'true',
  decayCycleEnabled: (optionalEnv('DECAY_CYCLE_ENABLED') ?? 'false') === 'true',
  decayRetentionThreshold: parseFloat(optionalEnv('DECAY_RETENTION_THRESHOLD') ?? '0.2'),
  decayMinAgeDays: parseInt(optionalEnv('DECAY_MIN_AGE_DAYS') ?? '7', 10),
  memoryCapEnabled: (optionalEnv('MEMORY_CAP_ENABLED') ?? 'false') === 'true',
  memoryCapMax: parseInt(optionalEnv('MEMORY_CAP_MAX') ?? '5000', 10),
  memoryCapWarnRatio: parseFloat(optionalEnv('MEMORY_CAP_WARN_RATIO') ?? '0.8'),
  entityGraphEnabled: (optionalEnv('ENTITY_GRAPH_ENABLED') ?? 'false') === 'true',
  entityResolutionThreshold: parseFloat(optionalEnv('ENTITY_RESOLUTION_THRESHOLD') ?? '0.92'),
  entitySearchMinSimilarity: parseFloat(optionalEnv('ENTITY_SEARCH_MIN_SIMILARITY') ?? '0.7'),
  lessonsEnabled: (optionalEnv('LESSONS_ENABLED') ?? 'false') === 'true',
  lessonSimilarityThreshold: parseFloat(optionalEnv('LESSON_SIMILARITY_THRESHOLD') ?? '0.75'),
  consensusValidationEnabled: (optionalEnv('CONSENSUS_VALIDATION_ENABLED') ?? 'false') === 'true',
  consensusMinMemories: parseInt(optionalEnv('CONSENSUS_MIN_MEMORIES') ?? '3', 10),
  queryExpansionEnabled: (optionalEnv('QUERY_EXPANSION_ENABLED') ?? 'false') === 'true',
  queryExpansionMinSimilarity: parseFloat(optionalEnv('QUERY_EXPANSION_MIN_SIMILARITY') ?? '0.5'),
  queryAugmentationEnabled: (optionalEnv('QUERY_AUGMENTATION_ENABLED') ?? 'false') === 'true',
  queryAugmentationMaxEntities: parseInt(optionalEnv('QUERY_AUGMENTATION_MAX_ENTITIES') ?? '5', 10),
  queryAugmentationMinSimilarity: parseFloat(optionalEnv('QUERY_AUGMENTATION_MIN_SIMILARITY') ?? '0.4'),
  crossEncoderEnabled: (optionalEnv('CROSS_ENCODER_ENABLED') ?? 'false') === 'true', // ms-marco hurts temporal queries; keep disabled until better model
  crossEncoderModel: optionalEnv('CROSS_ENCODER_MODEL') ?? 'Xenova/ms-marco-MiniLM-L-6-v2',
  crossEncoderDtype: parseCrossEncoderDtype(optionalEnv('CROSS_ENCODER_DTYPE')),
  iterativeRetrievalEnabled: (optionalEnv('ITERATIVE_RETRIEVAL_ENABLED') ?? 'false') === 'true',
  namespaceClassificationEnabled: (optionalEnv('NAMESPACE_CLASSIFICATION_ENABLED') ?? 'false') === 'true',
  fastAudnEnabled: (optionalEnv('FAST_AUDN_ENABLED') ?? 'true') === 'true',
  fastAudnDuplicateThreshold: parseFloat(optionalEnv('FAST_AUDN_DUPLICATE_THRESHOLD') ?? '0.95'),
  observationNetworkEnabled: (optionalEnv('OBSERVATION_NETWORK_ENABLED') ?? 'true') === 'true',
  agenticRetrievalEnabled: (optionalEnv('AGENTIC_RETRIEVAL_ENABLED') ?? 'false') === 'true',
  rerankSkipTopSimilarity: parseFloat(optionalEnv('RERANK_SKIP_TOP_SIMILARITY') ?? '0.85'),
  rerankSkipMinGap: parseFloat(optionalEnv('RERANK_SKIP_MIN_GAP') ?? '0.05'),
  literalListProtectionEnabled: (optionalEnv('LITERAL_LIST_PROTECTION_ENABLED') ?? 'false') === 'true',
  literalListProtectionMaxProtected: parsePositiveIntEnv('LITERAL_LIST_PROTECTION_MAX_PROTECTED', 3),
  temporalQueryConstraintEnabled: (optionalEnv('TEMPORAL_QUERY_CONSTRAINT_ENABLED') ?? 'false') === 'true',
  temporalQueryConstraintBoost: parseFloat(optionalEnv('TEMPORAL_QUERY_CONSTRAINT_BOOST') ?? '2'),
  deferredAudnEnabled: (optionalEnv('DEFERRED_AUDN_ENABLED') ?? 'false') === 'true',
  deferredAudnBatchSize: parseInt(optionalEnv('DEFERRED_AUDN_BATCH_SIZE') ?? '20', 10),
  compositeGroupingEnabled: (optionalEnv('COMPOSITE_GROUPING_ENABLED') ?? 'true') === 'true',
  compositeMinClusterSize: parseInt(optionalEnv('COMPOSITE_MIN_CLUSTER_SIZE') ?? '2', 10),
  compositeMaxClusterSize: parseInt(optionalEnv('COMPOSITE_MAX_CLUSTER_SIZE') ?? '3', 10),
  compositeSimilarityThreshold: parseFloat(optionalEnv('COMPOSITE_SIMILARITY_THRESHOLD') ?? '0.55'),
  costLoggingEnabled: (optionalEnv('COST_LOGGING_ENABLED') ?? 'false') === 'true',
  costLogDir: optionalEnv('COST_LOG_DIR') ?? 'data/cost-logs',
  costRunId: optionalEnv('COST_RUN_ID') ?? '',
  conflictAutoResolveMs: parseInt(optionalEnv('CONFLICT_AUTO_RESOLVE_MS') ?? '86400000', 10),
  runtimeConfigMutationEnabled:
    (process.env.CORE_RUNTIME_CONFIG_MUTATION_ENABLED ?? 'false') === 'true',
};

export function applyRuntimeConfigUpdates(
  target: RuntimeConfig,
  updates: RuntimeConfigUpdates,
): string[] {
  const applied: string[] = [];

  if (updates.similarityThreshold !== undefined) {
    target.similarityThreshold = requireFiniteNumber(updates.similarityThreshold, 'similarityThreshold');
    applied.push('similarityThreshold');
  }
  if (updates.audnCandidateThreshold !== undefined) {
    target.audnCandidateThreshold = requireFiniteNumber(updates.audnCandidateThreshold, 'audnCandidateThreshold');
    applied.push('audnCandidateThreshold');
  }
  if (updates.clarificationConflictThreshold !== undefined) {
    target.clarificationConflictThreshold = requireFiniteNumber(
      updates.clarificationConflictThreshold,
      'clarificationConflictThreshold',
    );
    applied.push('clarificationConflictThreshold');
  }
  if (updates.maxSearchResults !== undefined) {
    target.maxSearchResults = Math.max(1, Math.floor(requireFiniteNumber(updates.maxSearchResults, 'maxSearchResults')));
    applied.push('maxSearchResults');
  }

  return applied;
}

export function updateRuntimeConfig(updates: RuntimeConfigUpdates): string[] {
  return applyRuntimeConfigUpdates(config, updates);
}

/**
 * Public/supported operator config surface. Fields listed here are part of
 * v2's stable contract: consumers can rely on their semantics and presence,
 * and changes go through a documented deprecation cycle.
 *
 * This is a documentation type — it does not constrain threading. The runtime
 * still carries a single `RuntimeConfig` object; this array tags the public
 * subset so docs, tests, and future config-split work have a single source of
 * truth. See also: https://docs.atomicmemory.ai/platform/consuming-core.
 */
export const SUPPORTED_RUNTIME_CONFIG_FIELDS = [
  // Infrastructure
  'databaseUrl', 'openaiApiKey', 'port',
  // Provider / model selection (startup config)
  'embeddingProvider', 'embeddingModel', 'embeddingDimensions',
  'embeddingApiUrl', 'embeddingApiKey',
  'voyageApiKey', 'voyageDocumentModel', 'voyageQueryModel',
  'llmProvider', 'llmModel', 'llmApiUrl', 'llmApiKey',
  'groqApiKey', 'anthropicApiKey', 'googleApiKey',
  'ollamaBaseUrl', 'vectorBackend', 'skipVectorIndexes', 'llmSeed',
  'crossEncoderModel', 'crossEncoderDtype',
  // Operator-visible runtime
  'maxSearchResults', 'retrievalProfile', 'retrievalProfileSettings',
  // Major feature toggles (surfaced in GET /v1/memories/health)
  'entityGraphEnabled', 'lessonsEnabled', 'agenticRetrievalEnabled',
  'iterativeRetrievalEnabled', 'hybridSearchEnabled', 'repairLoopEnabled',
  'crossEncoderEnabled', 'auditLoggingEnabled', 'adaptiveRetrievalEnabled',
  'consensusValidationEnabled', 'namespaceClassificationEnabled',
  // Cost / cache ops
  'extractionCacheDir', 'costLogDir', 'costRunId', 'costLoggingEnabled',
  // Dev/test-only mutation gate for PUT /v1/memories/config
  // (see https://docs.atomicmemory.ai/platform/consuming-core)
  'runtimeConfigMutationEnabled',
] as const;

/**
 * Internal policy config — experimental / tuning flags. Fields here may
 * change semantics, defaults, or be removed without notice. Consumers should
 * NOT rely on these in production. Promoted into the supported contract when
 * a field's behavior stabilizes.
 */
export const INTERNAL_POLICY_CONFIG_FIELDS = [
  // Retrieval thresholds
  'similarityThreshold', 'audnCandidateThreshold', 'audnSafeReuseMinSimilarity',
  'crossAgentCandidateThreshold', 'clarificationConflictThreshold',
  // Repair loop tuning
  'repairLoopMinSimilarity', 'repairSkipSimilarity',
  'repairDeltaThreshold', 'repairConfidenceFloor',
  // Adaptive retrieval tuning
  'adaptiveSimpleLimit', 'adaptiveMediumLimit', 'adaptiveComplexLimit',
  'adaptiveMultiHopLimit', 'adaptiveAggregationLimit',
  // MMR
  'mmrEnabled', 'mmrLambda',
  // Link expansion
  'linkExpansionEnabled', 'linkExpansionMax',
  'linkSimilarityThreshold', 'linkExpansionBeforeMMR',
  // Scoring weights
  'scoringWeightSimilarity', 'scoringWeightImportance', 'scoringWeightRecency',
  // PPR
  'pprEnabled', 'pprDamping',
  // Staging / tracing
  'stagedLoadingEnabled', 'retrievalTraceEnabled', 'ingestTraceDir', 'ingestTraceEnabled',
  // Extraction internals
  'extractionCacheEnabled', 'embeddingCacheEnabled',
  'chunkedExtractionEnabled', 'chunkedExtractionFallbackEnabled',
  'chunkSizeTurns', 'chunkOverlapTurns',
  'consensusExtractionEnabled', 'consensusExtractionRuns',
  'observationDateExtractionEnabled', 'quotedEntityExtractionEnabled',
  'entropyGateEnabled', 'entropyGateThreshold', 'entropyGateAlpha',
  // Affinity clustering
  'affinityClusteringThreshold', 'affinityClusteringMinSize',
  'affinityClusteringBeta', 'affinityClusteringTemporalLambda',
  // Trust
  'trustScoringEnabled', 'trustScoreMinThreshold', 'trustPenaltyEnabled',
  // Decay / caps
  'decayCycleEnabled', 'decayRetentionThreshold', 'decayMinAgeDays',
  'memoryCapEnabled', 'memoryCapMax', 'memoryCapWarnRatio',
  // Entity tuning
  'entityResolutionThreshold', 'entitySearchMinSimilarity',
  // Lesson tuning
  'lessonSimilarityThreshold',
  // Consensus tuning
  'consensusMinMemories',
  // Query expansion / augmentation
  'queryExpansionEnabled', 'queryExpansionMinSimilarity',
  'queryAugmentationEnabled', 'queryAugmentationMaxEntities',
  'queryAugmentationMinSimilarity',
  // Rerank tuning
  'rerankSkipTopSimilarity', 'rerankSkipMinGap',
  // Literal/list answer selection
  'literalListProtectionEnabled', 'literalListProtectionMaxProtected',
  // Temporal query selection
  'temporalQueryConstraintEnabled', 'temporalQueryConstraintBoost',
  // Fast AUDN
  'fastAudnEnabled', 'fastAudnDuplicateThreshold',
  // Observation / deferred
  'observationNetworkEnabled', 'deferredAudnEnabled', 'deferredAudnBatchSize',
  // Composite grouping
  'compositeGroupingEnabled', 'compositeMinClusterSize',
  'compositeMaxClusterSize', 'compositeSimilarityThreshold',
  // Conflict handling
  'conflictAutoResolveMs',
] as const;

export type SupportedRuntimeConfigField = typeof SUPPORTED_RUNTIME_CONFIG_FIELDS[number];
export type InternalPolicyConfigField = typeof INTERNAL_POLICY_CONFIG_FIELDS[number];
export type SupportedRuntimeConfig = Pick<RuntimeConfig, SupportedRuntimeConfigField>;
export type InternalPolicyConfig = Pick<RuntimeConfig, InternalPolicyConfigField>;
