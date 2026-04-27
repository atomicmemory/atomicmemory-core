/**
 * AUDN (Add/Update/Delete/Noop) decision resolution and mutation execution.
 * Handles fast-path AUDN, deferred AUDN, conflict candidate discovery,
 * and the full mutation pipeline (update, supersede, delete canonical facts).
 */

import { type ClaimSlotInput } from '../db/claim-repository.js';
import { embedText } from './embedding.js';
import { type AUDNDecision } from './extraction.js';
import { cachedResolveAUDN } from './extraction-cache.js';
import { applyOpinionSignal, audnActionToOpinionSignal } from './memory-network.js';
import { buildAtomicFactProjection, buildForesightProjections } from './memcell-projection.js';
import { applyClarificationOverrides, mergeCandidates, type CandidateMemory } from './conflict-policy.js';
import { emitAuditEvent } from './audit-events.js';
import { recordContradictionLesson } from './lesson-service.js';
import { shouldDeferAudn, deferMemoryForReconciliation } from './deferred-audn.js';
import { timed } from './timing.js';
import { emitLineageEvent } from './memory-lineage.js';
import { storeCanonicalFact, storeProjection, applyEntityScopedDedup, ensureClaimTarget, findConflictCandidates, findSlotConflictCandidates } from './memory-storage.js';
import type {
  AudnFactContext,
  ClaimTarget,
  FactInput,
  FactResult,
  IngestFactTrace,
  IngestTraceAction,
  IngestTraceCandidate,
  MemoryServiceDeps,
  Outcome,
} from './memory-service-types.js';

interface AudnTraceContext {
  fact: FactInput;
  logicalTimestamp?: Date;
  writeSecurity: { allowed: boolean; blockedBy: string | null; trust: { score: number } };
  entropyResult?: {
    score: number;
    entityNovelty: number;
    semanticNovelty: number;
    accepted: boolean;
  } | null;
  candidates: IngestTraceCandidate[];
}

/** Find conflict candidates, merge slot-aware candidates, and filter out superseded. */
export async function findFilteredCandidates(
  deps: MemoryServiceDeps,
  userId: string,
  fact: FactInput,
  embedding: number[],
  claimSlot: ClaimSlotInput | null,
  supersededTargets: Set<string>,
): Promise<CandidateMemory[]> {
  const candidates = await timed('ingest.fact.find-conflicts', () => findConflictCandidates(deps, userId, fact.fact, embedding));
  const slotAwareCandidates = claimSlot
    ? await timed('ingest.fact.find-slot-candidates', () => findSlotConflictCandidates(deps, userId, claimSlot))
    : [];
  const merged = mergeCandidates(candidates, slotAwareCandidates);
  return merged.filter((c) => !supersededTargets.has(c.id));
}

/** Resolve AUDN decision (fast/deferred/full) and execute it. */
export async function resolveAndExecuteAudn(
  deps: MemoryServiceDeps,
  userId: string,
  fact: FactInput,
  embedding: number[],
  sourceSite: string,
  sourceUrl: string,
  episodeId: string,
  trustScore: number,
  claimSlot: ClaimSlotInput | null,
  logicalTimestamp: Date | undefined,
  filteredCandidates: CandidateMemory[],
  supersededTargets: Set<string>,
  workspace?: import('../db/repository-types.js').WorkspaceContext,
  traceContext?: AudnTraceContext,
): Promise<FactResult> {
  const candidateIds = new Set(filteredCandidates.map((c) => c.id));
  const ctx: AudnFactContext = { userId, fact, embedding, sourceSite, sourceUrl, episodeId, trustScore, claimSlot, logicalTimestamp, workspace };

  const fastDecision = tryFastAUDN(fact.fact, filteredCandidates, deps.config);
  if (fastDecision) {
    return executeAndTrackSupersede(deps, fastDecision, candidateIds, ctx, supersededTargets, requireTraceContext(traceContext), 'fast-audn', 'NOOP', fastDecision.action);
  }

  if (shouldDeferAudn(false, filteredCandidates.length)) {
    const result = await storeCanonicalFact(deps, ctx);
    if (result.memoryId) {
      await deferMemoryForReconciliation(deps.stores.pool, result.memoryId, filteredCandidates);
      console.log(`[deferred-audn] Deferred: ${result.memoryId} (${filteredCandidates.length} candidates)`);
    }
    return {
      ...result,
      embedding,
      trace: buildAudnTrace(requireTraceContext(traceContext), 'deferred-audn', 'ADD', 'deferred-audn-store', result.outcome, result.memoryId, null),
    };
  }

  const rawDecision = await timed('ingest.fact.audn', () => cachedResolveAUDN(fact.fact, filteredCandidates));
  let decision = applyClarificationOverrides(rawDecision, fact.fact, filteredCandidates, fact.keywords, fact.type);
  if (deps.config.entityGraphEnabled && deps.stores.entity) {
    decision = await applyEntityScopedDedup(deps, decision, userId, fact.entities);
  }
  return executeAndTrackSupersede(deps, decision, candidateIds, ctx, supersededTargets, requireTraceContext(traceContext), 'llm-audn', rawDecision.action, decision.action);
}

