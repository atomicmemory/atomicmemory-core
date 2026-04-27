/**
 * Core memory service facade -- delegates to memory-ingest, memory-search, and memory-crud.
 * Preserves the public API (routes call service.search(), service.quickIngest(), etc.)
 * while keeping each concern in a focused, testable module.
 */

import { config } from '../config.js';
import { MemoryRepository } from '../db/memory-repository.js';
import { ClaimRepository } from '../db/claim-repository.js';
import { EntityRepository } from '../db/repository-entities.js';
import { LessonRepository } from '../db/repository-lessons.js';
import { ObservationService } from './observation-service.js';
import { URIResolver } from './atomicmem-uri.js';
import type { CoreStores } from '../db/stores.js';
import { type TierAssignment } from './tiered-loading.js';
import { type ConsolidationResult, type ConsolidationExecutionResult } from './consolidation-service.js';
import { type DecayResult, type CapCheckResult } from './memory-lifecycle.js';
import { type ReconciliationResult } from './deferred-audn.js';
import type { AgentScope, AuditTrailEntry, MemoryMetadata, MutationSummary, WorkspaceContext } from '../db/repository-types.js';
import type { FactInput, IngestResult, MemoryScope, MemoryServiceDeps, Outcome, RetrievalOptions, RetrievalResult, ScopedSearchOptions } from './memory-service-types.js';

import { performIngest, performQuickIngest, performStoreVerbatim, performWorkspaceIngest } from './memory-ingest.js';
import { performSearch, performFastSearch, performWorkspaceSearch } from './memory-search.js';
import * as crud from './memory-crud.js';

export type { FactInput, IngestResult, Outcome, RetrievalResult };
export type { TierAssignment };

export type { crud as CrudModule };
export type ClaimSlotBackfillResult = crud.ClaimSlotBackfillResult;

export class MemoryService {
  private deps: MemoryServiceDeps;

  constructor(
    private repo: MemoryRepository,
    private claims: ClaimRepository,
    entities?: EntityRepository,
    lessons?: LessonRepository,
    observationService?: ObservationService,
    runtimeConfig?: MemoryServiceDeps['config'],
    stores?: CoreStores,
  ) {
    const resolvedEntities = entities ?? null;
    const resolvedLessons = lessons ?? null;
    this.deps = {
      config: runtimeConfig ?? config,
      stores: stores ?? {
        memory: repo,
        episode: repo,
        search: repo,
        link: repo,
        representation: repo,
        claim: claims,
        entity: resolvedEntities,
        lesson: resolvedLessons,
        pool: typeof repo.getPool === 'function' ? repo.getPool() : ({} as never),
      },
      observationService: observationService ?? null,
      uriResolver: new URIResolver(repo, claims),
    };
  }

  /**
   * Build a request-scoped deps bundle that swaps in the effective config
   * for the duration of a single call. Returns the shared `this.deps`
   * unchanged when no override is supplied (zero-allocation fast path).
   * All per-fact/per-pipeline helpers already read `deps.config`, so
   * replacing it at the entry point propagates through the service layer
   * without mutating shared state.
   */
  private depsFor(effectiveConfig?: MemoryServiceDeps['config']): MemoryServiceDeps {
    if (!effectiveConfig) return this.deps;
    return { ...this.deps, config: effectiveConfig };
  }

  // --- Ingest ---

  async ingest(userId: string, conversationText: string, sourceSite: string, sourceUrl: string = '', sessionTimestamp?: Date, effectiveConfig?: MemoryServiceDeps['config']): Promise<IngestResult> {
    return performIngest(this.depsFor(effectiveConfig), userId, conversationText, sourceSite, sourceUrl, sessionTimestamp);
  }

  async quickIngest(userId: string, conversationText: string, sourceSite: string, sourceUrl: string = '', sessionTimestamp?: Date, effectiveConfig?: MemoryServiceDeps['config']): Promise<IngestResult> {
    return performQuickIngest(this.depsFor(effectiveConfig), userId, conversationText, sourceSite, sourceUrl, sessionTimestamp);
  }

