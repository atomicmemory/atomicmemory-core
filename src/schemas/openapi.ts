/**
 * @file OpenAPI 3.1 registry — single source of truth for the spec.
 *
 * Wires every /v1/memories/* and /v1/agents/* route into an
 * OpenAPIRegistry. `scripts/generate-openapi.ts` walks this registry
 * to emit `openapi.yaml` + `openapi.json` at repo root.
 *
 * Each route entry records:
 *   - method + path (the public wire contract with the `/v1` prefix)
 *   - operationId (stable identifier clients can reference)
 *   - tag (groups routes under logical sections in the rendered docs)
 *   - request body and/or query / path params (Zod schemas from
 *     `./memories.ts` + `./agents.ts`)
 *   - per-route response inventory — includes every status code the
 *     real handler can emit, not a generic 200+400+500 default. The
 *     special 410 + rich-400 envelopes on PUT /config and 404 on
 *     GET/DELETE /:id are spelled out.
 */

import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from './zod-setup';
import {
  ErrorBasicSchema,
  ErrorConfig400Schema,
  ErrorConfig410Schema,
} from './errors';
import {
  IngestBodySchema,
  SearchBodySchema,
  ExpandBodySchema,
  ConsolidateBodySchema,
  DecayBodySchema,
  ReconcileBodySchema,
  ResetSourceBodySchema,
  LessonReportBodySchema,
  ConfigBodySchema,
  UserIdQuerySchema,
  UserIdLimitQuerySchema,
  ListQuerySchema,
  MemoryByIdQuerySchema,
  UuidIdParamSchema,
  FreeIdParamSchema,
} from './memories';
import {
  SetTrustBodySchema,
  GetTrustQuerySchema,
  UserIdFromQuerySchema,
  UserIdFromBodySchema,
  ConflictIdParamSchema,
  ResolveConflictBodySchema,
} from './agents';
import * as R from './responses';

export const API_TITLE = 'AtomicMemory HTTP API';
export const API_VERSION = '1.0.0';
export const API_DESCRIPTION =
  'Semantic memory engine for AI applications. Request/response bodies are JSON; fields on the wire use snake_case.';

const TAG_MEMORIES = 'Memories';
const TAG_LIFECYCLE = 'Lifecycle';
const TAG_AUDIT = 'Audit';
const TAG_LESSONS = 'Lessons';
const TAG_CONFIG = 'Configuration';
const TAG_AGENTS = 'Agents';

/** Build and populate the OpenAPI registry. */
export function buildRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();

  registry.register('ErrorBasic', ErrorBasicSchema);
  registry.register('ErrorConfig400', ErrorConfig400Schema);
  registry.register('ErrorConfig410', ErrorConfig410Schema);

  registerMemoryCoreRoutes(registry);
  registerMemoryLifecycleRoutes(registry);
  registerMemoryAuditRoutes(registry);
  registerMemoryLessonRoutes(registry);
  registerMemoryConfigRoutes(registry);
  registerAgentRoutes(registry);

  return registry;
}

// ---------------------------------------------------------------------------
// Shared response-object builders
// ---------------------------------------------------------------------------

const RESPONSE_400 = {
  description: 'Input validation error',
  content: { 'application/json': { schema: ErrorBasicSchema } },
};
const RESPONSE_500 = {
  description: 'Internal server error',
  content: { 'application/json': { schema: ErrorBasicSchema } },
};
const RESPONSE_404 = {
  description: 'Memory not found',
  content: { 'application/json': { schema: ErrorBasicSchema } },
};

/** Catch-all schema used for responses whose internal shape is large + still evolving. */
const GenericObjectResponse = z.object({}).passthrough();

function ok(description: string, schema: z.ZodTypeAny = GenericObjectResponse) {
  return { description, content: { 'application/json': { schema } } };
}

// ---------------------------------------------------------------------------
// /v1/memories — core routes (ingest, search, expand, list, get, delete)
// ---------------------------------------------------------------------------

