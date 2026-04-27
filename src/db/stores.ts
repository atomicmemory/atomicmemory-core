/**
 * Domain-facing store interfaces for Phase 5.
 *
 * Each interface exposes only the methods its domain consumers need.
 * Implementations delegate to the existing split repository modules
 * (repository-read.ts, repository-write.ts, repository-links.ts, etc.).
 *
 * For ClaimStore, EntityStore, and LessonStore, the existing repository
 * classes already serve as implementations — these interfaces are extracted
 * from their public surfaces.
 */

import type pg from 'pg';
import type {
  AgentScope,
  AtomicFactRow,
  CanonicalMemoryObjectLineage,
  ForesightRow,
  MemoryRow,
  SearchResult,
  EpisodeRow,
  StoreMemoryInput,
} from './repository-types.js';
import type { CandidateRow } from './repository-vector-search.js';
import type { StoreAtomicFactInput, StoreForesightInput } from './repository-representations.js';
import type { MemoryLink } from './repository-links.js';

// StoreMemoryInput is shared with the repository write path; re-exported
// here so existing consumers of `./stores.js` keep working.
export type { StoreMemoryInput };

// ---------------------------------------------------------------------------
// MemoryStore — memory CRUD + workspace variants
// ---------------------------------------------------------------------------

export interface MemoryStore {
  storeMemory(input: StoreMemoryInput): Promise<string>;
  getMemory(id: string, userId?: string): Promise<MemoryRow | null>;
  getMemoryIncludingDeleted(id: string, userId?: string): Promise<MemoryRow | null>;
  listMemories(userId: string, limit?: number, offset?: number, sourceSite?: string, episodeId?: string): Promise<MemoryRow[]>;
  softDeleteMemory(userId: string, id: string): Promise<void>;
  updateMemoryContent(userId: string, id: string, content: string, embedding: number[], importance: number, keywords?: string, trustScore?: number): Promise<void>;
  updateMemoryMetadata(userId: string, id: string, metadata: Record<string, unknown>): Promise<void>;
  expireMemory(userId: string, id: string): Promise<void>;
  touchMemory(id: string): Promise<void>;
  countMemories(userId?: string): Promise<number>;
  getMemoryStats(userId: string): Promise<{ count: number; avgImportance: number; sourceDistribution: Record<string, number> }>;
  deleteBySource(userId: string, sourceSite: string): Promise<{ deletedMemories: number; deletedEpisodes: number }>;
  deleteAll(userId?: string): Promise<void>;
  backdateMemories(ids: string[], timestamp: Date): Promise<void>;
  updateOpinionConfidence(userId: string, memoryId: string, newConfidence: number): Promise<void>;
  countNeedsClarification(userId: string): Promise<number>;
  storeCanonicalMemoryObject(input: {
    userId: string;
    objectFamily: 'ingested_fact';
    payloadFormat?: string;
    canonicalPayload: { factText: string; factType: string; headline: string; keywords: string[] };
    provenance: { episodeId: string | null; sourceSite: string; sourceUrl: string };
    observedAt?: Date;
    lineage: CanonicalMemoryObjectLineage;
  }): Promise<string>;
  // Workspace variants
  getMemoryInWorkspace(id: string, workspaceId: string, callerAgentId?: string): Promise<MemoryRow | null>;
  listMemoriesInWorkspace(workspaceId: string, limit?: number, offset?: number, callerAgentId?: string): Promise<MemoryRow[]>;
  softDeleteMemoryInWorkspace(id: string, workspaceId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// EpisodeStore
// ---------------------------------------------------------------------------

export interface EpisodeStore {
  storeEpisode(input: { userId: string; content: string; sourceSite: string; sourceUrl?: string; sessionId?: string; workspaceId?: string; agentId?: string }): Promise<string>;
  getEpisode(id: string): Promise<EpisodeRow | null>;
}

// ---------------------------------------------------------------------------
// SearchStore — vector/hybrid/keyword search + dedup finding
// ---------------------------------------------------------------------------

export interface SearchStore {
  searchSimilar(userId: string, queryEmbedding: number[], limit: number, sourceSite?: string, referenceTime?: Date): Promise<SearchResult[]>;
  searchHybrid(userId: string, queryText: string, queryEmbedding: number[], limit: number, sourceSite?: string, referenceTime?: Date): Promise<SearchResult[]>;
  searchKeyword(userId: string, queryText: string, limit: number, sourceSite?: string): Promise<SearchResult[]>;
  searchAtomicFactsHybrid(userId: string, queryText: string, queryEmbedding: number[], limit: number, sourceSite?: string, referenceTime?: Date): Promise<SearchResult[]>;
  findNearDuplicates(userId: string, embedding: number[], threshold: number, limit?: number): Promise<CandidateRow[]>;
  findKeywordCandidates(userId: string, keywords: string[], limit?: number, includeExpired?: boolean): Promise<CandidateRow[]>;
  findTemporalNeighbors(userId: string, anchorTimestamps: Date[], queryEmbedding: number[], windowMinutes: number, excludeIds: Set<string>, limit: number, referenceTime?: Date): Promise<SearchResult[]>;
  fetchMemoriesByIds(userId: string, ids: string[], queryEmbedding: number[], referenceTime?: Date, includeExpired?: boolean): Promise<SearchResult[]>;
  // Workspace variants
  searchSimilarInWorkspace(workspaceId: string, queryEmbedding: number[], limit: number, agentScope?: AgentScope, callerAgentId?: string, referenceTime?: Date): Promise<SearchResult[]>;
  findNearDuplicatesInWorkspace(workspaceId: string, embedding: number[], threshold: number, limit?: number, agentScope?: AgentScope, callerAgentId?: string): Promise<CandidateRow[]>;
}

// ---------------------------------------------------------------------------
// SemanticLinkStore
// ---------------------------------------------------------------------------

export interface SemanticLinkStore {
  createLinks(links: MemoryLink[]): Promise<number>;
  findLinkCandidates(userId: string, embedding: number[], threshold: number, excludeId: string, limit?: number): Promise<Array<{ id: string; similarity: number }>>;
  findLinkedMemoryIds(memoryIds: string[], excludeIds: Set<string>, limit: number): Promise<string[]>;
  countLinks(): Promise<number>;
}

// ---------------------------------------------------------------------------
// RepresentationStore — atomic facts + foresight projections
// ---------------------------------------------------------------------------

export interface RepresentationStore {
  storeAtomicFacts(facts: StoreAtomicFactInput[]): Promise<string[]>;
  storeForesight(entries: StoreForesightInput[]): Promise<string[]>;
  listAtomicFactsForMemory(userId: string, parentMemoryId: string): Promise<AtomicFactRow[]>;
  listForesightForMemory(userId: string, parentMemoryId: string): Promise<ForesightRow[]>;
  replaceAtomicFactsForMemory(userId: string, parentMemoryId: string, facts: StoreAtomicFactInput[]): Promise<string[]>;
  replaceForesightForMemory(userId: string, parentMemoryId: string, entries: StoreForesightInput[]): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// ClaimStore — narrowed to the methods domain consumers actually call
// ---------------------------------------------------------------------------

export type ClaimStore = Pick<import('./repository-claims.js').ClaimRepository,
  | 'addEvidence'
  | 'createClaim'
  | 'createClaimVersion'
  | 'createUpdateVersion'
  | 'findClaimByMemoryId'
  | 'getActiveClaimTargetBySlot'
  | 'getClaimVersionByMemoryId'
  | 'getRecentMutations'
  | 'getReversalChain'
  | 'getUserMutationSummary'
  | 'invalidateClaim'
  | 'listClaimsMissingSlots'
  | 'searchClaimVersions'
  | 'setClaimCurrentVersion'
  | 'supersedeClaimVersion'
  | 'updateClaimSlot'
  | 'deleteAll'
>;

// ---------------------------------------------------------------------------
// EntityStore — narrowed to the methods domain consumers actually call
// ---------------------------------------------------------------------------

export type EntityStore = Pick<import('./repository-entities.js').EntityRepository,
  | 'resolveEntity'
  | 'linkMemoryToEntity'
  | 'getEntitiesForMemory'
  | 'getEntity'
  | 'searchEntities'
  | 'findEntitiesByName'
  | 'findMemoryIdsByEntities'
  | 'findRelatedEntityIds'
  | 'findDeterministicEntity'
  | 'getRelationsForMemory'
  | 'upsertRelation'
  | 'countEntities'
>;

// ---------------------------------------------------------------------------
// LessonStore — narrowed to the methods domain consumers actually call
// ---------------------------------------------------------------------------

export type LessonStore = Pick<import('./repository-lessons.js').LessonRepository,
  | 'createLesson'
  | 'findSimilarLessons'
  | 'getLessonsByUser'
  | 'getLessonsByType'
  | 'deactivateLesson'
  | 'countActiveLessons'
  | 'deleteAll'
>;

// ---------------------------------------------------------------------------
// Bundled stores shape for runtime container
// ---------------------------------------------------------------------------

export interface CoreStores {
  memory: MemoryStore;
  episode: EpisodeStore;
  search: SearchStore;
  link: SemanticLinkStore;
  representation: RepresentationStore;
  claim: ClaimStore;
  entity: EntityStore | null;
  lesson: LessonStore | null;
  /**
   * Raw pool access for call sites that still need it (PPR, deferred-audn
   * reconciliation, link generation). Will be removed when those paths
   * move behind dedicated store methods.
   */
  pool: pg.Pool;
}