/** Execute the AUDN decision and track supersede targets. */
async function executeAndTrackSupersede(
  deps: MemoryServiceDeps,
  decision: AUDNDecision,
  candidateIds: Set<string>,
  ctx: AudnFactContext,
  supersededTargets: Set<string>,
  traceContext: AudnTraceContext,
  source: 'fast-audn' | 'llm-audn',
  rawAction: string | null,
  effectiveAction: IngestTraceAction,
): Promise<FactResult> {
  const result = await executeDecision(deps, decision, candidateIds, ctx);
  if (decision.action === 'SUPERSEDE' && result.memoryId) {
    supersededTargets.add(result.memoryId);
  }
  return {
    ...result,
    embedding: ctx.embedding,
    trace: buildAudnTrace(
      traceContext,
      source,
      effectiveAction,
      reasonCodeForDecision(source, decision, result),
      result.outcome,
      result.memoryId,
      decision.targetMemoryId,
      rawAction,
    ),
  };
}

async function executeDecision(
  deps: MemoryServiceDeps,
  decision: AUDNDecision,
  candidateIds: Set<string>,
  ctx: AudnFactContext,
): Promise<{ outcome: Outcome; memoryId: string | null }> {
  const opinionResult = await tryOpinionIntercept(deps, decision, ctx);
  if (opinionResult) return opinionResult;

  if (decision.action === 'ADD') {
    return storeCanonicalFact(deps, ctx);
  }
  if (decision.action === 'NOOP') {
    return recordNoop(deps, decision.targetMemoryId, candidateIds, ctx.userId, ctx.episodeId, ctx.fact.fact);
  }
  if (decision.action === 'CLARIFY') {
    return storeClarification(deps, decision, ctx);
  }
  if (!decision.targetMemoryId || !candidateIds.has(decision.targetMemoryId)) {
    console.error(`AUDN ${decision.action} rejected for fact "${ctx.fact.fact.slice(0, 50)}...": invalid targetMemoryId "${decision.targetMemoryId}". Candidates were: ${[...candidateIds].join(', ')}`);
    return storeCanonicalFact(deps, ctx);
  }
  return executeMutationDecision(deps, decision, ctx);
}

