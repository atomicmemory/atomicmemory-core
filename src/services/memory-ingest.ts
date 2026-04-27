/**
 * Top-level ingest pipeline logic: performIngest, performQuickIngest, performWorkspaceIngest.
 * Delegates AUDN resolution to memory-audn.ts and storage to memory-storage.ts.
 */

import { embedText } from './embedding.js';
import { consensusExtractFacts } from './consensus-extraction.js';
import { quickExtractFacts } from './quick-extraction.js';
import { IngestTraceCollector } from './ingest-trace.js';
import { assessWriteSecurity } from './write-security.js';
import { timed } from './timing.js';
import { runPostWriteProcessors } from './ingest-post-write.js';
import { processFactThroughPipeline } from './ingest-fact-pipeline.js';
import { resolveSessionDate } from './session-date.js';
import type { MemoryMetadata, WorkspaceContext } from '../db/repository-types.js';
import type {
  IngestResult,
  EntropyContext,
  FactInput,
  FactResult,
  MemoryServiceDeps,
} from './memory-service-types.js';

/** Mutable accumulators shared across ingest loops. */
interface IngestAccumulator {
  counters: Record<string, number>;
  storedMemoryIds: string[];
  updatedMemoryIds: string[];
  memoryIds: string[];
  embeddingCache: Map<string, number[]>;
}

function createIngestAccumulator(): IngestAccumulator {
  return {
    counters: { stored: 0, updated: 0, deleted: 0, skipped: 0 },
    storedMemoryIds: [],
    updatedMemoryIds: [],
    memoryIds: [],
    embeddingCache: new Map(),
  };
}

/** Record a single fact result into the accumulator. */
function accumulateFactResult(acc: IngestAccumulator, result: FactResult): void {
  if (result.memoryId) {
    acc.memoryIds.push(result.memoryId);
    if (result.outcome === 'stored') acc.storedMemoryIds.push(result.memoryId);
    else if (result.outcome === 'updated') acc.updatedMemoryIds.push(result.memoryId);
    if (result.embedding) acc.embeddingCache.set(result.memoryId, result.embedding);
  }
  acc.counters[result.outcome]++;
}

function buildIngestResult(episodeId: string, factsCount: number, acc: IngestAccumulator, linksCreated: number, compositesCreated: number): IngestResult {
  return {
    episodeId, factsExtracted: factsCount,
    memoriesStored: acc.counters.stored, memoriesUpdated: acc.counters.updated,
    memoriesDeleted: acc.counters.deleted, memoriesSkipped: acc.counters.skipped,
    storedMemoryIds: acc.storedMemoryIds, updatedMemoryIds: acc.updatedMemoryIds,
    memoryIds: acc.memoryIds, linksCreated, compositesCreated,
  };
}

function finalizeIngestResult(
  episodeId: string,
  factsCount: number,
  acc: IngestAccumulator,
  linksCreated: number,
  compositesCreated: number,
  traceCollector: IngestTraceCollector,
  traceMetadata: Parameters<IngestTraceCollector['finalize']>[0],
): IngestResult {
  return {
    ...buildIngestResult(episodeId, factsCount, acc, linksCreated, compositesCreated),
    ingestTraceId: traceCollector.finalize(traceMetadata),
  };
}

