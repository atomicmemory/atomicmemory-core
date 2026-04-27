/**
 * Shared test fixture factories for database-layer tests.
 *
 * Re-exports shared fixtures from the central test-fixtures module
 * and adds database-specific helpers (schema setup, vector generation).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { config } from '../../config.js';

import { MemoryRepository } from '../memory-repository.js';
import { ClaimRepository } from '../claim-repository.js';
import { MemoryService } from '../../services/memory-service.js';

export { createSearchResult, createMemoryRow } from '../../services/__tests__/test-fixtures.js';

/** Lifecycle hooks accepted by test context factories. */
interface TestLifecycleHooks {
  beforeAll: (fn: () => Promise<void>) => void;
  beforeEach?: (fn: () => Promise<void>) => void;
  afterAll: (fn: () => Promise<void>) => void;
}

/** Register the shared schema-setup and pool-teardown hooks. */
function registerLifecycleHooks(pool: pg.Pool, hooks: TestLifecycleHooks, cleanupFn?: () => Promise<void>) {
  hooks.beforeAll(async () => { await setupTestSchema(pool); });
  if (cleanupFn) hooks.beforeEach?.(cleanupFn);
  hooks.afterAll(async () => { await pool.end(); });
}

/**
 * Create standard integration test repos and lifecycle hooks.
 * Call within a describe() block; returns repo and claimRepo for use in tests.
 */
export function createIntegrationTestContext(pool: pg.Pool, hooks: Required<TestLifecycleHooks>) {
  const repo = new MemoryRepository(pool);
  const claimRepo = new ClaimRepository(pool);
  registerLifecycleHooks(pool, hooks, async () => { await claimRepo.deleteAll(); await repo.deleteAll(); });
  return { repo, claimRepo };
}

/**
 * Create a memory-only integration test context with lifecycle hooks.
 * Simpler variant of createIntegrationTestContext for tests that
 * do not need a ClaimRepository.
 */
export function createMemoryTestContext(pool: pg.Pool, hooks: Required<TestLifecycleHooks>) {
  const repo = new MemoryRepository(pool);
  registerLifecycleHooks(pool, hooks, async () => { await repo.deleteAll(); });
  return { repo };
}

/**
 * Create integration test context that includes a MemoryService.
 * Used by integration tests that need the full ingest/search pipeline.
 */
export function createServiceTestContext(pool: pg.Pool, hooks: TestLifecycleHooks) {
  const repo = new MemoryRepository(pool);
  const claimRepo = new ClaimRepository(pool);
  const service = new MemoryService(repo, claimRepo);
  registerLifecycleHooks(pool, hooks, async () => { await claimRepo.deleteAll(); await repo.deleteAll(); });
  return { repo, claimRepo, service };
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Read and prepare schema SQL with configured dimensions. */
function getSchemaSQL(): string {
  const raw = readFileSync(resolve(__dirname, '../schema.sql'), 'utf-8');
  return raw.replace(/\{\{EMBEDDING_DIMENSIONS\}\}/g, String(config.embeddingDimensions));
}

/**
 * Return the memories.embedding vector(N) dimension in pgvector's
 * atttypmod encoding, or null if the table does not exist or the
 * column has no typmod set. Used to detect dim drift before re-running
 * the idempotent base schema.
 */
async function readEmbeddingColumnDim(pool: pg.Pool): Promise<number | null> {
  const { rows } = await pool.query<{ typmod: number }>(
    `SELECT atttypmod AS typmod
     FROM pg_attribute a
     JOIN pg_class c ON a.attrelid = c.oid
     WHERE c.relname = 'memories' AND a.attname = 'embedding'`,
  );
  if (rows.length === 0) return null;
  return rows[0].typmod > 0 ? rows[0].typmod : null;
}

/**
 * Apply schema to a test database pool.
 *
 * The base schema.sql is idempotent (CREATE TABLE IF NOT EXISTS), so
 * re-running it cannot change the type of a column that already
 * exists. When the test DB was previously initialized with a different
 * EMBEDDING_DIMENSIONS (for example, left over from a prior run with
 * a different .env.test), the memories.embedding column retains the
 * old vector(N) dim and subsequent inserts with the new dim fail at
 * the DB level — surfacing as opaque 500s in route tests. Detect that
 * drift up front and drop+recreate the public schema so schema.sql
 * can rebuild it at the configured dim.
 */
export async function setupTestSchema(pool: pg.Pool): Promise<void> {
  const existingDim = await readEmbeddingColumnDim(pool);
  if (existingDim !== null && existingDim !== config.embeddingDimensions) {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  }
  const sql = getSchemaSQL();
  await pool.query(sql);
}

/** Generate a deterministic unit vector from a seed. */
export function unitVector(seed: number): number[] {
  const values = Array.from(
    { length: config.embeddingDimensions },
    (_, index) => Math.sin(seed * (index + 1)),
  );
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / norm);
}

/** Offset a base vector deterministically for near-duplicate testing. */
export function offsetVector(base: number[], seed: number, scale: number): number[] {
  const values = base.map((value, index) => value + Math.cos(seed * (index + 1)) * scale);
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / norm);
}