function buildAudnTrace(
  traceContext: AudnTraceContext,
  source: 'fast-audn' | 'deferred-audn' | 'llm-audn',
  action: IngestTraceAction,
  reasonCode: IngestFactTrace['decision']['reasonCode'],
  outcome: Outcome,
  memoryId: string | null,
  targetMemoryId: string | null,
  rawAction?: string | null,
): IngestFactTrace {
  return {
    factText: traceContext.fact.fact,
    headline: traceContext.fact.headline,
    factType: traceContext.fact.type,
    importance: traceContext.fact.importance,
    ...(traceContext.logicalTimestamp ? { logicalTimestamp: traceContext.logicalTimestamp.toISOString() } : {}),
    writeSecurity: {
      allowed: traceContext.writeSecurity.allowed,
      blockedBy: traceContext.writeSecurity.blockedBy,
      trustScore: traceContext.writeSecurity.trust.score,
    },
    ...(traceContext.entropyResult ? { entropyGate: traceContext.entropyResult } : {}),
    candidates: traceContext.candidates,
    decision: {
      source,
      action,
      reasonCode,
      targetMemoryId,
      candidateIds: traceContext.candidates.map((candidate) => candidate.id),
      ...(rawAction ? { rawAction } : {}),
    },
    outcome,
    memoryId,
  };
}

function requireTraceContext(traceContext: AudnTraceContext | undefined): AudnTraceContext {
  if (!traceContext) {
    throw new Error('resolveAndExecuteAudn requires traceContext.');
  }
  return traceContext;
}

function reasonCodeForDecision(
  source: 'fast-audn' | 'llm-audn',
  decision: AUDNDecision,
  result: { outcome: Outcome; memoryId: string | null },
): IngestFactTrace['decision']['reasonCode'] {
  if (source === 'fast-audn') return 'fast-audn-noop';
  if (isInvalidTargetFallback(decision, result)) {
    return 'invalid-target-fallback';
  }
  return decision.action === 'SUPERSEDE' && !result.memoryId
    ? 'invalid-target-fallback'
    : decisionReasonCode(decision.action);
}

function isInvalidTargetFallback(
  decision: AUDNDecision,
  result: { outcome: Outcome; memoryId: string | null },
): boolean {
  return !['ADD', 'NOOP', 'CLARIFY'].includes(decision.action) && result.outcome === 'stored';
}

function decisionReasonCode(
  action: AUDNDecision['action'],
): IngestFactTrace['decision']['reasonCode'] {
  const reasonCodes = {
    ADD: 'llm-audn-add',
    NOOP: 'llm-audn-noop',
    CLARIFY: 'llm-audn-clarify',
    UPDATE: 'llm-audn-update',
    DELETE: 'llm-audn-delete',
    SUPERSEDE: 'llm-audn-supersede',
  } satisfies Record<AUDNDecision['action'], IngestFactTrace['decision']['reasonCode']>;
  return reasonCodes[action];
}

/** Handle opinion network intercept: update confidence instead of normal AUDN. */
async function tryOpinionIntercept(
  deps: MemoryServiceDeps,
  decision: AUDNDecision,
  ctx: AudnFactContext,
): Promise<{ outcome: Outcome; memoryId: string | null } | null> {
  if (ctx.fact.network !== 'opinion' || !decision.targetMemoryId || decision.action === 'ADD') return null;

  const targetMemory = await deps.stores.memory.getMemory(decision.targetMemoryId, ctx.userId);
  if (!targetMemory || targetMemory.network !== 'opinion' || targetMemory.opinion_confidence === null) return null;

  const signal = audnActionToOpinionSignal(decision.action);
  const newConfidence = applyOpinionSignal(targetMemory.opinion_confidence, signal);
  await deps.stores.memory.updateOpinionConfidence(ctx.userId, decision.targetMemoryId, newConfidence);

  if (newConfidence <= 0 && targetMemory.opinion_confidence > 0) {
    await deps.stores.memory.storeMemory({
      userId: ctx.userId, content: ctx.fact.fact, embedding: ctx.embedding, memoryType: 'episodic', importance: ctx.fact.importance,
      sourceSite: ctx.sourceSite, sourceUrl: ctx.sourceUrl, episodeId: ctx.episodeId, status: 'needs_clarification',
      metadata: { clarification_note: 'Opinion confidence dropped to zero', target_memory_id: decision.targetMemoryId },
      trustScore: ctx.trustScore, network: 'opinion', opinionConfidence: 0,
      createdAt: ctx.logicalTimestamp, observedAt: ctx.logicalTimestamp,
      workspaceId: ctx.workspace?.workspaceId, agentId: ctx.workspace?.agentId, visibility: ctx.workspace?.visibility,
    });
  }
  if (decision.action === 'SUPERSEDE') {
    return storeCanonicalFact(deps, ctx);
  }
  return { outcome: decision.action === 'NOOP' ? 'skipped' : 'updated', memoryId: decision.targetMemoryId };
}

