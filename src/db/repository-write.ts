/**
 * Write-side queries for episodes and active memory projections.
 */

import pg from 'pg';
import pgvector from 'pgvector/pg';
import {
  type CanonicalFactPayload,
  type CanonicalMemoryObjectFamily,
  type CanonicalMemoryObjectLineage,
  type CanonicalMemoryObjectProvenance,
  type MemoryMetadata,
  type StoreMemoryInput,
  clampImportance,
} from './repository-types.js';

export interface StoreEpisodeInput {
  userId: string;
  content: string;
  sourceSite: string;
  sourceUrl?: string;
  sessionId?: string;
  workspaceId?: string;
  agentId?: string;
}

export async function storeEpisode(
  pool: pg.Pool,
  input: StoreEpisodeInput,
): Promise<string> {
  return storeEpisodeWithClient(pool as any, input);
}

export async function storeEpisodeWithClient(
  client: pg.PoolClient,
  input: StoreEpisodeInput,
): Promise<string> {
  if (input.workspaceId || input.agentId) {
    const result = await client.query(
      `INSERT INTO episodes (user_id, content, source_site, source_url, session_id, workspace_id, agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [input.userId, input.content, input.sourceSite, input.sourceUrl ?? '', input.sessionId ?? null, input.workspaceId ?? null, input.agentId ?? null],
    );
    return result.rows[0].id;
  }
  const result = await client.query(
    `INSERT INTO episodes (user_id, content, source_site, source_url, session_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.userId, input.content, input.sourceSite, input.sourceUrl ?? '', input.sessionId ?? null],
  );
  return result.rows[0].id;
}

export type { StoreMemoryInput };

export interface StoreCanonicalMemoryObjectInput {
  userId: string;
  objectFamily: CanonicalMemoryObjectFamily;
  payloadFormat?: string;
  canonicalPayload: CanonicalFactPayload;
  provenance: CanonicalMemoryObjectProvenance;
  observedAt?: Date;
  lineage: CanonicalMemoryObjectLineage;
}

export async function storeCanonicalMemoryObject(
  pool: pg.Pool,
  input: StoreCanonicalMemoryObjectInput,
): Promise<string> {
  return storeCanonicalMemoryObjectWithClient(pool as any, input);
}

async function storeCanonicalMemoryObjectWithClient(
  client: pg.PoolClient,
  input: StoreCanonicalMemoryObjectInput,
): Promise<string> {
  const result = await client.query(
    `INSERT INTO canonical_memory_objects (
      user_id,
      object_family,
      payload_format,
      canonical_payload,
      provenance,
      observed_at,
      lineage
    )
    VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb)
    RETURNING id`,
    [
      input.userId,
      input.objectFamily,
      input.payloadFormat ?? 'json',
      JSON.stringify(input.canonicalPayload),
      JSON.stringify(input.provenance),
      (input.observedAt ?? new Date()).toISOString(),
      JSON.stringify(input.lineage),
    ],
  );
  return result.rows[0].id;
}

export async function storeMemory(pool: pg.Pool, input: StoreMemoryInput): Promise<string> {
  return storeMemoryWithClient(pool as any, input);
}

export async function storeMemoryWithClient(client: pg.PoolClient, input: StoreMemoryInput): Promise<string> {
  const { params, paramCount: baseParamCount } = buildBaseParams(input);
  const { extraColumns, extraPlaceholders, paramCount } = appendWorkspaceParams(input, params, baseParamCount);
  const sql = buildInsertSql(input.createdAt, extraColumns, extraPlaceholders, params, paramCount);
  const result = await client.query(sql, params);
  return result.rows[0].id;
}

const BASE_COLUMNS = 'user_id, content, embedding, memory_type, importance, source_site, source_url, episode_id, status, metadata, keywords, namespace, summary, overview, trust_score, network, opinion_confidence, observation_subject, observed_at';

/** Build the 19 base positional parameters for memory insertion. */
function buildBaseParams(input: StoreMemoryInput): { params: unknown[]; paramCount: number } {
  return {
    params: [
      input.userId,
      input.content,
      pgvector.toSql(input.embedding),
      input.memoryType ?? 'semantic',
      clampImportance(input.importance),
      input.sourceSite,
      input.sourceUrl ?? '',
      input.episodeId ?? null,
      input.status ?? 'active',
      JSON.stringify(input.metadata ?? {}),
      input.keywords ?? '',
      input.namespace ?? null,
      input.summary ?? '',
      input.overview ?? '',
      Math.max(0, Math.min(1, input.trustScore ?? 1.0)),
      input.network ?? 'experience',
      input.opinionConfidence ?? null,
      input.observationSubject ?? null,
      (input.observedAt ?? new Date()).toISOString(),
    ],
    paramCount: 19,
  };
}

/** Append optional workspace fields (workspace_id, agent_id, visibility) to params. */
function appendWorkspaceParams(
  input: StoreMemoryInput,
  params: unknown[],
  startParamCount: number,
): { extraColumns: string; extraPlaceholders: string; paramCount: number } {
  const hasWorkspaceFields = input.workspaceId || input.agentId || input.visibility;
  if (!hasWorkspaceFields) {
    return { extraColumns: '', extraPlaceholders: '', paramCount: startParamCount };
  }

  const wsFields: string[] = [];
  const wsPlaceholders: string[] = [];
  let paramCount = startParamCount;

  const optionalFields: Array<{ key: keyof StoreMemoryInput; column: string }> = [
    { key: 'workspaceId', column: 'workspace_id' },
    { key: 'agentId', column: 'agent_id' },
    { key: 'visibility', column: 'visibility' },
  ];
  for (const { key, column } of optionalFields) {
    if (input[key] !== undefined) {
      paramCount++;
      wsFields.push(column);
      wsPlaceholders.push(`$${paramCount}`);
      params.push(input[key]);
    }
  }

  return {
    extraColumns: ', ' + wsFields.join(', '),
    extraPlaceholders: ', ' + wsPlaceholders.join(', '),
    paramCount,
  };
}

/** Build the final INSERT SQL, optionally including created_at. */
function buildInsertSql(
  createdAt: Date | undefined,
  extraColumns: string,
  extraPlaceholders: string,
  params: unknown[],
  paramCount: number,
): string {
  const basePlaceholders = '$1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18, $19';
  if (createdAt) {
    const nextParam = paramCount + 1;
    params.push(createdAt.toISOString());
    return `INSERT INTO memories (${BASE_COLUMNS}${extraColumns}, created_at) VALUES (${basePlaceholders}${extraPlaceholders}, $${nextParam}) RETURNING id`;
  }
  return `INSERT INTO memories (${BASE_COLUMNS}${extraColumns}) VALUES (${basePlaceholders}${extraPlaceholders}) RETURNING id`;
}

export async function updateMemoryContent(
  pool: pg.Pool,
  userId: string,
  id: string,
  content: string,
  embedding: number[],
  importance: number,
  keywords?: string,
  trustScore?: number,
): Promise<void> {
  await updateMemoryContentWithClient(
    pool as any,
    userId,
    id,
    content,
    embedding,
    importance,
    keywords,
    trustScore,
  );
}

export async function updateMemoryContentWithClient(
  client: pg.PoolClient,
  userId: string,
  id: string,
  content: string,
  embedding: number[],
  importance: number,
  keywords?: string,
  trustScore?: number,
): Promise<void> {
  if (keywords !== undefined) {
    await client.query(
      `UPDATE memories
       SET content = $1, embedding = $2, importance = $3, keywords = $4, trust_score = $5, last_accessed_at = NOW()
       WHERE id = $6 AND user_id = $7 AND deleted_at IS NULL`,
      [
        content,
        pgvector.toSql(embedding),
        clampImportance(importance),
        keywords,
        Math.max(0, Math.min(1, trustScore ?? 1.0)),
        id,
        userId,
      ],
    );
  } else {
    await client.query(
      `UPDATE memories
       SET content = $1, embedding = $2, importance = $3, trust_score = $4, last_accessed_at = NOW()
       WHERE id = $5 AND user_id = $6 AND deleted_at IS NULL`,
      [
        content,
        pgvector.toSql(embedding),
        clampImportance(importance),
        Math.max(0, Math.min(1, trustScore ?? 1.0)),
        id,
        userId,
      ],
    );
  }
}

export async function updateMemoryMetadata(
  pool: pg.Pool,
  userId: string,
  id: string,
  metadata: MemoryMetadata,
): Promise<void> {
  await updateMemoryMetadataWithClient(pool as any, userId, id, metadata);
}

async function updateMemoryMetadataWithClient(
  client: pg.PoolClient,
  userId: string,
  id: string,
  metadata: MemoryMetadata,
): Promise<void> {
  await client.query(
    `UPDATE memories
     SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
     WHERE id = $2 AND user_id = $3`,
    [JSON.stringify(metadata), id, userId],
  );
}

export async function softDeleteMemory(pool: pg.Pool, userId: string, id: string): Promise<void> {
  await softDeleteMemoryWithClient(pool as any, userId, id);
}

export async function softDeleteMemoryWithClient(client: pg.PoolClient, userId: string, id: string): Promise<void> {
  await client.query(
    `UPDATE memories SET deleted_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
}

export async function softDeleteMemoryInWorkspace(
  pool: pg.Pool,
  id: string,
  workspaceId: string,
): Promise<void> {
  await pool.query(
    `UPDATE memories SET deleted_at = NOW()
     WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
    [id, workspaceId],
  );
}

/**
 * Mark a memory as temporally expired (contradicted/superseded).
 * Unlike soft-delete, expired memories are preserved for temporal queries:
 * "what did I know as of date X?" can still retrieve them.
 */
export async function expireMemory(pool: pg.Pool, userId: string, id: string): Promise<void> {
  await expireMemoryWithClient(pool as any, userId, id);
}

export async function expireMemoryWithClient(client: pg.PoolClient, userId: string, id: string): Promise<void> {
  await client.query(
    `UPDATE memories SET expired_at = NOW()
     WHERE id = $1 AND user_id = $2 AND expired_at IS NULL AND deleted_at IS NULL`,
    [id, userId],
  );
}

export async function touchMemory(pool: pg.Pool, id: string): Promise<void> {
  await pool.query(
    `UPDATE memories
     SET access_count = access_count + 1, last_accessed_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
}

export async function updateOpinionConfidence(
  pool: pg.Pool,
  userId: string,
  memoryId: string,
  newConfidence: number,
): Promise<void> {
  await pool.query(
    `UPDATE memories SET opinion_confidence = $1, last_accessed_at = NOW()
     WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL`,
    [Math.max(0, Math.min(1, newConfidence)), memoryId, userId],
  );
}

export async function backdateMemories(pool: pg.Pool, ids: string[], timestamp: Date): Promise<void> {
  await pool.query(
    `UPDATE memories SET created_at = $1, last_accessed_at = $1 WHERE id = ANY($2::uuid[])`,
    [timestamp.toISOString(), ids],
  );
}

/**
 * Delete all data for a given user + source_site combination.
 * Hard-deletes across all dependent tables in safe referential order
 * within a single transaction. Returns the count of memories removed.
 */
export async function deleteBySource(
  pool: pg.Pool,
  userId: string,
  sourceSite: string,
): Promise<{ deletedMemories: number; deletedEpisodes: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Evidence via claim versions scoped to this source
    await client.query(
      `DELETE FROM memory_evidence
       WHERE claim_version_id IN (
         SELECT id FROM memory_claim_versions WHERE user_id = $1 AND source_site = $2
       )`,
      [userId, sourceSite],
    );

    // 2. Claim versions for this source
    await client.query(
      `DELETE FROM memory_claim_versions WHERE user_id = $1 AND source_site = $2`,
      [userId, sourceSite],
    );

    // 3. Orphaned claims — claims with zero remaining versions
    await client.query(
      `DELETE FROM memory_claims
       WHERE user_id = $1
         AND id NOT IN (SELECT claim_id FROM memory_claim_versions WHERE user_id = $1)`,
      [userId],
    );

    // 4. Links where either end is a non-workspace memory from this source
    await client.query(
      `DELETE FROM memory_links
       WHERE source_id IN (SELECT id FROM memories WHERE user_id = $1 AND source_site = $2 AND workspace_id IS NULL)
          OR target_id IN (SELECT id FROM memories WHERE user_id = $1 AND source_site = $2 AND workspace_id IS NULL)`,
      [userId, sourceSite],
    );

    // 5. Entity junction rows for non-workspace memories
    await client.query(
      `DELETE FROM memory_entities
       WHERE memory_id IN (SELECT id FROM memories WHERE user_id = $1 AND source_site = $2 AND workspace_id IS NULL)`,
      [userId, sourceSite],
    );

    // 6. Atomic facts for non-workspace memories
    await client.query(
      `DELETE FROM memory_atomic_facts WHERE user_id = $1 AND source_site = $2
       AND parent_memory_id IN (SELECT id FROM memories WHERE user_id = $1 AND source_site = $2 AND workspace_id IS NULL)`,
      [userId, sourceSite],
    );

    // 7. Non-workspace memories only — workspace memories are protected
    const memResult = await client.query(
      `DELETE FROM memories WHERE user_id = $1 AND source_site = $2 AND workspace_id IS NULL RETURNING id`,
      [userId, sourceSite],
    );

    // 8. Episodes for this source
    const epResult = await client.query(
      `DELETE FROM episodes WHERE user_id = $1 AND source_site = $2 RETURNING id`,
      [userId, sourceSite],
    );

    await client.query('COMMIT');
    return {
      deletedMemories: memResult.rowCount ?? 0,
      deletedEpisodes: epResult.rowCount ?? 0,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteAll(pool: pg.Pool, userId?: string): Promise<void> {
  if (userId) {
    await pool.query('DELETE FROM memory_evidence WHERE claim_version_id IN (SELECT id FROM memory_claim_versions WHERE user_id = $1)', [userId]);
    await pool.query('DELETE FROM memory_claim_versions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM memory_claims WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM memory_links WHERE source_id IN (SELECT id FROM memories WHERE user_id = $1)', [userId]);
    await pool.query('DELETE FROM memories WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM episodes WHERE user_id = $1', [userId]);
    return;
  }
  await pool.query('DELETE FROM memory_evidence');
  await pool.query('DELETE FROM memory_claim_versions');
  await pool.query('DELETE FROM memory_claims');
  await pool.query('DELETE FROM memory_links');
  await pool.query('DELETE FROM memories');
  await pool.query('DELETE FROM episodes');
}
