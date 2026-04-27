/**
 * Direct coverage for the `/v1` mount prefix on `createApp`.
 *
 * `composed-boot-parity.test.ts` and `research-consumption-seams.test.ts`
 * exercise a handful of memory routes under `/v1`, but neither touches
 * the agents router and neither asserts that the unversioned paths are
 * actually unmounted. This file fills those gaps with a minimal check
 * per route family: one representative memory route, one representative
 * agents route, and an explicit negative assertion that the bare
 * (pre-versioning) paths now return 404.
 *
 * The goal is to catch regressions in the mount prefix itself (typo,
 * accidental dual-mount, dropped `/v1` during a refactor) — not to
 * re-test route logic, which is covered by the router-level test files.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pool } from '../../db/pool.js';
import { setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import { createCoreRuntime } from '../runtime-container.js';
import { createApp } from '../create-app.js';
import { bindEphemeral, type BootedApp } from '../bind-ephemeral.js';

const TEST_USER = 'versioned-mount-user';
const TEST_AGENT = 'versioned-mount-agent';

describe('createApp /v1 mount coverage', () => {
  let booted: BootedApp;

  beforeAll(async () => {
    await setupTestSchema(pool);
    booted = await bindEphemeral(createApp(createCoreRuntime({ pool })));
  });

  afterAll(async () => {
    await booted.close();
    await pool.end();
  });

  it('GET /v1/memories/list is reachable — memory router is mounted under /v1', async () => {
    const res = await fetch(`${booted.baseUrl}/v1/memories/list?user_id=${TEST_USER}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.memories)).toBe(true);
  });

  it('PUT + GET /v1/agents/trust round-trips — agents router is mounted under /v1', async () => {
    const putRes = await fetch(`${booted.baseUrl}/v1/agents/trust`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: TEST_AGENT, user_id: TEST_USER, trust_level: 0.75 }),
    });
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();
    expect(putBody).toEqual({ agent_id: TEST_AGENT, trust_level: 0.75 });

    const getRes = await fetch(
      `${booted.baseUrl}/v1/agents/trust?agent_id=${TEST_AGENT}&user_id=${TEST_USER}`,
    );
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody).toEqual({ agent_id: TEST_AGENT, trust_level: 0.75 });
  });

  it('bare /memories/* and /agents/* return 404 — unversioned paths are NOT mounted', async () => {
    const memRes = await fetch(`${booted.baseUrl}/memories/list?user_id=${TEST_USER}`);
    expect(memRes.status).toBe(404);

    const agentRes = await fetch(
      `${booted.baseUrl}/agents/trust?agent_id=${TEST_AGENT}&user_id=${TEST_USER}`,
    );
    expect(agentRes.status).toBe(404);
  });
});
