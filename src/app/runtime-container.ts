/**
 * Core runtime container — the explicit composition root for Atomicmemory-core.
 *
 * Owns the construction of config, pool, repositories, and services so
 * startup (`server.ts`), tests, and in-process research harnesses all boot
 * through the same seam. Replaces the hidden singleton wiring that used to
 * live inline in `server.ts`.
 *
 * Phase 1A of the rearchitecture — the composition root that replaces
 * per-startup hand-wiring of repos and services in `server.ts`.
 */

import pg from 'pg';
import {
  applyRuntimeConfigUpdates,
  config as defaultConfig,
  type CrossEncoderDtype,
  type RuntimeConfig,
  type RuntimeConfigUpdates,
} from '../config.js';
import { AgentTrustRepository } from '../db/agent-trust-repository.js';
import { ClaimRepository } from '../db/claim-repository.js';
import { LinkRepository } from '../db/link-repository.js';
import { MemoryRepository } from '../db/memory-repository.js';
import { EntityRepository } from '../db/repository-entities.js';
import { LessonRepository } from '../db/repository-lessons.js';
import type { CoreStores } from '../db/stores.js';
import { PgMemoryStore } from '../db/pg-memory-store.js';
import { PgEpisodeStore } from '../db/pg-episode-store.js';
import { PgSearchStore } from '../db/pg-search-store.js';
import { PgSemanticLinkStore } from '../db/pg-link-store.js';
import { PgRepresentationStore } from '../db/pg-representation-store.js';
import type { RetrievalProfile } from '../services/retrieval-profiles.js';
import { MemoryService } from '../services/memory-service.js';
import { initEmbedding } from '../services/embedding.js';
import { initLlm } from '../services/llm.js';
import {
  readRuntimeConfigRouteSnapshot,
  type RuntimeConfigRouteSnapshot,
} from './runtime-config-route-snapshot.js';

/**
 * Explicit runtime configuration subset currently needed by the runtime
 * container, startup checks, search/runtime seams, and MemoryService deps.
 *
 * This is intentionally narrower than the module-level config singleton:
 * it describes the config surface already threaded through those seams
 * today, without claiming full runtime-wide configurability yet.
 *
 * NOTE (phase 1b status): `runtime.config` is normally the module-level
 * singleton, but benchmark harnesses may pass an explicit composition-time
 * RuntimeConfig through `createCoreRuntime({ config })`. MemoryService accepts
 * an optional runtimeConfig override (stored as deps.config), and the search-
 * pipeline orchestration and ingest orchestration files (memory-ingest,
 * memory-storage, memory-audn, memory-lineage) read the fields listed
 * in `CoreRuntimeConfig` and `IngestRuntimeConfig` through deps.config
 * rather than the singleton. The route layer reads through an injectable
 * adapter seam (`configRouteAdapter`) backed by this runtime config object.
 *
 * Leaf modules initialized by this composition root (embedding.ts and llm.ts)
 * are rebound to the runtime config. Other leaf helpers still import the
 * singleton directly, so config overrides are intended for isolated single-
 * runtime harnesses, not multiple concurrently-active runtimes in one process.
 *
 * Remaining singleton importers: 33 non-test source files (tracked by
 * config-singleton-audit.test.ts). This includes infrastructure, CRUD/
 * lifecycle, leaf helpers, the DB repository layer, and index.ts.
 */
export interface CoreRuntimeConfig {
  adaptiveRetrievalEnabled: boolean;
  adaptiveSimpleLimit: number;
  adaptiveMediumLimit: number;
  adaptiveComplexLimit: number;
  adaptiveMultiHopLimit: number;
  adaptiveAggregationLimit: number;
  agenticRetrievalEnabled: boolean;
  auditLoggingEnabled: boolean;
  consensusMinMemories: number;
  consensusValidationEnabled: boolean;
  crossEncoderDtype: CrossEncoderDtype;
  crossEncoderEnabled: boolean;
  crossEncoderModel: string;
  embeddingDimensions: number;
  entityGraphEnabled: boolean;
  entitySearchMinSimilarity: number;
  hybridSearchEnabled: boolean;
  iterativeRetrievalEnabled: boolean;
  lessonsEnabled: boolean;
  linkExpansionBeforeMMR: boolean;
  linkExpansionEnabled: boolean;
  linkExpansionMax: number;
  linkSimilarityThreshold: number;
  literalListProtectionEnabled: boolean;
  literalListProtectionMaxProtected: number;
  maxSearchResults: number;
  mmrEnabled: boolean;
  mmrLambda: number;
  namespaceClassificationEnabled: boolean;
  pprDamping: number;
  pprEnabled: boolean;
  port: number;
  queryAugmentationEnabled: boolean;
  queryAugmentationMaxEntities: number;
  queryAugmentationMinSimilarity: number;
  queryExpansionEnabled: boolean;
  queryExpansionMinSimilarity: number;
  repairConfidenceFloor: number;
  repairDeltaThreshold: number;
  repairLoopEnabled: boolean;
  repairLoopMinSimilarity: number;
  rerankSkipMinGap: number;
  rerankSkipTopSimilarity: number;
  retrievalProfileSettings: RetrievalProfile;
  temporalQueryConstraintBoost: number;
  temporalQueryConstraintEnabled: boolean;
}

