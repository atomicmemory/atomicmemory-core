/**
 * Postgres-backed MemoryStore implementation.
 * Delegates to existing repository-read.ts and repository-write.ts functions.
 */

import type pg from 'pg';
import type { MemoryStore, StoreMemoryInput } from './stores.js';
import type { CanonicalMemoryObjectLineage } from './repository-types.js';
import {
  getMemory,
  getMemoryInWorkspace,
  getMemoryStats,
  listMemories,
  listMemoriesInWorkspace,
  countMemories,
  countNeedsClarification,
} from './repository-read.js';
import {
  backdateMemories,
  deleteAll,
  deleteBySource,
  expireMemory,
  softDeleteMemory,
  softDeleteMemoryInWorkspace,
  storeCanonicalMemoryObject,
  storeMemory,
  touchMemory,
  updateMemoryContent,
  updateMemoryMetadata,
  updateOpinionConfidence,
} from './repository-write.js';

export class PgMemoryStore implements MemoryStore {
  constructor(private pool: pg.Pool) {}

  async storeMemory(input: StoreMemoryInput) { return storeMemory(this.pool, input); }
  async getMemory(id: string, userId?: string) { return getMemory(this.pool, id, userId, false); }
  async getMemoryIncludingDeleted(id: string, userId?: string) { return getMemory(this.pool, id, userId, true); }
  async listMemories(userId: string, limit = 20, offset = 0, sourceSite?: string, episodeId?: string) { return listMemories(this.pool, userId, limit, offset, sourceSite, episodeId); }
  async softDeleteMemory(userId: string, id: string) { return softDeleteMemory(this.pool, userId, id); }
  async updateMemoryContent(userId: string, id: string, content: string, embedding: number[], importance: number, keywords?: string, trustScore?: number) { return updateMemoryContent(this.pool, userId, id, content, embedding, importance, keywords, trustScore); }
  async updateMemoryMetadata(userId: string, id: string, metadata: Record<string, unknown>) { return updateMemoryMetadata(this.pool, userId, id, metadata); }
  async expireMemory(userId: string, id: string) { return expireMemory(this.pool, userId, id); }
  async touchMemory(id: string) { return touchMemory(this.pool, id); }
  async countMemories(userId?: string) { return countMemories(this.pool, userId); }
  async getMemoryStats(userId: string) { return getMemoryStats(this.pool, userId); }
  async deleteBySource(userId: string, sourceSite: string) { return deleteBySource(this.pool, userId, sourceSite); }
  async deleteAll(userId?: string) { return deleteAll(this.pool, userId); }
  async backdateMemories(ids: string[], timestamp: Date) { return backdateMemories(this.pool, ids, timestamp); }
  async updateOpinionConfidence(userId: string, memoryId: string, newConfidence: number) { return updateOpinionConfidence(this.pool, userId, memoryId, newConfidence); }
  async countNeedsClarification(userId: string) { return countNeedsClarification(this.pool, userId); }
  async storeCanonicalMemoryObject(input: { userId: string; objectFamily: 'ingested_fact'; payloadFormat?: string; canonicalPayload: { factText: string; factType: string; headline: string; keywords: string[] }; provenance: { episodeId: string | null; sourceSite: string; sourceUrl: string }; observedAt?: Date; lineage: CanonicalMemoryObjectLineage }) { return storeCanonicalMemoryObject(this.pool, input); }
  async getMemoryInWorkspace(id: string, workspaceId: string, callerAgentId?: string) { return getMemoryInWorkspace(this.pool, id, workspaceId, callerAgentId); }
  async listMemoriesInWorkspace(workspaceId: string, limit = 20, offset = 0, callerAgentId?: string) { return listMemoriesInWorkspace(this.pool, workspaceId, limit, offset, callerAgentId); }
  async softDeleteMemoryInWorkspace(id: string, workspaceId: string) { return softDeleteMemoryInWorkspace(this.pool, id, workspaceId); }
}