/** Store a fact as needs_clarification for the CLARIFY action. */
async function storeClarification(
  deps: MemoryServiceDeps,
  decision: AUDNDecision,
  ctx: AudnFactContext,
): Promise<{ outcome: Outcome; memoryId: string | null }> {
  await deps.stores.memory.storeMemory({
    userId: ctx.userId, content: ctx.fact.fact, embedding: ctx.embedding,
    memoryType: ctx.fact.type === 'knowledge' ? 'semantic' : 'episodic',
    importance: ctx.fact.importance, sourceSite: ctx.sourceSite, sourceUrl: ctx.sourceUrl, episodeId: ctx.episodeId,
    status: 'needs_clarification',
    metadata: {
      clarification_note: decision.clarificationNote ?? 'Low-confidence contradiction detected',
      target_memory_id: decision.targetMemoryId ?? undefined,
      contradiction_confidence: decision.contradictionConfidence ?? undefined,
    },
    trustScore: ctx.trustScore, createdAt: ctx.logicalTimestamp, observedAt: ctx.logicalTimestamp,
    workspaceId: ctx.workspace?.workspaceId, agentId: ctx.workspace?.agentId, visibility: ctx.workspace?.visibility,
  });
  return { outcome: 'skipped' as Outcome, memoryId: null };
}

/** Execute UPDATE, DELETE, or SUPERSEDE — fails closed on error. */
async function executeMutationDecision(
  deps: MemoryServiceDeps,
  decision: AUDNDecision,
  ctx: AudnFactContext,
): Promise<{ outcome: Outcome; memoryId: string | null }> {
  if (decision.action === 'UPDATE') {
    return await updateCanonicalFact(deps, decision, ctx);
  }
  if (decision.action === 'DELETE') {
    return await deleteCanonicalFact(deps, decision.targetMemoryId!, ctx.userId, ctx.fact, ctx.sourceSite, ctx.sourceUrl, ctx.episodeId, decision.contradictionConfidence, ctx.logicalTimestamp);
  }
  return await supersedeCanonicalFact(deps, decision.targetMemoryId!, ctx.userId, ctx.fact, ctx.embedding, ctx.sourceSite, ctx.sourceUrl, ctx.episodeId, decision.contradictionConfidence, ctx.trustScore, ctx.logicalTimestamp, ctx.workspace);
}

