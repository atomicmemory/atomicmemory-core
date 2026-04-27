/**
 * Unit tests for subject-aware reranking on person-specific queries.
 */

import { describe, expect, it } from 'vitest';
import { applySubjectAwareRanking, extractSubjectQueryAnchors } from '../subject-aware-ranking.js';
import { createSearchResult } from './test-fixtures.js';

function buildResult(id: string, content: string, score: number) {
  return createSearchResult({
    id, content, user_id: 'u1', memory_type: 'fact', network: 'experience',
    created_at: new Date('2023-01-20T00:00:00.000Z'),
    last_accessed_at: new Date('2023-01-20T00:00:00.000Z'),
    score,
  });
}

describe('applySubjectAwareRanking', () => {
  it('boosts memories that mention the requested subject', () => {
    const ranked = applySubjectAwareRanking('When Gina lost her job at Door Dash?', [
      buildResult('generic', 'Since I lost my job at Door Dash, things have been tough.', 0.9),
      buildResult('gina', 'As of January 20, 2023, Gina lost her job at Door Dash.', 0.2),
    ]);

    expect(ranked.subjects).toEqual(['Gina']);
    expect(ranked.keywords).toEqual(['lost', 'job', 'door', 'dash']);
    expect(ranked.protectedFingerprints).toHaveLength(1);
    expect(ranked.results[0].id).toBe('gina');
  });

  it('penalizes memories that mention a conflicting subject', () => {
    const ranked = applySubjectAwareRanking('When Gina lost her job at Door Dash?', [
      buildResult('jon', 'As of January 20, 2023, Jon lost his job as a banker.', 0.8),
      buildResult('gina', 'As of January 20, 2023, Gina lost her job at Door Dash.', 0.4),
    ]);

    expect(ranked.results[0].id).toBe('gina');
    expect(ranked.results[1].id).toBe('jon');
  });

  it('prefers event-matching memories over unrelated same-subject memories', () => {
    const ranked = applySubjectAwareRanking('When Gina lost her job at Door Dash?', [
      buildResult('studio', 'As of January 20, 2023, Gina is starting a dance studio.', 0.9),
      buildResult('loss', 'As of January 20, 2023, Gina lost her job at Door Dash.', 0.2),
    ]);

    expect(ranked.results[0].id).toBe('loss');
  });

  it('extracts subject and event anchors for exact keyword expansion', () => {
    expect(extractSubjectQueryAnchors('When Gina lost her job at Door Dash?'))
      .toEqual(['Gina', 'lost', 'job', 'door', 'dash']);
  });
});