/** Repositories constructed by the runtime container. */
export interface CoreRuntimeRepos {
  memory: MemoryRepository;
  claims: ClaimRepository;
  trust: AgentTrustRepository;
  links: LinkRepository;
  entities: EntityRepository | null;
  lessons: LessonRepository | null;
}

/** Services constructed on top of repositories. */
export interface CoreRuntimeServices {
  memory: MemoryService;
}

export interface CoreRuntimeConfigRouteAdapter {
  base: () => RuntimeConfig;
  current: () => RuntimeConfigRouteSnapshot;
  update: (updates: RuntimeConfigUpdates) => string[];
}

/**
 * Explicit dependency bundle accepted by `createCoreRuntime`.
 *
 * `pool` is required — the composition root never reaches around to
 * import the singleton `pg.Pool` itself.
 *
 * Optional `config` is a composition-time override for isolated harnesses
 * such as AtomicBench. It is not a per-request override and should not be
 * used for multiple concurrently-active runtimes in one process while
 * singleton-importing leaf modules remain.
 */
export interface CoreRuntimeDeps {
  pool: pg.Pool;
  config?: RuntimeConfig;
}

/** The composed runtime — single source of truth for route registration. */
export interface CoreRuntime {
  config: RuntimeConfig;
  configRouteAdapter: CoreRuntimeConfigRouteAdapter;
  pool: pg.Pool;
  repos: CoreRuntimeRepos;
  /** Domain-facing store interfaces (Phase 5). Will replace repos once migration is complete. */
  stores: CoreStores;
  services: CoreRuntimeServices;
}

/**
 * Compose the core runtime. Instantiates repositories and the memory
 * service from an explicit pool. Uses either the module-level config singleton
 * or an explicit composition-time config and passes that same object into leaf
 * module initializers and MemoryService so the composition root owns the seam.
 * No mutation.
 */
export function createCoreRuntime(deps: CoreRuntimeDeps): CoreRuntime {
  const { pool } = deps;
  const runtimeConfig = deps.config ?? defaultConfig;

  // Leaf-module config init (Phase 7 Step 3d). Embedding and LLM modules
  // hold module-local config bound here at composition-root time.
  // Provider/model selection is startup-only (Step 3c), so rebinding
  // only happens via explicit init call (e.g., from tests that swap
  // providers).
  initEmbedding(runtimeConfig);
  initLlm(runtimeConfig);

  const memory = new MemoryRepository(pool);
  const claims = new ClaimRepository(pool);
  const trust = new AgentTrustRepository(pool);
  const links = new LinkRepository(pool);
  const entities = runtimeConfig.entityGraphEnabled ? new EntityRepository(pool) : null;
  const lessons = runtimeConfig.lessonsEnabled ? new LessonRepository(pool) : null;

  const stores: CoreStores = {
    memory: new PgMemoryStore(pool),
    episode: new PgEpisodeStore(pool),
    search: new PgSearchStore(pool),
    link: new PgSemanticLinkStore(pool),
    representation: new PgRepresentationStore(pool),
    claim: claims,
    entity: entities,
    lesson: lessons,
    pool,
  };

  const service = new MemoryService(
    memory,
    claims,
    entities ?? undefined,
    lessons ?? undefined,
    undefined,
    runtimeConfig,
    stores,
  );

  return {
    config: runtimeConfig,
    configRouteAdapter: {
      base() {
        return runtimeConfig;
      },
      current() {
        return readRuntimeConfigRouteSnapshot(runtimeConfig);
      },
      update(updates) {
        return applyRuntimeConfigUpdates(runtimeConfig, updates);
      },
    },
    pool,
    repos: { memory, claims, trust, links, entities, lessons },
    stores,
    services: { memory: service },
  };
}