async function updateCanonicalFact(
  deps: MemoryServiceDeps,
  decision: AUDNDecision,
  ctx: AudnFactContext,
): Promise<{ outcome: Outcome; memoryId: string | null }> {
  const { userId, fact, sourceSite, sourceUrl, episodeId, trustScore, logicalTimestamp, workspace } = ctx;
  if (!decision.updatedContent) {
    throw new Error(`AUDN UPDATE failed: missing updatedContent for target "${decision.targetMemoryId}"`);
  }
  const target = await ensureClaimTarget(deps, userId, decision.targetMemoryId!);
  const updatedEmbedding = await embedText(decision.updatedContent);
  await deps.stores.memory.updateMemoryContent(userId, target.memoryId, decision.updatedContent, updatedEmbedding, fact.importance, fact.keywords.join(' '), trustScore);
  const updatedAtomicFact = buildAtomicFactProjection({ ...fact, fact: decision.updatedContent }, updatedEmbedding);
  await deps.stores.representation.replaceAtomicFactsForMemory(userId, target.memoryId, [{
    userId, parentMemoryId: target.memoryId,
    factText: updatedAtomicFact.factText, embedding: updatedAtomicFact.embedding,
    factType: updatedAtomicFact.factType, importance: updatedAtomicFact.importance,
    sourceSite, sourceUrl, episodeId,
    keywords: updatedAtomicFact.keywords.join(' '), metadata: updatedAtomicFact.metadata,
    workspaceId: workspace?.workspaceId, agentId: workspace?.agentId,
  }]);
  const updatedForesight = buildForesightProjections({ ...fact, fact: decision.updatedContent }, updatedEmbedding);
  await deps.stores.representation.replaceForesightForMemory(userId, target.memoryId,
    updatedForesight.map((entry) => ({
      userId, parentMemoryId: target.memoryId,
      content: entry.content, embedding: entry.embedding, foresightType: entry.foresightType,
      sourceSite, sourceUrl, episodeId,
      metadata: entry.metadata, validFrom: entry.validFrom, validTo: entry.validTo,
      workspaceId: workspace?.workspaceId, agentId: workspace?.agentId,
    })),
  );
  const lineage = await emitLineageEvent({ claims: deps.stores.claim, repo: deps.stores.memory, config: deps.config }, {
    kind: 'canonical-update',
    userId,
    fact,
    updatedContent: decision.updatedContent,
    updatedEmbedding,
    sourceSite,
    sourceUrl,
    episodeId,
    logicalTimestamp,
    target,
    contradictionConfidence: decision.contradictionConfidence,
  });
  if (!lineage?.cmoId) {
    throw new Error(`AUDN UPDATE failed: missing successor canonical object for "${target.memoryId}"`);
  }
  await deps.stores.memory.updateMemoryMetadata(userId, target.memoryId, { cmo_id: lineage.cmoId });
  return { outcome: 'updated', memoryId: target.memoryId };
}

async function supersedeCanonicalFact(
  deps: MemoryServiceDeps,
  targetMemoryId: string,
  userId: string,
  fact: FactInput,
  embedding: number[],
  sourceSite: string,
  sourceUrl: string,
  episodeId: string,
  contradictionConfidence?: number | null,
  trustScore?: number,
  logicalTimestamp?: Date,
  workspace?: import('../db/repository-types.js').WorkspaceContext,
): Promise<{ outcome: Outcome; memoryId: string | null }> {
  const target = await ensureClaimTarget(deps, userId, targetMemoryId);
  await deps.stores.memory.expireMemory(userId, target.memoryId);
  const newMemoryId = await storeProjection(deps, userId, fact, embedding, sourceSite, sourceUrl, episodeId, trustScore ?? 1.0, {
    logicalTimestamp,
    workspace,
  });
  if (!newMemoryId) return { outcome: 'skipped', memoryId: null };
  const lineage = await emitLineageEvent({ claims: deps.stores.claim, repo: deps.stores.memory, config: deps.config }, {
    kind: 'canonical-supersede',
    userId,
    fact,
    embedding,
    sourceSite,
    sourceUrl,
    episodeId,
    logicalTimestamp,
    target,
    newMemoryId,
    contradictionConfidence,
  });
  if (!lineage?.cmoId) {
    throw new Error(`AUDN SUPERSEDE failed: missing successor canonical object for "${target.memoryId}"`);
  }
  await deps.stores.memory.updateMemoryMetadata(userId, newMemoryId, { cmo_id: lineage.cmoId });
  if (deps.config.lessonsEnabled && deps.stores.lesson && contradictionConfidence) {
    recordContradictionLesson(deps.stores.lesson!, {
      userId, content: fact.fact, sourceSite,
      contradictionConfidence, supersededMemoryId: target.memoryId,
    }).catch((err) => console.error('Lesson recording failed:', err));
  }
  return { outcome: 'deleted', memoryId: newMemoryId };
}

