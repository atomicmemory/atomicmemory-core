/**
 * Run schema migration against the configured database.
 * Replaces {{EMBEDDING_DIMENSIONS}} in schema.sql with the configured value.
 * Usage: pnpm migrate (uses .env) or pnpm migrate:test (uses .env.test)
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';
import { config } from '../config.js';
import { resolveEmbeddingDimensions } from '../services/embedding.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function stripVectorIndexes(sql: string): string {
  if (!config.skipVectorIndexes) return sql;
  // Matches both CREATE INDEX and CREATE INDEX IF NOT EXISTS forms — schema.sql
  // uses the idempotent form so it can re-run on every startup without data loss.
  return sql.replace(
    /CREATE INDEX (IF NOT EXISTS )?idx_[a-z_]+_embedding ON [a-z_]+\n  USING hnsw \(embedding vector_cosine_ops\)\n  WITH \(m = 16, ef_construction = 200\);(\n\n|\n?$)/g,
    '',
  );
}

async function migrate(): Promise<void> {
  const envDims = process.env.EMBEDDING_DIMENSIONS ? parseInt(process.env.EMBEDDING_DIMENSIONS, 10) : null;
  const embeddingDimensions = envDims ?? await resolveEmbeddingDimensions();
  console.log(`[migrate] Resolved dimensions: ${embeddingDimensions} (from env: ${envDims})`);
  const schemaPath = resolve(__dirname, 'schema.sql');
  const rawSql = readFileSync(schemaPath, 'utf-8');
  const dimensionedSql = rawSql.replace(
    /\{\{EMBEDDING_DIMENSIONS\}\}/g,
    String(embeddingDimensions),
  );
  const sql = stripVectorIndexes(dimensionedSql);

  console.log(`Running migration (embedding dimensions: ${embeddingDimensions}, vector indexes: ${config.skipVectorIndexes ? 'off' : 'on'})...`);
  await pool.query(sql);
  console.log('Migration complete.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