  /**
   * Store content as a single memory without fact extraction.
   * Used for user-created contexts (text/file uploads) where
   * the content should remain as one canonical memory record.
   */
  async storeVerbatim(userId: string, content: string, sourceSite: string, sourceUrl: string = '', metadata?: MemoryMetadata, effectiveConfig?: MemoryServiceDeps['config']): Promise<IngestResult> {
    return performStoreVerbatim(this.depsFor(effectiveConfig), userId, content, sourceSite, sourceUrl, metadata);
  }

  async workspaceIngest(userId: string, conversationText: string, sourceSite: string, sourceUrl: string = '', workspace: WorkspaceContext, sessionTimestamp?: Date, effectiveConfig?: MemoryServiceDeps['config']): Promise<IngestResult> {
    return performWorkspaceIngest(this.depsFor(effectiveConfig), userId, conversationText, sourceSite, sourceUrl, workspace, sessionTimestamp);
  }

  // --- Search (scope-dispatching) ---

  /** Scope-dispatching search: routes to user or workspace search based on scope.kind. */
  async scopedSearch(scope: MemoryScope, query: string, options: ScopedSearchOptions = {}): Promise<RetrievalResult> {
    const deps = this.depsFor(options.effectiveConfig);
    if (scope.kind === 'workspace') {
      const ws: WorkspaceContext = { workspaceId: scope.workspaceId, agentId: scope.agentId };
      return performWorkspaceSearch(deps, scope.userId, query, ws, {
        agentScope: scope.agentScope,
        limit: options.limit,
        referenceTime: options.referenceTime,
        retrievalOptions: options.retrievalOptions,
      });
    }
    if (options.fast) {
      return performFastSearch(deps, scope.userId, query, options.sourceSite, options.limit, options.namespaceScope);
    }
    return performSearch(deps, scope.userId, query, options.sourceSite, options.limit, options.asOf, options.referenceTime, options.namespaceScope, options.retrievalOptions);
  }

  /** Scope-dispatching expand with agent visibility enforcement for workspace operations. */
  async scopedExpand(scope: MemoryScope, memoryIds: string[]) {
    if (scope.kind === 'workspace') return crud.expandMemoriesInWorkspace(this.deps, scope.workspaceId, memoryIds, scope.agentId);
    return crud.expandMemories(this.deps, scope.userId, memoryIds);
  }

  /** Scope-dispatching get with agent visibility enforcement for workspace operations. */
  async scopedGet(scope: MemoryScope, id: string) {
    if (scope.kind === 'workspace') return crud.getMemoryInWorkspace(this.deps, id, scope.workspaceId, scope.agentId);
    return crud.getMemory(this.deps, id, scope.userId);
  }

  /** Scope-dispatching delete with agent visibility enforcement. Returns false if not found/not visible. */
  async scopedDelete(scope: MemoryScope, id: string): Promise<boolean> {
    if (scope.kind === 'workspace') return crud.deleteMemoryInWorkspace(this.deps, id, scope.workspaceId, scope.agentId);
    await crud.deleteMemory(this.deps, id, scope.userId);
    return true;
  }

  /** Scope-dispatching list with agent visibility enforcement for workspace operations. */
  async scopedList(scope: MemoryScope, limit: number = 20, offset: number = 0, sourceSite?: string, episodeId?: string) {
    if (scope.kind === 'workspace') return crud.listMemoriesInWorkspace(this.deps, scope.workspaceId, limit, offset, scope.agentId);
    return crud.listMemories(this.deps, scope.userId, limit, offset, sourceSite, episodeId);
  }

  // --- Search (legacy, prefer scopedSearch) ---

  /** @deprecated Use scopedSearch instead. */
  async search(userId: string, query: string, sourceSite?: string, limit?: number, asOf?: string, referenceTime?: Date, namespaceScope?: string, retrievalOptions?: RetrievalOptions): Promise<RetrievalResult> {
    return performSearch(this.deps, userId, query, sourceSite, limit, asOf, referenceTime, namespaceScope, retrievalOptions);
  }

