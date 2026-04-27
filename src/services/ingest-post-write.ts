/**
 * Post-write processors for the ingest pipeline.
 *
 * Runs after the per-fact loop completes: backdates memories to a session
 * timestamp, generates inter-memory links, and clusters related facts
 * into composite memories. Each processor is independently skippable via
 * the batch context.
 *
 * Composite generation is full-ingest-only. The caller controls this via
 * the `compositesEnabled` field — only `performIngest` sets it to true.
 */

import { generateLinks } from './search-pipeline.js';
import { buildComposites, type CompositeInput } from './composite-grouping.js';
import { inferNamespace, deriveMajorityNamespace } from './namespace-retrieval.js';
import { timed } from './timing.js';
import type { FactInput, MemoryServiceDeps } from './memory-service-types.js';

/** Everything the post-write processors need from the completed fact loop. */
export interface PostWriteBatchContext {
  episodeId: string;
  sourceSite: string;
  sourceUrl: string;
  /** Facts that were actually stored (with their memoryIds). Only populated by performIngest. */
  storedFacts: Array<{ memoryId: string; fact: FactInput }>;
  /** All memory IDs produced by the fact loop (stored + updated). */
  memoryIds: string[];
  /** Embedding cache keyed by memoryId, populated during the fact loop. */
  embeddingCache: Map<string, number[]>;
  /** When set, memories are backdated to this timestamp. */
  sessionTimestamp?: Date;
  /** Caller controls this. Only performIngest sets true. */
  compositesEnabled: boolean;
  /** Timing label prefix for timed() wrappers. */
  timingPrefix: string;
}

export interface PostWriteResult {
  linksCreated: number;
  compositesCreated: number;
}

/**
 * Run all post-write processors for a completed ingest batch.
 * Order: backdate → links → composites (if caller-enabled).
 */
export async function runPostWriteProcessors(
  deps: MemoryServiceDeps,
  userId: string,
  ctx: PostWriteBatchContext,
): Promise<PostWriteResult> {
  if (ctx.sessionTimestamp && ctx.memoryIds.length > 0) {
    await timed(`${ctx.timingPrefix}.backdate`, () =>
      deps.stores.memory.backdateMemories(ctx.memoryIds, ctx.sessionTimestamp!),
    );
  }

  const linksCreated = await timed(
    `${ctx.timingPrefix}.links`,
    () => generateLinks(
      { search: deps.stores.search, link: deps.stores.link, memory: deps.stores.memory, entity: deps.stores.entity, pool: deps.stores.pool },
      userId, ctx.memoryIds, ctx.embeddingCache, deps.config,
    ),
  );

  let compositesCreated = 0;
  if (ctx.compositesEnabled && ctx.storedFacts.length >= deps.config.compositeMinClusterSize) {
    compositesCreated = await timed(`${ctx.timingPrefix}.composites`, () =>
      generateAndStoreComposites(
        deps,
        userId,
        ctx.storedFacts,
        ctx.embeddingCache,
        ctx.sourceSite,
        ctx.sourceUrl,
        ctx.episodeId,
        ctx.sessionTimestamp,
      ),
    );
  }

  return { linksCreated, compositesCreated };
}

/** Generate composite memories by clustering related facts from a single episode. */
async function generateAndStoreComposites(
  deps: MemoryServiceDeps,
  userId: string,
  storedFacts: Array<{ memoryId: string; fact: FactInput }>,
  embeddingCache: Map<string, number[]>,
  sourceSite: string,
  sourceUrl: string,
  episodeId: string,
  sessionTimestamp?: Date,
): Promise<number> {
  const memberNamespaceMap = new Map<string, string | null>();
  const compositeInputs: CompositeInput[] = storedFacts
    .filter((sf) => embeddingCache.has(sf.memoryId))
    .map((sf) => {
      const ns = inferNamespace(sf.fact.fact, sourceSite, sf.fact.keywords);
      memberNamespaceMap.set(sf.memoryId, ns);
      return {
        memoryId: sf.memoryId,
        content: sf.fact.fact,
        embedding: embeddingCache.get(sf.memoryId)!,
        importance: sf.fact.importance,
        keywords: sf.fact.keywords,
        headline: sf.fact.headline,
      };
    });

  const composites = buildComposites(compositeInputs);
  if (composites.length === 0) return 0;

  for (const composite of composites) {
    const memberNamespaces = composite.memberMemoryIds.map((id) => memberNamespaceMap.get(id) ?? null);
    const namespace = deriveMajorityNamespace(memberNamespaces);

    await deps.stores.memory.storeMemory({
      userId,
      content: composite.content,
      embedding: composite.embedding,
      memoryType: 'composite',
      importance: composite.importance,
      sourceSite, sourceUrl, episodeId,
      keywords: composite.keywords.join(' '),
      summary: composite.headline,
      overview: composite.overview,
      trustScore: 1.0,
      createdAt: sessionTimestamp,
      observedAt: sessionTimestamp,
      namespace: namespace ?? undefined,
      metadata: {
        memberMemoryIds: composite.memberMemoryIds,
        compositeVersion: 1,
      },
    });
  }

  return composites.length;
}
