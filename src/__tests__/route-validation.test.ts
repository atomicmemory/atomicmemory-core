/**
 * Route-level validation tests for memory API endpoints.
 * Tests UUID validation on param/query inputs and filter behavior
 * on the list endpoint. Requires DATABASE_URL in .env.test.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Mock embedText to avoid hitting the real embedding provider in CI where
// OPENAI_API_KEY is a placeholder. Returns a deterministic zero vector
// matching the configured embedding dimensions.
vi.mock('../services/embedding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/embedding.js')>();
  return {
    ...actual,
    embedText: vi.fn(async () => {
      const { config: cfg } = await import('../config.js');
      return new Array(cfg.embeddingDimensions).fill(0);
    }),
  };
});

import { pool } from '../db/pool.js';
import { MemoryRepository } from '../db/memory-repository.js';
import { ClaimRepository } from '../db/claim-repository.js';
import { MemoryService } from '../services/memory-service.js';
import { createMemoryRouter } from '../routes/memories.js';
import { setupTestSchema } from '../db/__tests__/test-fixtures.js';
import { RESERVED_METADATA_KEYS } from '../db/repository-types.js';
import express from 'express';

const TEST_USER = 'route-validation-test-user';
const VALID_UUID = '00000000-0000-0000-0000-000000000001';
const INVALID_UUID = 'not-a-uuid';

let server: ReturnType<typeof app.listen>;
let baseUrl: string;
const app = express();
app.use(express.json());

beforeAll(async () => {
  await setupTestSchema(pool);

  const repo = new MemoryRepository(pool);
  const claimRepo = new ClaimRepository(pool);
  const service = new MemoryService(repo, claimRepo);
  app.use('/memories', createMemoryRouter(service));

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('GET /memories/:id — UUID validation', () => {
  it('returns 400 for an invalid UUID', async () => {
    const res = await fetch(`${baseUrl}/memories/${INVALID_UUID}?user_id=${TEST_USER}`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/valid UUID/);
  });

  it('returns 404 for a valid but non-existent UUID', async () => {
    const res = await fetch(`${baseUrl}/memories/${VALID_UUID}?user_id=${TEST_USER}`);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /memories/:id — UUID validation', () => {
  it('returns 400 for an invalid UUID', async () => {
    const res = await fetch(`${baseUrl}/memories/${INVALID_UUID}?user_id=${TEST_USER}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/valid UUID/);
  });
});

describe('POST /memories/ingest/quick — skip_extraction (storeVerbatim)', () => {
  it('stores a single memory without extraction when skip_extraction is true', async () => {
    const res = await fetch(`${baseUrl}/memories/ingest/quick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: TEST_USER,
        conversation: 'Verbatim content that should not be extracted into facts.',
        source_site: 'verbatim-test',
        source_url: 'https://example.com/verbatim',
        skip_extraction: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.memories_stored).toBe(1);
    expect(body.stored_memory_ids).toHaveLength(1);
    expect(body.updated_memory_ids).toHaveLength(0);
  });
});

describe('GET /memories/list — source_site filter', () => {
  it('returns memories filtered by source_site', async () => {
    const res = await fetch(
      `${baseUrl}/memories/list?user_id=${TEST_USER}&source_site=test-site`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('memories');
    expect(body).toHaveProperty('count');
  });
});

describe('POST /memories/search — scope and observability contract', () => {
  it('returns canonical user scope and only includes observability sections that the retrieval path actually emitted', async () => {
    const res = await fetch(`${baseUrl}/memories/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: TEST_USER,
        query: 'verbatim',
        source_site: 'verbatim-test',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toEqual({ kind: 'user', user_id: TEST_USER });
    expect(body.observability?.retrieval).toBeUndefined();
    expect(body.observability?.packaging?.package_type).toBe('subject-pack');
    expect(body.observability?.assembly?.blocks).toEqual(['subject']);
  });

  it('returns canonical workspace scope for workspace searches', async () => {
    const workspaceId = '00000000-0000-0000-0000-000000000111';
    const agentId = '00000000-0000-0000-0000-000000000222';
    const res = await fetch(`${baseUrl}/memories/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: TEST_USER,
        query: 'verbatim',
        workspace_id: workspaceId,
        agent_id: agentId,
        source_site: 'verbatim-test',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toEqual({
      kind: 'workspace',
      user_id: TEST_USER,
      workspace_id: workspaceId,
      agent_id: agentId,
    });
  });
});

describe('GET /memories/list — episode_id filter', () => {
  it('returns 400 for an invalid episode_id', async () => {
    const res = await fetch(
      `${baseUrl}/memories/list?user_id=${TEST_USER}&episode_id=${INVALID_UUID}`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/valid UUID/);
  });

  it('accepts a valid episode_id UUID', async () => {
    const res = await fetch(
      `${baseUrl}/memories/list?user_id=${TEST_USER}&episode_id=${VALID_UUID}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('memories');
  });
});

describe('agent_id validation on workspace query routes', () => {
  it('returns 400 for an invalid agent_id on GET /list', async () => {
    const res = await fetch(
      `${baseUrl}/memories/list?user_id=${TEST_USER}&workspace_id=${VALID_UUID}&agent_id=${INVALID_UUID}`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/valid UUID/);
  });

  it('returns 400 for an invalid agent_id on GET /:id', async () => {
    const res = await fetch(
      `${baseUrl}/memories/${VALID_UUID}?user_id=${TEST_USER}&workspace_id=${VALID_UUID}&agent_id=${INVALID_UUID}`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/valid UUID/);
  });

  it('returns 400 for an invalid agent_id on DELETE /:id', async () => {
    const res = await fetch(
      `${baseUrl}/memories/${VALID_UUID}?user_id=${TEST_USER}&workspace_id=${VALID_UUID}&agent_id=${INVALID_UUID}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/valid UUID/);
  });

  it('returns 404 (not 500) for workspace DELETE when memory is not visible', async () => {
    const nonExistentMemory = '00000000-0000-0000-0000-000000000999';
    const res = await fetch(
      `${baseUrl}/memories/${nonExistentMemory}?user_id=${TEST_USER}&workspace_id=${VALID_UUID}&agent_id=${VALID_UUID}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(404);
  });
});

describe('workspace queries require agent_id', () => {
  it('returns 400 on GET /list when workspace_id is present without agent_id', async () => {
    const res = await fetch(
      `${baseUrl}/memories/list?user_id=${TEST_USER}&workspace_id=${VALID_UUID}`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/agent_id is required/);
  });

  it('returns 400 on GET /:id when workspace_id is present without agent_id', async () => {
    const res = await fetch(
      `${baseUrl}/memories/${VALID_UUID}?user_id=${TEST_USER}&workspace_id=${VALID_UUID}`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/agent_id is required/);
  });

  it('returns 400 on DELETE /:id when workspace_id is present without agent_id', async () => {
    const res = await fetch(
      `${baseUrl}/memories/${VALID_UUID}?user_id=${TEST_USER}&workspace_id=${VALID_UUID}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/agent_id is required/);
  });
});

// ---------------------------------------------------------------------------
// Caller-supplied `metadata` on /v1/memories/ingest*
// ---------------------------------------------------------------------------

describe('POST /memories/ingest/quick — caller metadata (verbatim)', () => {
  // Use a UUID user_id so the read-back query (which parameter-binds
  // user_id as UUID) succeeds. The plain string TEST_USER is fine for
  // the write path's loose typing but not for the read.
  const METADATA_TEST_USER = '00000000-0000-0000-0000-000000000abc';

  it('accepts metadata when skip_extraction=true and round-trips it through storage', async () => {
    const sourceSite = 'metadata-roundtrip-test';
    const metadata = { foo: 'bar', n: 1, nested: { ok: true, list: [1, 2, 3] } };
    const res = await fetch(`${baseUrl}/memories/ingest/quick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: METADATA_TEST_USER,
        conversation: 'Verbatim content with metadata.',
        source_site: sourceSite,
        skip_extraction: true,
        metadata,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stored_memory_ids).toHaveLength(1);

    // Read-path #1: direct repository read. Asserts the JSONB column
    // round-tripped through Postgres.
    const repoRead = new MemoryRepository(pool);
    const stored = await repoRead.getMemory(body.stored_memory_ids[0], METADATA_TEST_USER);
    expect(stored).not.toBeNull();
    expect(stored?.metadata).toEqual(metadata);

    // Read-path #2: GET /memories/list — the public read API.
    // Catches a regression where the response-projection layer
    // (`normalizeMemoryRow` or the route handler's response shaping)
    // drops `metadata` while the storage column still holds it.
    // Without this, a future change to the read-side projection
    // could silently break the user-facing contract while the
    // repo-direct assertion above stays green.
    const listRes = await fetch(
      `${baseUrl}/memories/list?user_id=${METADATA_TEST_USER}&source_site=${sourceSite}`,
    );
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as { memories: Array<{ id: string; metadata: unknown }> };
    const listed = listBody.memories.find(m => m.id === body.stored_memory_ids[0]);
    expect(listed, 'listed memory should be present in /list response').toBeDefined();
    expect(listed?.metadata).toEqual(metadata);

    // Read-path #3: POST /memories/search — caller-supplied metadata
    // must survive into search results. The search-route projection
    // in `formatSearchResponse` historically dropped `metadata` (only
    // exposed id/content/similarity/score/importance/source_site/
    // created_at). This test pairs with the projection fix that adds
    // `metadata` to the per-memory map in the response, and is the
    // sentinel that prevents a future projection refactor from
    // re-dropping the field. Search uses the source_site filter to
    // locate the just-ingested memory deterministically — vector
    // similarity is not relied on (the test harness mocks
    // `embedText` to return zero vectors).
    const searchRes = await fetch(`${baseUrl}/memories/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: METADATA_TEST_USER,
        query: 'verbatim metadata',
        source_site: sourceSite,
      }),
    });
    expect(searchRes.status).toBe(200);
    const searchBody = await searchRes.json() as {
      memories: Array<{ id: string; metadata?: unknown }>;
    };
    const searched = searchBody.memories.find(m => m.id === body.stored_memory_ids[0]);
    expect(searched, 'just-ingested memory should appear in /search results filtered by source_site').toBeDefined();
    expect(searched?.metadata).toEqual(metadata);
  });
});

/**
 * Shared helper: POST a body to an ingest route, assert 400, and
 * return the parsed error envelope. Extracted from the metadata
 * rejection tests below to avoid duplicated POST/JSON/status-check
 * blocks across cases.
 */
