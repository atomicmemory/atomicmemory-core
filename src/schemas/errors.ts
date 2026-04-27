/**
 * @file Zod schemas for HTTP error envelopes.
 *
 * The canonical envelope across the API is `{ error: string }`:
 *   - 400: emitted by the Zod `validateBody` / `validateQuery` /
 *     `validateParams` middleware in `src/middleware/validate.ts`
 *     when request input fails schema validation.
 *   - 500: emitted by `handleRouteError` in `src/routes/route-errors.ts`
 *     for uncaught service-layer exceptions.
 *
 * Two routes have richer envelopes:
 *   - `PUT /v1/memories/config` — 400 with `{ error, detail, rejected[] }`
 *     when startup-only fields are mutated at runtime.
 *   - `PUT /v1/memories/config` — 410 with `{ error, detail }` when
 *     runtime config mutation is disabled.
 *
 * These schemas are the source of truth for the OpenAPI spec's response
 * components.
 */

import { z } from './zod-setup';

/** Standard error envelope used by every route for 400 (validation) and 500 (uncaught). */
export const ErrorBasicSchema = z
  .object({
    error: z.string(),
  })
  .openapi({
    description: 'Standard error envelope. 400 for input validation errors, 500 for uncaught exceptions.',
    example: { error: 'user_id is required' },
  });

export type ErrorBasic = z.infer<typeof ErrorBasicSchema>;

/**
 * Richer 400 envelope returned by `PUT /v1/memories/config` when a
 * request body includes startup-only fields that cannot be mutated at
 * runtime (embedding/LLM provider + model).
 */
export const ErrorConfig400Schema = z
  .object({
    error: z.string(),
    detail: z.string(),
    rejected: z.array(z.string()),
  })
  .openapi({
    description: 'Richer 400 envelope for PUT /v1/memories/config when startup-only fields are included.',
    example: {
      error: 'Provider/model selection is startup-only',
      detail: 'Fields embedding_provider cannot be mutated at runtime — the embedding/LLM provider caches are fixed at first use.',
      rejected: ['embedding_provider'],
    },
  });

export type ErrorConfig400 = z.infer<typeof ErrorConfig400Schema>;

/**
 * 410 envelope returned by `PUT /v1/memories/config` when runtime
 * config mutation is disabled (production default).
 */
export const ErrorConfig410Schema = z
  .object({
    error: z.string(),
    detail: z.string(),
  })
  .openapi({
    description: '410 Gone envelope for PUT /v1/memories/config when runtime mutation is disabled.',
    example: {
      error: 'PUT /v1/memories/config is deprecated for production',
      detail: 'Set CORE_RUNTIME_CONFIG_MUTATION_ENABLED=true to enable runtime mutation in dev/test environments.',
    },
  });

export type ErrorConfig410 = z.infer<typeof ErrorConfig410Schema>;
