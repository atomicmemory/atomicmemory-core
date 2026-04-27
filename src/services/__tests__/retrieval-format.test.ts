/**
 * Unit tests for retrieval-format injection and citation helpers.
 * Tests formatting, staged loading, citation building, and edge cases.
 */

import { describe, expect, it, vi } from 'vitest';
import { createSearchResult } from './test-fixtures.js';

const mockConfig = {
  stagedLoadingEnabled: false,
};

vi.mock('../../config.js', () => ({
  config: mockConfig,
}));

const {
  buildCitations,
  buildInjection,
  computePackagingSignal,
  formatInjection,
  formatSimpleInjection,
  formatTieredInjection,
} = await import('../retrieval-format.js');

function makeResult(overrides: Partial<import('../../db/repository-types.js').SearchResult> = {}) {
  return createSearchResult({
    id: 'mem-1', content: 'TypeScript is great', embedding: [0.1],
    importance: 0.7, source_site: 'chatgpt',
    created_at: new Date('2026-01-15T00:00:00Z'), access_count: 1,
    similarity: 0.85, score: 0.9,
    ...overrides,
  });
}

describe('buildCitations', () => {
  it('returns citation per memory', () => {
    const results = [makeResult({ id: 'a' }), makeResult({ id: 'b' })];
    const citations = buildCitations(results);
    expect(citations).toHaveLength(2);
    expect(citations[0].memory_id).toBe('a');
    expect(citations[1].memory_id).toBe('b');
  });

  it('includes source_site and importance', () => {
    const citation = buildCitations([makeResult()])[0];
    expect(citation.source_site).toBe('chatgpt');
    expect(citation.importance).toBe(0.7);
  });

  it('formats created_at as ISO string', () => {
    const citation = buildCitations([makeResult()])[0];
    expect(citation.created_at).toBe('2026-01-15T00:00:00.000Z');
  });

  it('returns empty array for no results', () => {
    expect(buildCitations([])).toEqual([]);
  });
});

describe('formatInjection', () => {
  it('returns empty string for no memories', () => {
    expect(formatInjection([])).toBe('');
  });

  it('wraps memories in atomicmem_context XML', () => {
    const result = formatInjection([makeResult()]);
    expect(result).toContain('<atomicmem_context count="1">');
    expect(result).toContain('</atomicmem_context>');
  });

  it('includes memory content in full mode', () => {
    const result = formatInjection([makeResult({ content: 'hello world' })]);
    expect(result).toContain('hello world');
  });

  it('escapes XML special characters', () => {
    const result = formatInjection([makeResult({ content: 'a < b & c > d' })]);
    expect(result).toContain('a &lt; b &amp; c &gt; d');
  });

  it('includes similarity and score attributes', () => {
    const result = formatInjection([makeResult({ similarity: 0.85, score: 0.9 })]);
    expect(result).toContain('similarity="0.85"');
    expect(result).toContain('score="0.90"');
  });

  it('includes memory_id attribute', () => {
    const result = formatInjection([makeResult({ id: 'mem-abc' })]);
    expect(result).toContain('memory_id="mem-abc"');
  });

  it('uses staged mode when config enabled', () => {
    mockConfig.stagedLoadingEnabled = true;
    const result = formatInjection([makeResult({ summary: 'short summary' })]);
    expect(result).toContain('mode="staged"');
    expect(result).toContain('staged="true"');
    expect(result).toContain('short summary');
    expect(result).toContain('expand_hint');
    mockConfig.stagedLoadingEnabled = false;
  });

  it('prefers explicit staged-loading option over module config', () => {
    mockConfig.stagedLoadingEnabled = false;
    const result = formatInjection(
      [makeResult({ summary: 'short summary' })],
      { stagedLoadingEnabled: true },
    );

    expect(result).toContain('mode="staged"');
    expect(result).toContain('short summary');
    expect(result).toContain('expand_hint');
  });

  it('prefers explicit full-loading option over enabled module config', () => {
    mockConfig.stagedLoadingEnabled = true;
    const result = formatInjection(
      [makeResult({ content: 'full content', summary: 'short summary' })],
      { stagedLoadingEnabled: false },
    );

    expect(result).not.toContain('mode="staged"');
    expect(result).not.toContain('expand_hint');
    expect(result).toContain('full content');
    mockConfig.stagedLoadingEnabled = false;
  });

  it('staged mode truncates content when no summary', () => {
    mockConfig.stagedLoadingEnabled = true;
    const longContent = 'A'.repeat(100);
    const result = formatInjection([makeResult({ content: longContent, summary: '' })]);
    expect(result).toContain('A'.repeat(60) + '...');
    mockConfig.stagedLoadingEnabled = false;
  });

  it('formats multiple memories with indexes', () => {
    const results = [
      makeResult({ id: 'a', content: 'first' }),
      makeResult({ id: 'b', content: 'second' }),
    ];
    const result = formatInjection(results);
    expect(result).toContain('index="1"');
    expect(result).toContain('index="2"');
    expect(result).toContain('count="2"');
  });

  it('sorts memories chronologically regardless of input order', () => {
    const results = [
      makeResult({ content: 'Later fact', created_at: new Date('2026-03-01') }),
      makeResult({ content: 'Earlier fact', created_at: new Date('2026-01-01') }),
    ];
    const result = formatInjection(results);
    const earlierIdx = result.indexOf('Earlier fact');
    const laterIdx = result.indexOf('Later fact');
    expect(earlierIdx).toBeLessThan(laterIdx);
  });
});

