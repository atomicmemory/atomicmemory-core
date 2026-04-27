/**
 * Shared error handling utilities for Express route handlers.
 *
 * All request-input validation is now performed by the Zod-based
 * `validateBody` / `validateQuery` / `validateParams` middleware in
 * `src/middleware/validate.ts`, which emits 400 responses directly.
 * By the time control reaches `handleRouteError` the error is always
 * an uncaught service-layer failure and the right response is 500.
 */

import type { Response } from 'express';

/** Log the error and send a 500 JSON error response. */
export function handleRouteError(res: Response, context: string, err: unknown): void {
  const internalMessage = err instanceof Error ? err.message : String(err ?? 'Internal server error');
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(`${context} error: [500] ${internalMessage}${stack ? `\n${stack}` : ''}`);
  res.status(500).json({ error: 'Internal server error' });
}