async function postIngestExpecting400(
  routePath: '/memories/ingest' | '/memories/ingest/quick',
  body: Record<string, unknown>,
): Promise<{ error: string }> {
  const res = await fetch(`${baseUrl}${routePath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(400);
  return (await res.json()) as { error: string };
}

describe('POST /memories/ingest* — metadata rejection (non-verbatim branches)', () => {
  it('rejects metadata on /v1/memories/ingest (full-extraction) with 400', async () => {
    const { error } = await postIngestExpecting400('/memories/ingest', {
      user_id: TEST_USER,
      conversation: 'Full-extraction body with metadata should reject.',
      source_site: 'metadata-reject-full',
      metadata: { foo: 'bar' },
    });
    expect(error).toMatch(/skip_extraction/);
    expect(error).toMatch(/\/v1\/memories\/ingest\/quick/);
  });

  it('rejects metadata on /v1/memories/ingest/quick when skip_extraction is absent (quickIngest branch) with 400', async () => {
    const { error } = await postIngestExpecting400('/memories/ingest/quick', {
      user_id: TEST_USER,
      conversation: 'Quick ingest without skip_extraction should reject metadata.',
      source_site: 'metadata-reject-quick',
      metadata: { foo: 'bar' },
    });
    expect(error).toMatch(/skip_extraction/);
  });

  it('rejects metadata when a workspace context is present, even with skip_extraction=true', async () => {
    const { error } = await postIngestExpecting400('/memories/ingest/quick', {
      user_id: TEST_USER,
      conversation: 'Workspace verbatim with metadata should reject.',
      source_site: 'metadata-reject-workspace',
      skip_extraction: true,
      workspace_id: '00000000-0000-0000-0000-000000000111',
      agent_id: '00000000-0000-0000-0000-000000000222',
      metadata: { foo: 'bar' },
    });
    expect(error).toMatch(/workspace/i);
  });
});

describe('POST /memories/ingest/quick — metadata size cap', () => {
  it('rejects metadata whose UTF-8 serialized length exceeds 32 KB with 400', async () => {
    // Use non-ASCII characters so the test exercises actual UTF-8 byte
    // measurement (codex round-1: a UTF-16 code-unit measurement would
    // mis-count multi-byte chars and silently allow >32 KB on disk).
    // '日本語' encodes to 9 bytes in UTF-8 vs 3 UTF-16 code units.
    const chunk = '日本語'.repeat(2000); // ~18 KB of non-ASCII
    const oversized = { a: chunk, b: chunk };
    const { error } = await postIngestExpecting400('/memories/ingest/quick', {
      user_id: TEST_USER,
      conversation: 'Oversized metadata.',
      source_site: 'metadata-reject-size',
      skip_extraction: true,
      metadata: oversized,
    });
    expect(error).toMatch(/metadata exceeds max serialized size/);
    expect(error).toMatch(/bytes \(utf-8\)/);
  });
});

describe('POST /memories/ingest/quick — reserved metadata keys', () => {
  // Parameterized over RESERVED_METADATA_KEYS so adding a new reserved
  // key automatically extends test coverage. Pairs with the static-
  // analysis drift guard in `reserved-metadata-keys.test.ts` which
  // prevents the set from going out of sync with `metadata.X` accesses
  // under `src/`.
  for (const key of RESERVED_METADATA_KEYS) {
    it(`rejects metadata containing reserved key '${key}' with 400`, async () => {
      const { error } = await postIngestExpecting400('/memories/ingest/quick', {
        user_id: TEST_USER,
        conversation: `Reserved-key spoof: ${key}.`,
        source_site: 'metadata-reject-reserved',
        skip_extraction: true,
        metadata: { [key]: 'spoofed' },
      });
      expect(error).toMatch(/reserved key/);
      expect(error).toContain(key);
    });
  }
});
