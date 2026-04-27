/**
 * Vitest configuration for Atomicmemory-core.
 * Disables file-level parallelism to prevent DB integration tests
 * from interfering with each other via shared schema DDL.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    fileParallelism: false,
  },
});
