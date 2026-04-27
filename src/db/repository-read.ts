/**
 * Read-side queries for active memory projections.
 */

import pg from 'pg';
import { config } from '../config.js';
import {
  type EpisodeRow,
  type MemoryRow,
  type SearchResult,
  normalizeMemoryRow,
  normalizeSearchRow,
} from './repository-types.js';
import {
  findDuplicateVectors,
  findDuplicateVectorsInWorkspace,
  searchHybrid,
  searchKeyword,
  searchVectors,
  searchVectorsInWorkspace,
} from './repository-vector-search.js';
import type { AgentScope } from './repository-types.js';

export async function getEpisode(pool: pg.Pool, id: string): Promise<EpisodeRow | null> {
  const result = await pool.query('SELECT * FROM episodes WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}

export async function getMemory(
  pool: pg.Pool,
  id: string,
  userId?: string,
  includeDeleted: boolean = false,
): Promise<MemoryRow | null> {
  return getMemoryWithClient(pool as any, id, userId, includeDeleted);
}

export async function getMemoryWithClient(
  client: pg.PoolClient,
  id: string,
  userId?: string,
  includeDeleted: boolean = false,
): Promise<MemoryRow | null> {
  const clauses = ['id = $1'];
  const params: string[] = [id];
  if (userId) {
    clauses.push(`user_id = $${params.length + 1}`);
    params.push(userId);
  }
  if (!includeDeleted) {
    clauses.push('deleted_at IS NULL');
    clauses.push('expired_at IS NULL');
  }
  const result = await client.query(`SELECT * FROM memories WHERE ${clauses.join(' AND ')}`, params);
  return result.rows[0] ? normalizeMemoryRow(result.rows[0]) : null;
}

export async function listMemories(pool: pg.Pool, userId: string, limit: number, offset: number, sourceSite?: string, episodeId?: string): Promise<MemoryRow[]> {
  const params: unknown[] = [userId, limit, offset];
  let extraClauses = '';
  if (sourceSite) {
    params.push(sourceSite);
    extraClauses += ` AND source_site = $${params.length}`;
  }
  if (episodeId) {
    params.push(episodeId);
    extraClauses += ` AND episode_id = $${params.length}`;
  }
  const result = await pool.query(
    `SELECT * FROM memories
     WHERE user_id = $1 AND deleted_at IS NULL AND expired_at IS NULL AND status = 'active'
       AND workspace_id IS NULL${extraClauses}
     ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    params,
  );
  return result.rows.map(normalizeMemoryRow);
}

export async function listMemoriesInWorkspace(
  pool: pg.Pool,
  workspaceId: string,
  limit: number,
  offset: number,
  callerAgentId?: string,
): Promise<MemoryRow[]> {
  const params: unknown[] = [workspaceId];
  let visibilityClause = '';
  if (callerAgentId) {
    params.push(callerAgentId);
    visibilityClause = buildVisibilityClause(params.length);
  }
  params.push(limit, offset);
  const result = await pool.query(
    `SELECT * FROM memories
     WHERE workspace_id = $1 AND deleted_at IS NULL AND expired_at IS NULL AND status = 'active'
     ${visibilityClause}
     ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return result.rows.map(normalizeMemoryRow);
}

export async function getMemoryInWorkspace(
  pool: pg.Pool,
  id: string,
  workspaceId: string,
  callerAgentId?: string,
): Promise<MemoryRow | null> {
  const params: unknown[] = [id, workspaceId];
  let visibilityClause = '';
  if (callerAgentId) {
    params.push(callerAgentId);
    visibilityClause = buildVisibilityClause(params.length);
  }
  const result = await pool.query(
    `SELECT * FROM memories WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL ${visibilityClause}`,
    params,
  );
  return result.rows[0] ? normalizeMemoryRow(result.rows[0]) : null;
}

/**
 * Build agent visibility enforcement clause.
 * Replicates the logic from buildVisibilityClauseForSearch in repository-vector-search.ts.
 */
function buildVisibilityClause(agentParamIndex: number): string {
  return `AND (
    visibility = 'workspace'
    OR visibility IS NULL
    OR (visibility = 'agent_only' AND agent_id = $${agentParamIndex})
    OR (visibility = 'restricted' AND (
      agent_id = $${agentParamIndex}
      OR EXISTS (
        SELECT 1 FROM memory_visibility_grants g
        WHERE g.memory_id = memories.id AND g.grantee_agent_id = $${agentParamIndex}
      )
    ))
  )`;
}

export async function listMemoriesByNamespace(
  pool: pg.Pool,
  userId: string,
  namespace: string,
  limit: number = 20,
): Promise<MemoryRow[]> {
  const result = await pool.query(
    `SELECT * FROM memories
     WHERE user_id = $1
       AND namespace = $2
       AND deleted_at IS NULL
       AND expired_at IS NULL
       AND status = 'active'
     ORDER BY created_at DESC
     LIMIT $3`,
    [userId, namespace, limit],
  );
  return result.rows.map(normalizeMemoryRow);
}

export async function getMemoryStats(
  pool: pg.Pool,
  userId: string,
): Promise<{ count: number; avgImportance: number; sourceDistribution: Record<string, number> }> {
  const counts = await pool.query(
    `SELECT COUNT(*)::int AS count, AVG(importance) AS avg_importance
     FROM memories WHERE user_id = $1 AND deleted_at IS NULL AND expired_at IS NULL AND status = 'active'`,
    [userId],
  );
  const sources = await pool.query(
    `SELECT source_site, COUNT(*)::int AS count
     FROM memories WHERE user_id = $1 AND deleted_at IS NULL AND expired_at IS NULL AND status = 'active'
     GROUP BY source_site`,
    [userId],
  );
  return {
    count: counts.rows[0].count ?? 0,
    avgImportance: Number(counts.rows[0].avg_importance ?? 0),
    sourceDistribution: Object.fromEntries(sources.rows.map((row) => [row.source_site, row.count])),
  };
}

export async function searchSimilar(
  pool: pg.Pool,
  userId: string,
  queryEmbedding: number[],
  limit: number,
  sourceSite?: string,
  referenceTime?: Date,
): Promise<SearchResult[]> {
  return searchVectors(pool, userId, queryEmbedding, limit, sourceSite, referenceTime);
}

export async function searchHybridSimilar(
  pool: pg.Pool,
  userId: string,
  queryText: string,
  queryEmbedding: number[],
  limit: number,
  sourceSite?: string,
  referenceTime?: Date,
): Promise<SearchResult[]> {
  return searchHybrid(pool, userId, queryText, queryEmbedding, limit, sourceSite, referenceTime);
}

export async function searchKeywordSimilar(
  pool: pg.Pool,
  userId: string,
  queryText: string,
  limit: number,
  sourceSite?: string,
): Promise<SearchResult[]> {
  return searchKeyword(pool, userId, queryText, limit, sourceSite);
}

export async function findNearDuplicates(
  pool: pg.Pool,
  userId: string,
  embedding: number[],
  threshold: number,
  limit: number,
) {
  return findDuplicateVectors(pool, userId, embedding, threshold, limit);
}

/**
 * Workspace-scoped vector search with agent filtering and visibility enforcement.
 */
export async function searchSimilarInWorkspace(
  pool: pg.Pool,
  workspaceId: string,
  queryEmbedding: number[],
  limit: number,
  agentScope: AgentScope = 'all',
  callerAgentId?: string,
  referenceTime?: Date,
): Promise<SearchResult[]> {
  return searchVectorsInWorkspace(pool, workspaceId, queryEmbedding, limit, agentScope, callerAgentId, referenceTime);
}

/**
 * Find near-duplicate memories within a workspace scope for AUDN conflict detection.
 */
export async function findNearDuplicatesInWorkspace(
  pool: pg.Pool,
  workspaceId: string,
  embedding: number[],
  threshold: number,
  limit: number,
  agentScope: AgentScope = 'all',
  callerAgentId?: string,
) {
  return findDuplicateVectorsInWorkspace(pool, workspaceId, embedding, threshold, limit, agentScope, callerAgentId);
}

export async function findKeywordCandidates(
  pool: pg.Pool,
  userId: string,
  keywords: string[],
  limit: number,
  includeExpired: boolean = false,
) {
  if (keywords.length === 0) return [];
  const candidateLimit = Math.max(limit * 4, limit);
  const expiredClause = includeExpired ? '' : 'AND expired_at IS NULL';
  const result = await pool.query(
    `SELECT id, content, importance
     FROM memories
     WHERE user_id = $1
       AND deleted_at IS NULL
       ${expiredClause}
       AND status = 'active'
       AND workspace_id IS NULL
       AND content ILIKE ANY($2::text[])
     ORDER BY importance DESC, created_at DESC
     LIMIT $3`,
    [userId, keywords.map((keyword) => `%${keyword}%`), candidateLimit],
  );
  return result.rows
    .map((row) => ({
      ...row,
      similarity: estimateKeywordSimilarity(row.content, keywords),
    }))
    .sort((left, right) => {
      if (right.similarity !== left.similarity) {
        return right.similarity - left.similarity;
      }
      return Number(right.importance) - Number(left.importance);
    })
    .slice(0, limit);
}

export async function countMemories(pool: pg.Pool, userId?: string): Promise<number> {
  const query = userId
    ? `SELECT COUNT(*)::int AS count FROM memories WHERE user_id = $1 AND deleted_at IS NULL AND expired_at IS NULL AND status = 'active'`
    : `SELECT COUNT(*)::int AS count FROM memories WHERE deleted_at IS NULL AND expired_at IS NULL AND status = 'active'`;
  const result = await pool.query(query, userId ? [userId] : []);
  return result.rows[0].count;
}

export async function countNeedsClarification(pool: pg.Pool, userId: string): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM memories WHERE user_id = $1 AND deleted_at IS NULL AND expired_at IS NULL AND status = 'needs_clarification'`,
    [userId],
  );
  return result.rows[0].count;
}

/**
 * Finds memories created within a time window of the given anchor timestamps.
 * Used for 1-hop temporal-neighbor expansion: surfaces facts from the same
 * conversation session that the initial top-K results originated from.
 */
export async function findTemporalNeighbors(
  pool: pg.Pool,
  userId: string,
  anchorTimestamps: Date[],
  queryEmbedding: number[],
  windowMinutes: number,
  excludeIds: Set<string>,
  limit: number,
  referenceTime?: Date,
): Promise<SearchResult[]> {
  if (anchorTimestamps.length === 0 || limit <= 0) return [];

  const pgvector = await import('pgvector/pg');
  const excludeArray = [...excludeIds];
  const windowInterval = `${windowMinutes} minutes`;

  const wSim = config.scoringWeightSimilarity;
  const wImp = config.scoringWeightImportance;
  const wRec = config.scoringWeightRecency;
  const refTime = (referenceTime ?? new Date()).toISOString();

  const result = await pool.query(
    `SELECT *,
       1 - (embedding <=> $1) AS similarity,
       (
         $7 * (1 - (embedding <=> $1))
         + $8 * importance
         + $9 * EXP(-EXTRACT(EPOCH FROM ($10::timestamptz - last_accessed_at)) / 2592000.0)
       ) * COALESCE(trust_score, 1.0) AS score
     FROM memories
     WHERE user_id = $2
       AND deleted_at IS NULL
       AND expired_at IS NULL
       AND status = 'active'
       AND workspace_id IS NULL
       AND id != ALL($3::uuid[])
       AND EXISTS (
         SELECT 1 FROM unnest($4::timestamptz[]) AS anchor
         WHERE memories.created_at BETWEEN anchor - $5::interval AND anchor + $5::interval
       )
     ORDER BY score DESC
     LIMIT $6`,
    [
      pgvector.default.toSql(queryEmbedding),
      userId,
      excludeArray,
      anchorTimestamps,
      windowInterval,
      limit,
      wSim, wImp, wRec, refTime,
    ],
  );
  return result.rows.map(normalizeSearchRow);
}

function estimateKeywordSimilarity(content: string, keywords: string[]): number {
  const lower = content.toLowerCase();
  const weights = keywords.map((keyword) => keywordWeight(keyword));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight === 0) return 0.45;

  let matchedWeight = 0;
  for (let i = 0; i < keywords.length; i++) {
    if (lower.includes(keywords[i].toLowerCase())) {
      matchedWeight += weights[i];
    }
  }

  return Math.min(0.89, 0.45 + (0.44 * matchedWeight / totalWeight));
}

function keywordWeight(keyword: string): number {
  if (keyword.includes(' ')) return 2.5;
  if (/^[A-Z]{3,}$/.test(keyword) || /[A-Z]/.test(keyword.slice(1))) return 2;
  if (keyword.length >= 8) return 1.5;
  return 1;
}
