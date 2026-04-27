#!/usr/bin/env tsx
/**
 * @file OpenAPI spec generator.
 *
 * Walks the registry assembled in `src/schemas/openapi.ts` and writes
 * `openapi.yaml` + `openapi.json` at repo root. Emission is
 * deterministic (sorted keys, stable info block) so CI's
 * `git diff --exit-code` check fires only on real spec changes, not
 * on incidental key-order reshuffles.
 *
 * Run via `npm run generate:openapi`. Also runs as part of
 * `prepublishOnly` so the published tarball always contains the
 * current spec.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { stringify as yamlStringify } from 'yaml';
import {
  API_DESCRIPTION,
  API_TITLE,
  API_VERSION,
  buildRegistry,
} from '../src/schemas/openapi.js';

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

function generate(): void {
  const registry = buildRegistry();
  const generator = new OpenApiGeneratorV31(registry.definitions);

  const document = generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: API_TITLE,
      version: API_VERSION,
      description: API_DESCRIPTION,
      license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' },
    },
    servers: [
      { url: 'http://localhost:3050', description: 'Local development server' },
    ],
  });

  const sorted = sortKeysDeep(document);

  const repoRoot = resolve(import.meta.dirname, '..');
  const jsonPath = resolve(repoRoot, 'openapi.json');
  const yamlPath = resolve(repoRoot, 'openapi.yaml');

  writeFileSync(jsonPath, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
  writeFileSync(
    yamlPath,
    yamlStringify(sorted, { sortMapEntries: true, lineWidth: 0 }),
    'utf8',
  );

  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${yamlPath}`);
}

generate();
