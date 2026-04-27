/**
 * AtomicMemory Core API Server — bootstrap entry point.
 *
 * Composes the runtime container, runs startup guards, builds the Express
 * app, and starts listening. All composition logic lives in `./app/`;
 * this file only owns the process lifecycle (boot → listen → shutdown).
 *
 * The `runtime` is the single source of truth for config, pool, repos,
 * and services. Nothing in this file reaches around it to import
 * singletons directly — if a consumer bootstraps with custom deps later,
 * shutdown and lifecycle still act on the right graph.
 */

import { pool } from './db/pool.js';
import { createCoreRuntime } from './app/runtime-container.js';
import { createApp } from './app/create-app.js';
import { checkEmbeddingDimensions } from './app/startup-checks.js';

// Compose the runtime from explicit deps. The singleton pool is
// imported here (and only here) so the composition root itself has no
// side-effectful singleton dependencies.
const runtime = createCoreRuntime({ pool });
const app = createApp(runtime);

// Re-export composed pieces for existing consumers (tests, research harnesses).
// These preserve the public surface from the previous server.ts.
const service = runtime.services.memory;
const repo = runtime.repos.memory;
const claimRepo = runtime.repos.claims;
const trustRepo = runtime.repos.trust;
const linkRepo = runtime.repos.links;

async function bootstrap(): Promise<void> {
  const check = await checkEmbeddingDimensions(runtime.pool, runtime.config);
  if (!check.ok) {
    console.error(`[startup] FATAL: ${check.message}`);
    process.exit(1);
  }
  console.log(`[startup] ${check.message}`);

  app.listen(runtime.config.port, () => {
    console.log(`AtomicMemory Core running on http://localhost:${runtime.config.port}`);
  });
}

bootstrap().catch((err) => {
  console.error('[startup] bootstrap failed:', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[ERROR] Unhandled rejection (non-fatal):', reason);
});

process.on('SIGTERM', () => {
  console.log('[shutdown] Received SIGTERM, closing...');
  runtime.pool.end().then(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[shutdown] Received SIGINT, closing...');
  runtime.pool.end().then(() => process.exit(0));
});

export { app, service, repo, claimRepo, trustRepo, linkRepo, runtime };
