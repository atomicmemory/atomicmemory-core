/**
 * @file Unit tests for HTTP error envelope schemas.
 *
 * Pins the exact shapes emitted by `handleRouteError` (route-errors.ts:19)
 * and the two special `PUT /v1/memories/config` error paths
 * (memories.ts:269-282). Phase 4's OpenAPI generator consumes these
 * schemas to produce the response components; failing shapes here
 * would quietly produce wrong spec downstream.
 */

import { describe, it, expect } from 'vitest';
import {
  ErrorBasicSchema,
  ErrorConfig400Schema,
  ErrorConfig410Schema,
} from '../errors';

describe('ErrorBasicSchema', () => {
  it('accepts { error: string }', () => {
    expect(ErrorBasicSchema.safeParse({ error: 'bad' }).success).toBe(true);
  });

  it('rejects missing error', () => {
    expect(ErrorBasicSchema.safeParse({}).success).toBe(false);
  });

  it('rejects non-string error', () => {
    expect(ErrorBasicSchema.safeParse({ error: 42 }).success).toBe(false);
  });
});

describe('ErrorConfig400Schema', () => {
  it('accepts { error, detail, rejected: string[] }', () => {
    const ok = ErrorConfig400Schema.safeParse({
      error: 'Provider/model selection is startup-only',
      detail: 'Fields embedding_provider cannot be mutated at runtime',
      rejected: ['embedding_provider'],
    });
    expect(ok.success).toBe(true);
  });

  it('requires rejected to be present', () => {
    expect(
      ErrorConfig400Schema.safeParse({ error: 'x', detail: 'y' }).success,
    ).toBe(false);
  });
});

describe('ErrorConfig410Schema', () => {
  it('accepts { error, detail }', () => {
    expect(
      ErrorConfig410Schema.safeParse({ error: 'x', detail: 'y' }).success,
    ).toBe(true);
  });

  it('rejects missing detail', () => {
    expect(ErrorConfig410Schema.safeParse({ error: 'x' }).success).toBe(false);
  });
});
