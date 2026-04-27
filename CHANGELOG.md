# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- **BREAKING**: All API endpoints are now mounted under `/v1/` (e.g. `POST /v1/memories/ingest`, `PUT /v1/agents/trust`). Update clients to prefix requests with `/v1`. The unversioned `/health` liveness probe is unchanged.

## [1.0.0] - 2026-04-15

### Added
- Initial extraction from atomicmemory-research prototype
- Express API server with memory ingest, search, and consolidation endpoints
- Postgres + pgvector storage backend
- Pluggable embedding providers: openai, openai-compatible, ollama, transformers (WASM)
- AUDN mutation engine (Add, Update, Delete, No-op) with fail-closed semantics
- Contradiction-safe claim versioning
- Hybrid retrieval (vector + BM25/FTS)
- Tiered context packaging
- Entity graph with spreading activation
- Docker and Railway deployment support
- 869 tests across 79 test files
- CI with GitHub Actions (typecheck, fallow, tests)
- Contributor docs (CONTRIBUTING.md, issue/PR templates)