  /** @deprecated Use scopedSearch instead. */
  async fastSearch(userId: string, query: string, sourceSite?: string, limit?: number, namespaceScope?: string): Promise<RetrievalResult> {
    return performFastSearch(this.deps, userId, query, sourceSite, limit, namespaceScope);
  }

  /** @deprecated Use scopedSearch instead. */
  async workspaceSearch(userId: string, query: string, workspace: WorkspaceContext, options: { agentScope?: AgentScope; limit?: number; referenceTime?: Date; retrievalOptions?: RetrievalOptions } = {}): Promise<RetrievalResult> {
    return performWorkspaceSearch(this.deps, userId, query, workspace, options);
  }

  // --- CRUD ---

  async list(userId: string, limit: number = 20, offset: number = 0, sourceSite?: string, episodeId?: string) { return crud.listMemories(this.deps, userId, limit, offset, sourceSite, episodeId); }
  async get(id: string, userId: string) { return crud.getMemory(this.deps, id, userId); }
  async expand(userId: string, memoryIds: string[]) { return crud.expandMemories(this.deps, userId, memoryIds); }
  async delete(id: string, userId: string) { return crud.deleteMemory(this.deps, id, userId); }
  async resetBySource(userId: string, sourceSite: string) { return crud.resetBySource(this.deps, userId, sourceSite); }
  async getStats(userId: string) { return crud.getStats(this.deps, userId); }

  // --- Consolidation / Lifecycle ---

  async consolidate(userId: string): Promise<ConsolidationResult> { return crud.consolidate(this.deps, userId); }
  async executeConsolidation(userId: string): Promise<ConsolidationExecutionResult> { return crud.performExecuteConsolidation(this.deps, userId); }
  async reconcileDeferred(userId: string): Promise<ReconciliationResult> { return crud.reconcileDeferred(this.deps, userId); }
  async reconcileDeferredAll(): Promise<ReconciliationResult> { return crud.reconcileDeferredAll(this.deps); }
  async getDeferredStatus(userId: string) { return crud.getDeferredStatus(this.deps, userId); }
  async evaluateDecay(userId: string, referenceTime?: Date): Promise<DecayResult> { return crud.evaluateDecay(this.deps, userId, referenceTime); }
  async archiveDecayed(userId: string, memoryIds: string[]): Promise<number> { return crud.archiveDecayed(this.deps, userId, memoryIds); }
  async checkCap(userId: string): Promise<CapCheckResult> { return crud.checkCap(this.deps, userId); }

  // --- Audit / Mutations ---

  async getAuditTrail(userId: string, memoryId: string): Promise<AuditTrailEntry[]> { return crud.getAuditTrail(this.deps, userId, memoryId); }
  async getMutationSummary(userId: string): Promise<MutationSummary> { return crud.getMutationSummary(this.deps, userId); }
  async getRecentMutations(userId: string, limit: number = 20) { return crud.getRecentMutations(this.deps, userId, limit); }
  async backfillClaimSlots(userId: string): Promise<crud.ClaimSlotBackfillResult> { return crud.backfillClaimSlots(this.deps, userId); }
  async getReversalChain(userId: string, versionId: string) { return crud.getReversalChain(this.deps, userId, versionId); }

  // --- Lessons ---

  async getLessons(userId: string) { return crud.getLessons(this.deps, userId); }
  async getLessonStats(userId: string) { return crud.getLessonStats(this.deps, userId); }
  async reportLesson(userId: string, pattern: string, sourceMemoryIds: string[], severity?: 'low' | 'medium' | 'high' | 'critical') { return crud.reportLesson(this.deps, userId, pattern, sourceMemoryIds, severity); }
  async deactivateLesson(userId: string, lessonId: string) { return crud.deactivateLesson(this.deps, userId, lessonId); }

  // NOTE: Do NOT add multi-query search. Tested and caused 0-retrieval failures
  // due to embedding API rate limits with 4x calls per query.
}
