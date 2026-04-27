# Atomicmemory Core

[![CI](https://github.com/atomicmemory/Atomicmemory-core/actions/workflows/ci.yml/badge.svg)](https://github.com/atomicmemory/Atomicmemory-core/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Open-source memory engine for AI applications and agents.

Docker-deployable memory backend with durable context, semantic retrieval, and memory mutation (AUDN: Add, Update, Delete, No-op).

**Docs:** [docs.atomicmemory.ai](https://docs.atomicmemory.ai)

## Features

- **Semantic ingest** — extract structured facts from conversations with contradiction detection
- **Hybrid retrieval** — vector similarity + BM25/FTS with RRF fusion
- **AUDN mutation** — Add, Update, Delete, No-op decisions with fail-closed integrity
- **Claim versioning** — temporal lineage tracking with supersession and invalidation
- **Tiered context packaging** — L0/L1/L2 compression for token-efficient retrieval
- **Entity graph** — spreading activation over extracted entities
- **Pluggable embeddings** — openai, openai-compatible, ollama, transformers (local WASM)
- **Docker-deployable** — one-command deployment with Postgres + pgvector

## What This Is Not

- Not a benchmark suite — eval harnesses live in a separate research repo
- Not an SDK or client library — this is the server/backend. For a TypeScript
  client, see [atomicmemory-sdk](https://github.com/atomicmemory/atomicmemory-sdk) (coming soon)

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/atomicmemory/Atomicmemory-core.git
cd Atomicmemory-core
cp .env.example .env
# Edit .env with your OPENAI_API_KEY and DATABASE_URL
docker compose up --build
```

### Local development

```bash
npm install
cp .env.example .env
# Edit .env — requires a running Postgres instance with pgvector
npm run migrate
npm run dev
```

Health check: `curl http://localhost:3050/health`

## API Overview

### Core endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/v1/memories/ingest` | Full ingest with extraction and AUDN |
| `POST` | `/v1/memories/ingest/quick` | Fast ingest (embedding dedup only) |
| `POST` | `/v1/memories/search` | Semantic search with hybrid retrieval |
| `POST` | `/v1/memories/search/fast` | Fast vector-only search |
| `GET` | `/v1/memories/list` | List memories with optional filters |
| `GET` | `/v1/memories/:id` | Get a single memory |
| `DELETE` | `/v1/memories/:id` | Soft-delete a memory |
| `POST` | `/v1/memories/consolidate` | Consolidate and compress memories |

See the [HTTP API reference](https://docs.atomicmemory.ai/api-reference/http/conventions) for full endpoint documentation.

### Per-request config override

Search and ingest routes accept an optional `config_override` body field that
overlays the startup `RuntimeConfig` for that single request. Useful for
A/B tests, experiments, or dial-turning without restarting the server.

```bash
curl -X POST http://localhost:3050/v1/memories/search \
  -H 'Content-Type: application/json' \
  -d '{
    "user_id": "alice",
    "query": "what stack does alice use?",
    "config_override": { "hybridSearchEnabled": true, "maxSearchResults": 20 }
  }'
```

Responses from requests carrying an override emit four observability headers:

| Header | Emitted when | Value |
|--------|--------------|-------|
| `X-Atomicmem-Config-Override-Applied` | Override present | `true` |
| `X-Atomicmem-Effective-Config-Hash` | Override present | `sha256:<hex>` of the merged config |
| `X-Atomicmem-Config-Override-Keys` | Override present | Comma-joined sorted override keys |
| `X-Atomicmem-Unknown-Override-Keys` | One or more keys don't match a current `RuntimeConfig` field | Comma-joined sorted unknown keys |

The schema is permissive — unknown keys don't 400. They ride through on the
effective config and surface via the fourth header plus a server-side warning
log, so callers catch typos without gating new runtime fields behind a schema
release.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Postgres connection string (must have pgvector extension) |
| `OPENAI_API_KEY` | OpenAI API key (when using `openai` embedding/LLM provider) |
| `PORT` | Server port (default: 3050) |

### Embedding Provider

Set `EMBEDDING_PROVIDER` to choose your embedding backend:

| Value | Description |
|-------|-------------|
| `openai` | OpenAI Embeddings API (default) |
| `openai-compatible` | Any OpenAI-compatible API (recommended for self-hosters) |
| `ollama` | Local Ollama instance |
| `transformers` | Local WASM/ONNX inference via @huggingface/transformers |
| `voyage` | Voyage AI embeddings with separate document/query models |

For self-hosted deployments, `openai-compatible` is recommended as it works with any OpenAI-compatible embedding service.

In-process benchmark harnesses can avoid editing env files by passing a
composition-time config to the runtime:

```ts
import { config, createCoreRuntime } from '@atomicmemory/atomicmemory-core';

const runtime = createCoreRuntime({
  pool,
  config: {
    ...config,
    embeddingProvider: 'voyage',
    embeddingDimensions: 1024,
    voyageApiKey,
    voyageDocumentModel: 'voyage-4-large',
    voyageQueryModel: 'voyage-4-lite',
  },
});
```

Provider/model fields are still startup-only for a given runtime. Use a new
isolated runtime or process for each embedding configuration.

See `.env.example` for the full list of configuration options.

## Deployment

### Platform-specific deployment

See `deploy/` for platform-specific configs (Railway, etc.). Copy the relevant config to your project root before deploying.

### Docker

```bash
docker compose up --build
```

The compose file includes Postgres with pgvector. The app container runs migrations on startup, then starts the server.

## Architecture

```
src/
  routes/       # Express route handlers
  services/     # Business logic (extraction, retrieval, packaging)
  db/           # Repository layer, schema, migrations
  adapters/     # Type contracts for external integrations
  config.ts     # Environment-driven configuration
  server.ts     # Express app bootstrap
```

Storage: Postgres + pgvector. Retrieval: hybrid (vector + BM25/FTS). Mutation: contradiction-safe AUDN with claim versioning.

## Development

```bash
npm test                    # Run unit tests
npm run test:deployment     # Deployment config tests
npm run test:docker-smoke   # Docker smoke test
npm run test:schema         # Schema regression fuzzing (Schemathesis)
npm run migrate:test        # Run migrations against test DB
```

### Schema regression tests

Property-based fuzzing of `openapi.yaml` via Schemathesis runs on every
PR (`schema-fuzz` job in `.github/workflows/ci.yml`). Catches wire-shape
regressions where a route's response drifts from its declared schema.
See [`tests/schema/`](tests/schema/) for how to run locally and how to
read the report.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, workflow, and code style expectations.

## License

[Apache-2.0](LICENSE)