/** Handle AUDN DELETE: soft-delete the old memory without creating a replacement. */
async function deleteCanonicalFact(
  deps: MemoryServiceDeps,
  targetMemoryId: string,
  userId: string,
  fact: FactInput,
  sourceSite: string,
  sourceUrl: string,
  episodeId: string,
  contradictionConfidence?: number | null,
  logicalTimestamp?: Date,
): Promise<{ outcome: Outcome; memoryId: string | null }> {
  const target = await ensureClaimTarget(deps, userId, targetMemoryId);
  const targetMemory = await deps.stores.memory.getMemoryIncludingDeleted(target.memoryId, userId);
  if (!targetMemory) return { outcome: 'skipped', memoryId: null };
  await deps.stores.memory.softDeleteMemory(userId, target.memoryId);
  await emitLineageEvent({ claims: deps.stores.claim, repo: deps.stores.memory, config: deps.config }, {
    kind: 'canonical-delete',
    userId,
    fact,
    sourceSite,
    sourceUrl,
    episodeId,
    logicalTimestamp,
    target,
    targetEmbedding: targetMemory.embedding,
    contradictionConfidence,
  });
  if (deps.config.auditLoggingEnabled) {
    emitAuditEvent('memory:delete', userId, {
      reason: 'audn-delete', targetMemoryId: target.memoryId, contradictionConfidence,
    }, { memoryId: target.memoryId });
  }
  return { outcome: 'deleted', memoryId: null };
}

async function recordNoop(
  deps: MemoryServiceDeps,
  targetMemoryId: string | null,
  candidateIds: Set<string>,
  userId: string,
  episodeId: string,
  quoteText: string,
): Promise<{ outcome: Outcome; memoryId: null }> {
  if (!targetMemoryId || !candidateIds.has(targetMemoryId)) return { outcome: 'skipped', memoryId: null };
  try {
    const target = await ensureClaimTarget(deps, userId, targetMemoryId);
    await deps.stores.claim.addEvidence({ claimVersionId: target.versionId, episodeId, memoryId: target.memoryId, quoteText });
  } catch {
    // Target memory may not exist if AUDN decision was cached from a previous run.
    // Safe to skip -- NOOP means "do nothing."
  }
  return { outcome: 'skipped', memoryId: null };
}

const QUOTED_LITERAL_PATTERN = /["""'\u2018\u2019\u201C\u201D]([^"""'\u2018\u2019\u201C\u201D]{2,80})["""'\u2018\u2019\u201C\u201D]/g;

function sharesQuotedLiteral(factText: string, candidateContent: string): boolean {
  const quotedLiterals = extractQuotedLiterals(factText);
  if (quotedLiterals.length === 0) return true;
  const lowerCandidate = candidateContent.toLowerCase();
  return quotedLiterals.every((literal) => lowerCandidate.includes(literal.toLowerCase()));
}

function extractQuotedLiterals(text: string): string[] {
  const literals: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = QUOTED_LITERAL_PATTERN.exec(text)) !== null) {
    literals.push(match[1]);
  }
  return literals;
}

/**
 * Fast-path AUDN: skip the LLM call for clear-cut embedding similarity cases.
 * sim >= 0.95: near-duplicate -> NOOP (skip storing).
 * Returns null when the case is ambiguous and needs full LLM AUDN.
 */
function tryFastAUDN(
  factText: string,
  candidates: CandidateMemory[],
  runtimeConfig: Pick<MemoryServiceDeps['config'], 'fastAudnEnabled' | 'fastAudnDuplicateThreshold'>,
): AUDNDecision | null {
  if (!runtimeConfig.fastAudnEnabled) return null;

  const topCandidate = candidates.reduce(
    (best, c) => (c.similarity > best.similarity ? c : best),
    candidates[0],
  );

  if (!sharesQuotedLiteral(factText, topCandidate.content)) {
    return null;
  }

  if (topCandidate.similarity >= runtimeConfig.fastAudnDuplicateThreshold) {
    console.log(`[fast-audn] NOOP: sim=${topCandidate.similarity.toFixed(4)} >= ${runtimeConfig.fastAudnDuplicateThreshold} (near-duplicate of ${topCandidate.id})`);
    return {
      action: 'NOOP',
      targetMemoryId: topCandidate.id,
      updatedContent: null,
      contradictionConfidence: null,
    };
  }

  return null;
}