describe('formatTieredInjection', () => {
  it('returns empty string for no memories', () => {
    expect(formatTieredInjection([], [])).toBe('');
  });

  it('renders each memory at its assigned tier with kind label', () => {
    const memories = [
      makeResult({ id: 'a', summary: 'Summary A', content: 'Full content A' }),
      makeResult({ id: 'b', overview: 'Overview B', content: 'Full content B', memory_type: 'composite' }),
    ];
    const assignments = [
      { memoryId: 'a', tier: 'L0' as const, estimatedTokens: 5 },
      { memoryId: 'b', tier: 'L1' as const, estimatedTokens: 10 },
    ];
    const result = formatTieredInjection(memories, assignments);
    expect(result).toContain('- [2026-01-15] [L0] [atomic] Summary A');
    expect(result).toContain('- [2026-01-15] [L1] [composite] Overview B');
  });

  it('includes compact expandable ids for non-L2 memories', () => {
    const memories = [
      makeResult({ id: 'a' }),
      makeResult({ id: 'b' }),
    ];
    const assignments = [
      { memoryId: 'a', tier: 'L2' as const, estimatedTokens: 50 },
      { memoryId: 'b', tier: 'L0' as const, estimatedTokens: 5 },
    ];
    const result = formatTieredInjection(memories, assignments);
    expect(result).toContain('Expandable IDs: b');
    expect(result).not.toContain('Expandable IDs: a');
  });

  it('omits expandable ids when all memories are L2', () => {
    const memories = [makeResult({ id: 'a' })];
    const assignments = [
      { memoryId: 'a', tier: 'L2' as const, estimatedTokens: 50 },
    ];
    const result = formatTieredInjection(memories, assignments);
    expect(result).not.toContain('Expandable IDs');
  });

  it('avoids XML overhead in tiered mode', () => {
    const memories = [makeResult({ id: 'a' })];
    const assignments = [
      { memoryId: 'a', tier: 'L1' as const, estimatedTokens: 10 },
    ];
    const result = formatTieredInjection(memories, assignments);
    expect(result).not.toContain('<atomicmem_context');
    expect(result).not.toContain('<memory');
  });

  it('retains temporal gap summaries in tiered mode', () => {
    const memories = [
      makeResult({ id: 'met', content: 'James met Samantha.', created_at: new Date('2022-08-10T00:00:00Z') }),
      makeResult({ id: 'move', content: 'James and Samantha decided to move in.', created_at: new Date('2022-10-31T00:00:00Z') }),
    ];
    const assignments = [
      { memoryId: 'met', tier: 'L2' as const, estimatedTokens: 5 },
      { memoryId: 'move', tier: 'L2' as const, estimatedTokens: 5 },
    ];
    const result = formatTieredInjection(memories, assignments);

    expect(result).toContain('Timeline:');
    expect(result).toContain('2022-08-10 → 2022-10-31: ~3 months');
    expect(result).toContain('Key temporal evidence:');
    expect(result).toContain('- 2022-08-10: James met Samantha.');
    expect(result).toContain('- 2022-10-31: James and Samantha decided to move in.');
  });

  it('adds repeated-event endpoints when the query asks for first and second events', () => {
    const memories = [
      makeResult({ id: 'first', content: "Sam had a check-up with Sam's doctor.", created_at: new Date('2023-05-24T00:00:00Z') }),
      makeResult({ id: 'second', content: "Sam had a doctor's appointment.", created_at: new Date('2023-08-15T00:00:00Z') }),
    ];
    const assignments = [
      { memoryId: 'first', tier: 'L2' as const, estimatedTokens: 5 },
      { memoryId: 'second', tier: 'L2' as const, estimatedTokens: 5 },
    ];
    const result = formatTieredInjection(
      memories,
      assignments,
      "How many months lapsed between Sam's first and second doctor's appointment?",
    );

    expect(result).toContain('Repeated event endpoints:');
    expect(result).toContain('elapsed between endpoints: ~3 months (83 days)');
  });

  it('suppresses the generic timeline summary when query-aware temporal evidence is present', () => {
    const memories = [
      makeResult({ id: 'first', content: "Sam had a doctor's appointment as a wake-up call.", created_at: new Date('2023-05-24T00:00:00Z') }),
      makeResult({ id: 'second', content: 'Sam had another doctor appointment after changing diet.', created_at: new Date('2023-08-15T00:00:00Z') }),
      makeResult({ id: 'plan', content: 'Sam decided to make a new appointment in January.', created_at: new Date('2024-01-10T00:00:00Z') }),
    ];
    const assignments = [
      { memoryId: 'first', tier: 'L2' as const, estimatedTokens: 5 },
      { memoryId: 'second', tier: 'L2' as const, estimatedTokens: 5 },
      { memoryId: 'plan', tier: 'L2' as const, estimatedTokens: 5 },
    ];
    const result = formatTieredInjection(
      memories,
      assignments,
      "How many months lapsed between Sam's first and second doctor's appointment?",
    );

    expect(result).toContain('Repeated event endpoints:');
    expect(result).not.toContain('Timeline:');
    expect(result).not.toContain('Key temporal evidence:');
    expect(result).not.toContain('2024-01-10 →');
  });
});