/** Full consensus-based ingest pipeline. */
export async function performIngest(
  deps: MemoryServiceDeps,
  userId: string,
  conversationText: string,
  sourceSite: string,
  sourceUrl: string = '',
  sessionTimestamp?: Date,
): Promise<IngestResult> {
  const ingestStart = performance.now();
  const logicalSessionTimestamp = resolveSessionDate(sessionTimestamp, conversationText);
  const episodeId = await timed('ingest.store-episode', () => deps.stores.episode.storeEpisode({ userId, content: conversationText, sourceSite, sourceUrl }));
  const facts = await timed('ingest.extract', () => consensusExtractFacts(conversationText, deps.config));
  const traceCollector = new IngestTraceCollector(deps.config.ingestTraceEnabled);
  const acc = createIngestAccumulator();
  const supersededTargets = new Set<string>();
  const entropyCtx: EntropyContext = { seenEntities: new Set(), previousEmbedding: null };
  const storedFacts: Array<{ memoryId: string; fact: FactInput }> = [];

  for (const fact of facts) {
    const result = await timed('ingest.fact', () => processFactThroughPipeline(
      deps, userId, fact, sourceSite, sourceUrl, episodeId,
      { entropyGate: true, fullAudn: true, supersededTargets, entropyCtx, logicalTimestamp: logicalSessionTimestamp, timingPrefix: 'ingest', traceCollector },
    ));
    accumulateFactResult(acc, result);
    if (result.memoryId) storedFacts.push({ memoryId: result.memoryId, fact });
  }

  const postWrite = await runPostWriteProcessors(deps, userId, {
    episodeId, sourceSite, sourceUrl, storedFacts,
    memoryIds: acc.memoryIds, embeddingCache: acc.embeddingCache,
    sessionTimestamp: logicalSessionTimestamp, compositesEnabled: deps.config.compositeGroupingEnabled,
    timingPrefix: 'ingest',
  });

  console.log(`[timing] ingest.total: ${(performance.now() - ingestStart).toFixed(1)}ms (${facts.length} facts, ${postWrite.compositesCreated} composites)`);
  return finalizeIngestResult(
    episodeId,
    facts.length,
    acc,
    postWrite.linksCreated,
    postWrite.compositesCreated,
    traceCollector,
    { mode: 'full', userId, sourceSite, sourceUrl, episodeId, factsExtracted: facts.length },
  );
}

/**
 * Fast ingest path for UC2 (background capture).
 * Uses rule-based extraction (~50ms) instead of LLM consensus (~22s).
 */
export async function performQuickIngest(
  deps: MemoryServiceDeps,
  userId: string,
  conversationText: string,
  sourceSite: string,
  sourceUrl: string = '',
  sessionTimestamp?: Date,
): Promise<IngestResult> {
  const ingestStart = performance.now();
  const logicalSessionTimestamp = resolveSessionDate(sessionTimestamp, conversationText);
  const episodeId = await deps.stores.episode.storeEpisode({ userId, content: conversationText, sourceSite, sourceUrl });
  const facts = timed('quick-ingest.extract', () => Promise.resolve(quickExtractFacts(conversationText)));
  const extractedFacts = await facts;
  const traceCollector = new IngestTraceCollector(deps.config.ingestTraceEnabled);
  const acc = createIngestAccumulator();

  for (const fact of extractedFacts) {
    const result = await timed('quick-ingest.fact', () => processFactThroughPipeline(
      deps, userId, fact, sourceSite, sourceUrl, episodeId,
      { entropyGate: false, fullAudn: false, supersededTargets: new Set(), entropyCtx: { seenEntities: new Set(), previousEmbedding: null }, logicalTimestamp: logicalSessionTimestamp, timingPrefix: 'quick-ingest', traceCollector },
    ));
    accumulateFactResult(acc, result);
  }

  const postWrite = await runPostWriteProcessors(deps, userId, {
    episodeId, sourceSite, sourceUrl, storedFacts: [],
    memoryIds: acc.memoryIds, embeddingCache: acc.embeddingCache,
    sessionTimestamp: logicalSessionTimestamp, compositesEnabled: false,
    timingPrefix: 'quick-ingest',
  });

  console.log(`[timing] quick-ingest.total: ${(performance.now() - ingestStart).toFixed(1)}ms (${extractedFacts.length} facts, ${acc.counters.stored} stored, ${acc.counters.skipped} skipped)`);
  return finalizeIngestResult(
    episodeId,
    extractedFacts.length,
    acc,
    postWrite.linksCreated,
    0,
    traceCollector,
    { mode: 'quick', userId, sourceSite, sourceUrl, episodeId, factsExtracted: extractedFacts.length },
  );
}

/**
 * Store content as a single memory without fact extraction.
 * Used for user-created contexts (text/file uploads) where
 * the content should remain as one canonical memory record.
 */
