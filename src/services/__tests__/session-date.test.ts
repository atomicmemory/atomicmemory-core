/**
 * Unit tests for transcript session-date parsing.
 */

import { describe, expect, it } from 'vitest';
import { extractSessionTimestamp, parseSessionDate, resolveSessionDate } from '../session-date.js';

describe('session-date helpers', () => {
  it('extracts the first-line session timestamp', () => {
    const timestamp = extractSessionTimestamp('[Session date: 2023-08-14T10:00:00Z]\nUser: hello');

    expect(timestamp).toBe('2023-08-14T10:00:00Z');
  });

  it('parses valid session dates', () => {
    const parsed = parseSessionDate('[Session date: 2023-08-14]\nUser: hello');

    expect(parsed?.toISOString()).toBe('2023-08-14T00:00:00.000Z');
  });

  it('prefers explicit timestamps over transcript headers', () => {
    const explicit = new Date('2026-01-01T00:00:00.000Z');
    const resolved = resolveSessionDate(explicit, '[Session date: 2023-08-14]\nUser: hello');

    expect(resolved).toBe(explicit);
  });
});