describe('formatSimpleInjection', () => {
  it('returns empty string for no memories', () => {
    expect(formatSimpleInjection([])).toBe('');
  });

  it('formats memories as dash-delimited lines with date and kind', () => {
    const memories = [
      makeResult({ content: 'Fact A', namespace: 'ns-a', created_at: new Date('2026-01-15') }),
      makeResult({ content: 'Fact B', namespace: 'ns-b', created_at: new Date('2026-02-20'), memory_type: 'composite' }),
    ];
    const result = formatSimpleInjection(memories);
    expect(result).toContain('- [2026-01-15] [context] Fact A');
    expect(result).toContain('- [2026-02-20] [context] Fact B');
    const memoryLines = result.split('\n').filter((l) => l.startsWith('- ['));
    expect(memoryLines).toHaveLength(2);
  });

  it('sorts memories chronologically regardless of input order', () => {
    const memories = [
      makeResult({ id: 'c', content: 'Third', created_at: new Date('2026-03-01'), score: 0.9 }),
      makeResult({ id: 'a', content: 'First', created_at: new Date('2026-01-01'), score: 0.7 }),
      makeResult({ id: 'b', content: 'Second', created_at: new Date('2026-02-01'), score: 0.8 }),
    ];
    const result = formatSimpleInjection(memories);
    const firstIdx = result.indexOf('First');
    const secondIdx = result.indexOf('Second');
    const thirdIdx = result.indexOf('Third');
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });

  it('uses timeline-pack format for multi-date namespace groups', () => {
    const memories = [
      makeResult({ id: 'old', content: 'User prefers MongoDB.', namespace: 'database', created_at: new Date('2026-01-10') }),
      makeResult({ id: 'new', content: 'User switched to PostgreSQL.', namespace: 'database', created_at: new Date('2026-03-15') }),
    ];
    const result = formatSimpleInjection(memories);
    expect(result).toContain('### Timeline: database');
    expect(result).toContain('[CURRENT] User switched to PostgreSQL.');
    expect(result).not.toContain('### Subject: database');
  });

  it('uses flat subject format for single-date namespace groups', () => {
    const memories = [
      makeResult({ content: 'Fact A', namespace: 'tools', created_at: new Date('2026-01-15T10:00:00Z') }),
      makeResult({ id: 'mem-2', content: 'Fact B', namespace: 'tools', created_at: new Date('2026-01-15T18:00:00Z') }),
    ];
    const result = formatSimpleInjection(memories);
    expect(result).toContain('### Subject: tools');
    expect(result).not.toContain('### Timeline:');
    expect(result).not.toContain('[CURRENT]');
  });
});