function registerMemoryCoreRoutes(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'post',
    path: '/v1/memories/ingest',
    operationId: 'ingestMemory',
    tags: [TAG_MEMORIES],
    summary: 'Ingest a conversation transcript with full extraction.',
    description:
      'Full-extraction ingest. The `metadata` field on the body schema is ' +
      '**rejected with 400** on this route — caller metadata is only supported ' +
      'on `POST /v1/memories/ingest/quick` with `skip_extraction=true` and no ' +
      'workspace context.',
    request: { body: { content: { 'application/json': { schema: IngestBodySchema } }, required: true } },
    responses: {
      200: ok('Ingest result with extracted facts.', R.IngestResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/memories/ingest/quick',
    operationId: 'ingestMemoryQuick',
    tags: [TAG_MEMORIES],
    summary: 'Quick ingest (storeVerbatim when skip_extraction=true).',
    description:
      'Quick or verbatim ingest. The `metadata` field is **honored only** when ' +
      '`skip_extraction=true` and no workspace context (`workspace_id` / ' +
      '`agent_id` / `visibility`) is provided; otherwise rejected with 400.',
    request: { body: { content: { 'application/json': { schema: IngestBodySchema } }, required: true } },
    responses: {
      200: ok('Ingest result.', R.IngestResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/memories/search',
    operationId: 'searchMemories',
    tags: [TAG_MEMORIES],
    summary: 'Full semantic search with optional temporal / retrieval-mode / token-budget controls.',
    request: { body: { content: { 'application/json': { schema: SearchBodySchema } }, required: true } },
    responses: {
      200: ok('Search results with injection_text and citations.', R.SearchResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/memories/search/fast',
    operationId: 'searchMemoriesFast',
    tags: [TAG_MEMORIES],
    summary: 'Latency-optimized search (skips LLM repair loop). ~88% lower latency than /search.',
    request: { body: { content: { 'application/json': { schema: SearchBodySchema } }, required: true } },
    responses: {
      200: ok('Search results.', R.SearchResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/memories/expand',
    operationId: 'expandMemories',
    tags: [TAG_MEMORIES],
    summary: 'Expand a list of memory IDs into full objects.',
    request: { body: { content: { 'application/json': { schema: ExpandBodySchema } }, required: true } },
    responses: {
      200: ok('Expanded memories array.', R.ExpandResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/memories/list',
    operationId: 'listMemories',
    tags: [TAG_MEMORIES],
    summary: 'List memories for a user (or workspace).',
    request: { query: ListQuerySchema },
    responses: {
      200: ok('Paginated memory list.', R.ListResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/memories/{id}',
    operationId: 'getMemory',
    tags: [TAG_MEMORIES],
    summary: 'Fetch a single memory by UUID.',
    request: { params: UuidIdParamSchema, query: MemoryByIdQuerySchema },
    responses: {
      200: ok('Memory object.', R.GetMemoryResponseSchema),
      400: RESPONSE_400,
      404: RESPONSE_404,
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/memories/{id}',
    operationId: 'deleteMemory',
    tags: [TAG_MEMORIES],
    summary: 'Delete a single memory by UUID.',
    request: { params: UuidIdParamSchema, query: MemoryByIdQuerySchema },
    responses: {
      200: ok('Deletion success.', R.SuccessResponseSchema),
      400: RESPONSE_400,
      404: RESPONSE_404,
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/memories/stats',
    operationId: 'getStats',
    tags: [TAG_MEMORIES],
    summary: 'Aggregate memory statistics for a user.',
    request: { query: UserIdQuerySchema },
    responses: {
      200: ok('Stats payload.', R.StatsResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });
}

// ---------------------------------------------------------------------------
// /v1/memories — lifecycle admin ops
// ---------------------------------------------------------------------------

function registerMemoryLifecycleRoutes(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'post',
    path: '/v1/memories/consolidate',
    operationId: 'consolidateMemories',
    tags: [TAG_LIFECYCLE],
    summary: 'Compute consolidation candidates; optionally execute (execute=true).',
    request: { body: { content: { 'application/json': { schema: ConsolidateBodySchema } }, required: true } },
    responses: {
      200: ok('Consolidation result.', R.ConsolidateResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/memories/decay',
    operationId: 'evaluateDecay',
    tags: [TAG_LIFECYCLE],
    summary: 'Evaluate decay candidates. dry_run=false archives them.',
    request: { body: { content: { 'application/json': { schema: DecayBodySchema } }, required: true } },
    responses: {
      200: ok('Decay evaluation + archived count.', R.DecayResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/memories/cap',
    operationId: 'checkMemoryCap',
    tags: [TAG_LIFECYCLE],
    summary: "Memory-cap status for a user's store.",
    request: { query: UserIdQuerySchema },
    responses: {
      200: ok('Cap status.', R.CapResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/memories/reconcile',
    operationId: 'reconcileDeferred',
    tags: [TAG_LIFECYCLE],
    summary: 'Reconcile deferred mutations for a user (or all users when user_id is absent).',
    request: { body: { content: { 'application/json': { schema: ReconcileBodySchema } }, required: false } },
    responses: {
      200: ok('Reconciliation result.', R.ReconciliationResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/memories/reconcile/status',
    operationId: 'getReconcileStatus',
    tags: [TAG_LIFECYCLE],
    summary: 'Get deferred-mutation reconciliation status.',
    request: { query: UserIdQuerySchema },
    responses: {
      200: ok('Status payload.', R.ReconcileStatusResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/memories/reset-source',
    operationId: 'resetBySource',
    tags: [TAG_LIFECYCLE],
    summary: 'Delete all memories for a given user + source_site.',
    request: { body: { content: { 'application/json': { schema: ResetSourceBodySchema } }, required: true } },
    responses: {
      200: ok('Reset result.', R.ResetSourceResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });
}

// ---------------------------------------------------------------------------
// /v1/memories — audit
// ---------------------------------------------------------------------------

function registerMemoryAuditRoutes(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/v1/memories/audit/summary',
    operationId: 'getAuditSummary',
    tags: [TAG_AUDIT],
    summary: "Aggregate mutation statistics for a user's memory store.",
    request: { query: UserIdQuerySchema },
    responses: {
      200: ok('Mutation summary.', R.MutationSummaryResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/memories/audit/recent',
    operationId: 'getRecentAudit',
    tags: [TAG_AUDIT],
    summary: 'Recent mutations for a user, limit-bounded.',
    request: { query: UserIdLimitQuerySchema },
    responses: {
      200: ok('Recent mutations.', R.AuditRecentResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/memories/{id}/audit',
    operationId: 'getMemoryAuditTrail',
    tags: [TAG_AUDIT],
    summary: 'Per-memory version history.',
    request: { params: UuidIdParamSchema, query: UserIdQuerySchema },
    responses: {
      200: ok('Audit trail.', R.AuditTrailResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });
}

// ---------------------------------------------------------------------------
// /v1/memories — lessons
// ---------------------------------------------------------------------------

function registerMemoryLessonRoutes(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/v1/memories/lessons',
    operationId: 'listLessons',
    tags: [TAG_LESSONS],
    summary: 'List active lessons for a user.',
    request: { query: UserIdQuerySchema },
    responses: {
      200: ok('Lessons list.', R.LessonsListResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/memories/lessons/stats',
    operationId: 'getLessonStats',
    tags: [TAG_LESSONS],
    summary: 'Lesson statistics for a user.',
    request: { query: UserIdQuerySchema },
    responses: {
      200: ok('Stats.', R.LessonStatsResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/memories/lessons/report',
    operationId: 'reportLesson',
    tags: [TAG_LESSONS],
    summary: 'Report a new lesson.',
    request: { body: { content: { 'application/json': { schema: LessonReportBodySchema } }, required: true } },
    responses: {
      200: ok('Lesson id.', R.LessonReportResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/memories/lessons/{id}',
    operationId: 'deactivateLesson',
    tags: [TAG_LESSONS],
    summary: 'Deactivate a lesson by id.',
    request: { params: FreeIdParamSchema, query: UserIdQuerySchema },
    responses: {
      200: ok('Success.', R.SuccessResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });
}

// ---------------------------------------------------------------------------
// /v1/memories — config + health
// ---------------------------------------------------------------------------

function registerMemoryConfigRoutes(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/v1/memories/health',
    operationId: 'getMemoryHealth',
    tags: [TAG_CONFIG],
    summary: 'Subsystem liveness + current runtime config snapshot.',
    responses: {
      200: ok('Status + config snapshot.', R.HealthResponseSchema),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/memories/config',
    operationId: 'updateConfig',
    tags: [TAG_CONFIG],
    summary: 'Mutate runtime config (dev/test only). 410 when disabled.',
    description:
      'Set CORE_RUNTIME_CONFIG_MUTATION_ENABLED=true to enable. Startup-only fields (embedding_provider/model, llm_provider/model) return 400 with a `rejected` array listing the offending fields.',
    request: { body: { content: { 'application/json': { schema: ConfigBodySchema } }, required: true } },
    responses: {
      200: ok('Applied changes + config snapshot.', R.ConfigUpdateResponseSchema),
      400: {
        // Two shapes are possible:
        //   1. Basic `{ error }` when the validateBody middleware
        //      catches a schema violation on the request body.
        //   2. Richer `{ error, detail, rejected }` when the handler
        //      detects startup-only fields (embedding_provider etc.).
        description: 'Input validation error OR startup-only fields were supplied.',
        content: {
          'application/json': {
            schema: {
              oneOf: [
                { $ref: '#/components/schemas/ErrorBasic' },
                { $ref: '#/components/schemas/ErrorConfig400' },
              ],
            },
          },
        },
      },
      410: {
        description: 'Runtime config mutation is disabled in production.',
        content: { 'application/json': { schema: ErrorConfig410Schema } },
      },
      500: RESPONSE_500,
    },
  });
}

// ---------------------------------------------------------------------------
// /v1/agents
// ---------------------------------------------------------------------------

function registerAgentRoutes(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'put',
    path: '/v1/agents/trust',
    operationId: 'setAgentTrust',
    tags: [TAG_AGENTS],
    summary: "Set the calling user's trust level for a given agent.",
    request: { body: { content: { 'application/json': { schema: SetTrustBodySchema } }, required: true } },
    responses: {
      200: ok('Agent id + applied trust level.', R.TrustResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/agents/trust',
    operationId: 'getAgentTrust',
    tags: [TAG_AGENTS],
    summary: 'Look up the trust level for a (user, agent) pair.',
    request: { query: GetTrustQuerySchema },
    responses: {
      200: ok('Agent id + trust level.', R.TrustResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/agents/conflicts',
    operationId: 'listAgentConflicts',
    tags: [TAG_AGENTS],
    summary: 'List open agent conflicts for a user.',
    request: { query: UserIdFromQuerySchema },
    responses: {
      200: ok('Conflicts list.', R.ConflictsListResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/agents/conflicts/{id}/resolve',
    operationId: 'resolveAgentConflict',
    tags: [TAG_AGENTS],
    summary: 'Resolve a specific conflict with one of the three enum variants.',
    request: {
      params: ConflictIdParamSchema,
      body: { content: { 'application/json': { schema: ResolveConflictBodySchema } }, required: true },
    },
    responses: {
      200: ok('Resolution confirmation.', R.ResolveConflictResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/agents/conflicts/auto-resolve',
    operationId: 'autoResolveAgentConflicts',
    tags: [TAG_AGENTS],
    summary: 'Auto-resolve all expired conflicts for a user.',
    request: { body: { content: { 'application/json': { schema: UserIdFromBodySchema } }, required: true } },
    responses: {
      200: ok('Count of resolved conflicts.', R.AutoResolveConflictsResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
    },
  });
}
