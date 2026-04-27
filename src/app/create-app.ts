/**
 * Express application factory — wires routers onto a runtime container.
 *
 * Separates composition (done in `runtime-container.ts`) from HTTP
 * transport concerns. Tests and harnesses can create an Express app from
 * any runtime container without touching the server bootstrap.
 */

import express from 'express';
import { createAgentRouter } from '../routes/agents.js';
import { createMemoryRouter } from '../routes/memories.js';
import type { CoreRuntime } from './runtime-container.js';

/**
 * Build an Express application from a composed runtime container. The
 * runtime owns all deps; this module only wires HTTP concerns (CORS, body
 * parsing, routes, health).
 */
export function createApp(runtime: CoreRuntime): ReturnType<typeof express> {
  const app = express();

  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  app.use(express.json({ limit: '1mb' }));

  app.use('/v1/memories', createMemoryRouter(runtime.services.memory, runtime.configRouteAdapter));
  app.use('/v1/agents', createAgentRouter(runtime.repos.trust));

  // `/health` is intentionally unversioned — it is an infrastructure
  // liveness probe (load balancers, Docker, Railway), not part of the
  // versioned application API. Versioned endpoints live under `/v1/*`.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}