describe('buildInjection query-term visibility', () => {
  it('keeps the exact query term visible in the final temporal injection', () => {
    const result = buildInjection([
      makeResult({
        id: 'workshop',
        content: 'Caroline attended an LGBTQ+ counseling workshop for therapists. '.repeat(12),
        summary: 'Caroline attended LGBTQ+ counseling...',
        overview: 'Caroline attended an LGBTQ+ counseling workshop for therapists.',
        score: 0.4,
      }),
    ], 'What workshop did Caroline attend recently?', 'tiered', 35);

    expect(result.injectionText).toContain('workshop');
    expect(result.injectionText).toContain('Temporal evidence candidates:');
  });
});

describe('computePackagingSignal', () => {
  it('returns zeros for empty input', () => {
    const signal = computePackagingSignal([]);
    expect(signal).toEqual({
      reordered: false,
      episodeCount: 0,
      answerBearingCount: 0,
      contextCount: 0,
      reorderDistance: 0,
    });
  });

  it('detects no reorder when score order matches session-priority order', () => {
    const memories = [
      makeResult({ id: 'a', score: 0.9, content: 'plain fact' }),
    ];
    const signal = computePackagingSignal(memories);
    expect(signal.reordered).toBe(false);
    expect(signal.reorderDistance).toBe(0);
  });

  it('counts distinct episodes', () => {
    const memories = [
      makeResult({ id: 'a', episode_id: 'ep-1' }),
      makeResult({ id: 'b', episode_id: 'ep-1' }),
      makeResult({ id: 'c', episode_id: 'ep-2' }),
    ];
    const signal = computePackagingSignal(memories);
    expect(signal.episodeCount).toBe(2);
  });

  it('counts answer-bearing vs context memories', () => {
    const memories = [
      makeResult({ id: 'a', content: 'The answer is 42.' }),
      makeResult({ id: 'b', content: 'Some background context about the topic' }),
    ];
    const signal = computePackagingSignal(memories);
    expect(signal.answerBearingCount + signal.contextCount).toBe(2);
  });

  it('computes nonzero Kendall tau when packaging reorders', () => {
    const memories = [
      makeResult({ id: 'a', score: 0.9, episode_id: 'ep-1', content: 'context' }),
      makeResult({ id: 'b', score: 0.5, episode_id: 'ep-2', content: 'The answer is yes.' }),
    ];
    const signal = computePackagingSignal(memories);
    if (signal.reordered) {
      expect(signal.reorderDistance).toBeGreaterThan(0);
    }
  });
});
