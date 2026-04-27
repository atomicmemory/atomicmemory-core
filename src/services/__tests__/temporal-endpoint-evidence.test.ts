/**
 * Unit tests for repeated-event temporal endpoint evidence formatting.
 *
 * Covers the query-aware packaging helper that makes first/second event
 * endpoints explicit for temporal comparison questions.
 */

import { describe, expect, it } from 'vitest';
import { createSearchResult } from './test-fixtures.js';
import { buildRepeatedEventEndpointBlock } from '../temporal-endpoint-evidence.js';

function makeMemory(id: string, content: string, date: string) {
  return createSearchResult({
    id,
    content,
    created_at: new Date(`${date}T00:00:00.000Z`),
  });
}

describe('buildRepeatedEventEndpointBlock', () => {
  it('emits first and second event endpoints for repeated-event queries', () => {
    const block = buildRepeatedEventEndpointBlock([
      makeMemory('first', "Sam had a check-up with Sam's doctor a few days ago.", '2023-05-24'),
      makeMemory('second', "Sam had a doctor's appointment as a wake-up call.", '2023-08-15'),
    ], "How many months lapsed between Sam's first and second doctor's appointment?");

    expect(block).toContain('Repeated event endpoints:');
    expect(block).toContain('first matching event: 2023-05-24');
    expect(block).toContain('second matching event: 2023-08-15');
    expect(block).toContain('elapsed between endpoints: ~3 months (83 days)');
  });

  it('does not emit when only one matching event date is present', () => {
    const block = buildRepeatedEventEndpointBlock([
      makeMemory('only', "Sam had a doctor's appointment as a wake-up call.", '2023-08-15'),
      makeMemory('context', 'Sam considered painting to help de-stress.', '2023-05-24'),
    ], "How many months lapsed between Sam's first and second doctor's appointment?");

    expect(block).toBe('');
  });

  it('does not emit for non-repeated-event temporal queries', () => {
    const block = buildRepeatedEventEndpointBlock([
      makeMemory('first', 'James met Samantha.', '2022-08-10'),
      makeMemory('second', 'James and Samantha decided to move in.', '2022-10-31'),
    ], 'How long did James and Samantha date before moving in?');

    expect(block).toBe('');
  });

  it('rejects partial-match endpoints (one memory hits "doctor", another hits "appointment")', () => {
    const block = buildRepeatedEventEndpointBlock([
      makeMemory('doc-only', 'Sam saw the doctor about a sore knee.', '2023-05-24'),
      makeMemory('appt-only', 'Sam booked a haircut appointment with the salon.', '2023-08-15'),
    ], "How many months between Sam's first and second doctor appointment?");

    expect(block).toBe('');
  });

  it('expands plural query terms back to canonical singular synonyms', () => {
    const block = buildRepeatedEventEndpointBlock([
      makeMemory('first', "Sam had a check-up with Sam's doctor a few days ago.", '2023-05-24'),
      makeMemory('second', "Sam had a doctor's appointment as a wake-up call.", '2023-08-15'),
    ], 'How many weeks elapsed between the first and second appointments?');

    expect(block).toContain('Repeated event endpoints:');
    expect(block).toContain('first matching event: 2023-05-24');
    expect(block).toContain('second matching event: 2023-08-15');
  });
});