export async function performStoreVerbatim(
  deps: MemoryServiceDeps,
  userId: string,
  content: string,
  sourceSite: string,
  sourceUrl: string = '',
  metadata?: MemoryMetadata,
): Promise<IngestResult> {
  const episodeId = await deps.stores.episode.storeEpisode({ userId, content, sourceSite, sourceUrl });
  const embedding = await embedText(content);
  const writeSecurity = assessWriteSecurity(content, sourceSite, deps.config);
  const trustScore = writeSecurity.allowed ? writeSecurity.trust.score : 0.5;
  const traceCollector = new IngestTraceCollector(deps.config.ingestTraceEnabled);

  const memoryId = await deps.stores.memory.storeMemory({
    userId,
    content,
    embedding,
    memoryType: 'semantic',
    importance: 0.5,
    sourceSite,
    sourceUrl,
    episodeId,
    status: 'active',
    keywords: '',
    summary: content.slice(0, 200),
    trustScore,
    metadata,
  });

  traceCollector.record({
    factText: content,
    headline: content.slice(0, 80),
    factType: 'verbatim',
    importance: 0.5,
    writeSecurity: {
      allowed: writeSecurity.allowed,
      blockedBy: writeSecurity.blockedBy,
      trustScore: writeSecurity.trust.score,
    },
    decision: {
      source: 'verbatim',
      action: 'ADD',
      reasonCode: 'verbatim-store',
      targetMemoryId: null,
    },
    outcome: 'stored',
    memoryId,
  });

  return {
    episodeId,
    factsExtracted: 1,
    memoriesStored: 1,
    memoriesUpdated: 0,
    memoriesDeleted: 0,
    memoriesSkipped: 0,
    storedMemoryIds: [memoryId],
    updatedMemoryIds: [],
    memoryIds: [memoryId],
    linksCreated: 0,
    compositesCreated: 0,
    ingestTraceId: traceCollector.finalize({ mode: 'verbatim', userId, sourceSite, sourceUrl, episodeId, factsExtracted: 1 }),
  };
}

/** Workspace-scoped ingest: stores memories tagged with workspace_id and agent_id. */
export async function performWorkspaceIngest(
  deps: MemoryServiceDeps,
  userId: string,
  conversationText: string,
  sourceSite: string,
  sourceUrl: string = '',
  workspace: WorkspaceContext,
  sessionTimestamp?: Date,
): Promise<IngestResult> {
  const ingestStart = performance.now();
  const logicalSessionTimestamp = resolveSessionDate(sessionTimestamp, conversationText);
  const episodeId = await timed('ws-ingest.store-episode', () =>
    deps.stores.episode.storeEpisode({
      userId, content: conversationText, sourceSite, sourceUrl,
      workspaceId: workspace.workspaceId, agentId: workspace.agentId,
    }),
  );
  const facts = await timed('ws-ingest.extract', () => consensusExtractFacts(conversationText, deps.config));
  const traceCollector = new IngestTraceCollector(deps.config.ingestTraceEnabled);
  const acc = createIngestAccumulator();
  const supersededTargets = new Set<string>();
  const entropyCtx: EntropyContext = { seenEntities: new Set(), previousEmbedding: null };

  for (const fact of facts) {
    const result = await timed('ws-ingest.fact', () =>
      processFactThroughPipeline(deps, userId, fact, sourceSite, sourceUrl, episodeId,
        {
          workspace,
          entropyGate: false,
          fullAudn: true,
          supersededTargets,
          entropyCtx,
          logicalTimestamp: logicalSessionTimestamp,
          timingPrefix: 'ws-ingest',
          traceCollector,
        }),
    );
    accumulateFactResult(acc, result);
  }

  const postWrite = await runPostWriteProcessors(deps, userId, {
    episodeId, sourceSite, sourceUrl, storedFacts: [],
    memoryIds: acc.memoryIds, embeddingCache: acc.embeddingCache,
    sessionTimestamp: logicalSessionTimestamp, compositesEnabled: false,
    timingPrefix: 'ws-ingest',
  });

  console.log(`[timing] ws-ingest.total: ${(performance.now() - ingestStart).toFixed(1)}ms (${facts.length} facts, workspace=${workspace.workspaceId})`);
  return finalizeIngestResult(
    episodeId,
    facts.length,
    acc,
    postWrite.linksCreated,
    0,
    traceCollector,
    { mode: 'workspace', userId, sourceSite, sourceUrl, episodeId, factsExtracted: facts.length },
  );
}
