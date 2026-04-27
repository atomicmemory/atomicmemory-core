/**
 * Atomicmemory-core Schema — active memory projection plus contradiction-safe
 * claim/version history. Idempotent: safe to re-run on every startup.
 *
 * IMPORTANT: This schema uses CREATE TABLE/INDEX IF NOT EXISTS so it can run
 * on every app startup without data loss. Adding new columns to existing tables
 * requires explicit ALTER TABLE ... ADD COLUMN IF NOT EXISTS statements — a
 * plain column definition inside CREATE TABLE IF NOT EXISTS will be silently
 * ignored if the table already exists.
 */

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  source_site TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  session_id TEXT,
  workspace_id UUID DEFAULT NULL,
  agent_id UUID DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_episodes_user_site ON episodes (user_id, source_site);

CREATE TABLE IF NOT EXISTS canonical_memory_objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  object_family TEXT NOT NULL
    CHECK (object_family IN ('ingested_fact')),
  payload_format TEXT NOT NULL DEFAULT 'json',
  canonical_payload JSONB NOT NULL,
  provenance JSONB NOT NULL DEFAULT '{}',
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lineage JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_canonical_memory_objects_user_created
  ON canonical_memory_objects (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding vector({{EMBEDDING_DIMENSIONS}}) NOT NULL,
  memory_type TEXT NOT NULL DEFAULT 'semantic'
    CHECK (memory_type IN ('episodic', 'semantic', 'procedural', 'composite')),
  importance REAL NOT NULL DEFAULT 0.5
    CHECK (importance >= 0.0 AND importance <= 1.0),
  source_site TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  episode_id UUID,  -- FK to episodes removed: non-transactional writes with pgvector can't guarantee ordering
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'needs_clarification')),
  metadata JSONB DEFAULT '{}',
  keywords TEXT NOT NULL DEFAULT '',
  namespace TEXT DEFAULT NULL,
  summary TEXT NOT NULL DEFAULT '',        -- L0: abstract/headline (~100 tokens)
  overview TEXT NOT NULL DEFAULT '',       -- L1: condensed overview (~1000 tokens)
  trust_score REAL NOT NULL DEFAULT 1.0   -- Phase 3: source + content trust (0.0–1.0)
    CHECK (trust_score >= 0.0 AND trust_score <= 1.0),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- when the conversation actually happened (vs created_at = DB insertion time)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  access_count INTEGER NOT NULL DEFAULT 0,
  expired_at TIMESTAMPTZ DEFAULT NULL,   -- Phase 4: set when superseded (temporal invalidation)
  deleted_at TIMESTAMPTZ DEFAULT NULL,
  -- Phase 7: 4-network memory separation (Hindsight-inspired)
  network TEXT NOT NULL DEFAULT 'experience'
    CHECK (network IN ('world', 'experience', 'opinion', 'observation')),
  opinion_confidence REAL DEFAULT NULL
    CHECK (opinion_confidence IS NULL OR (opinion_confidence >= 0.0 AND opinion_confidence <= 1.0)),
  observation_subject TEXT DEFAULT NULL,
  -- Phase 8: deferred AUDN reconciliation
  deferred_audn BOOLEAN NOT NULL DEFAULT false,
  audn_candidates JSONB DEFAULT NULL,  -- serialized candidates for background reconciliation
  -- Phase 9: workspace / multi-agent scoping
  workspace_id UUID DEFAULT NULL,
  agent_id UUID DEFAULT NULL,
  visibility TEXT DEFAULT NULL
    CHECK (visibility IS NULL OR visibility IN ('agent_only', 'restricted', 'workspace'))
);

CREATE INDEX IF NOT EXISTS idx_memories_deferred_audn ON memories (user_id)
  WHERE deferred_audn = true AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_user_site ON memories (user_id, source_site)
  WHERE deleted_at IS NULL AND expired_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_memories_user_created ON memories (user_id, created_at)
  WHERE deleted_at IS NULL AND expired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_embedding ON memories
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- Full-text search: indexes both paraphrased content AND extracted keywords.
-- Keywords preserve proper nouns, dates, and project names that paraphrasing loses.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', content) || to_tsvector('simple', keywords)
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_memories_fts ON memories USING gin (search_vector)
  WHERE deleted_at IS NULL AND expired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories (namespace)
  WHERE deleted_at IS NULL AND expired_at IS NULL AND namespace IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_network ON memories (user_id, network)
  WHERE deleted_at IS NULL AND expired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_workspace ON memories (workspace_id, agent_id)
  WHERE deleted_at IS NULL AND expired_at IS NULL AND workspace_id IS NOT NULL;

-- Visibility grants for restricted memories (workspace scoping)
CREATE TABLE IF NOT EXISTS memory_visibility_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  grantee_agent_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (memory_id, grantee_agent_id)
);

CREATE INDEX IF NOT EXISTS idx_visibility_grants_memory ON memory_visibility_grants (memory_id);
CREATE INDEX IF NOT EXISTS idx_visibility_grants_agent ON memory_visibility_grants (grantee_agent_id);

CREATE INDEX IF NOT EXISTS idx_memories_observation_subject ON memories (user_id, observation_subject)
  WHERE network = 'observation' AND deleted_at IS NULL AND expired_at IS NULL;

-- Workspace columns added via ALTER TABLE at the bottom of this file (Phase 5 Step 9).
CREATE TABLE IF NOT EXISTS memory_atomic_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  parent_memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  fact_text TEXT NOT NULL,
  embedding vector({{EMBEDDING_DIMENSIONS}}) NOT NULL,
  fact_type TEXT NOT NULL DEFAULT 'knowledge'
    CHECK (fact_type IN ('preference', 'project', 'knowledge', 'person', 'plan')),
  importance REAL NOT NULL DEFAULT 0.5
    CHECK (importance >= 0.0 AND importance <= 1.0),
  source_site TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  episode_id UUID,
  keywords TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_atomic_facts_parent ON memory_atomic_facts (parent_memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_atomic_facts_user ON memory_atomic_facts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_atomic_facts_embedding ON memory_atomic_facts
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

ALTER TABLE memory_atomic_facts ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', fact_text) || to_tsvector('simple', keywords)
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_memory_atomic_facts_fts ON memory_atomic_facts USING gin (search_vector);

-- Workspace columns added via ALTER TABLE at the bottom of this file (Phase 5 Step 9).
CREATE TABLE IF NOT EXISTS memory_foresight (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  parent_memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding vector({{EMBEDDING_DIMENSIONS}}) NOT NULL,
  foresight_type TEXT NOT NULL DEFAULT 'plan'
    CHECK (foresight_type IN ('plan', 'goal', 'scheduled', 'expected_state')),
  source_site TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  episode_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}',
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_foresight_parent ON memory_foresight (parent_memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_foresight_user_valid ON memory_foresight (user_id, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_memory_foresight_embedding ON memory_foresight
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- Observation regeneration trigger (async, decoupled from ingest)
CREATE TABLE IF NOT EXISTS observation_dirty (
  user_id   TEXT NOT NULL,
  subject   TEXT NOT NULL,
  marked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, subject)
);

-- SCOPE_TODO: Claims are intentionally user-scoped — AUDN contradiction resolution
-- is cross-workspace. Workspace-scoped claims are a Phase 8+ concern.
CREATE TABLE IF NOT EXISTS memory_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  claim_type TEXT NOT NULL DEFAULT 'fact',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'deleted')),
  current_version_id UUID DEFAULT NULL,
  slot_key TEXT DEFAULT NULL,
  subject_entity_id UUID DEFAULT NULL,
  relation_type TEXT DEFAULT NULL
    CHECK (relation_type IS NULL OR relation_type IN (
      'uses', 'works_on', 'works_at', 'located_in', 'knows',
      'prefers', 'created', 'belongs_to', 'studies', 'manages'
    )),
  object_entity_id UUID DEFAULT NULL,
  valid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invalid_at TIMESTAMPTZ DEFAULT NULL,
  invalidated_at TIMESTAMPTZ DEFAULT NULL,
  invalidated_by_version_id UUID DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (invalid_at IS NULL OR invalid_at >= valid_at)
);

CREATE INDEX IF NOT EXISTS idx_memory_claims_user ON memory_claims (user_id);
CREATE INDEX IF NOT EXISTS idx_memory_claims_user_valid
  ON memory_claims (user_id, valid_at, invalid_at);
CREATE INDEX IF NOT EXISTS idx_memory_claims_user_slot
  ON memory_claims (user_id, slot_key)
  WHERE slot_key IS NOT NULL;

-- SCOPE_TODO: Claim versions inherit user-scoped claim ownership — same rationale as memory_claims.
CREATE TABLE IF NOT EXISTS memory_claim_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES memory_claims(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  memory_id UUID UNIQUE REFERENCES memories(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  embedding vector({{EMBEDDING_DIMENSIONS}}) NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5
    CHECK (importance >= 0.0 AND importance <= 1.0),
  source_site TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  episode_id UUID /* REFERENCES episodes(id) ON DELETE SET NULL -- removed for non-transactional pgvector compat */,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to TIMESTAMPTZ DEFAULT NULL,
  superseded_by_version_id UUID DEFAULT NULL,
  mutation_type TEXT DEFAULT NULL
    CHECK (mutation_type IS NULL OR mutation_type IN ('add', 'update', 'supersede', 'delete', 'clarify')),
  mutation_reason TEXT DEFAULT NULL,
  previous_version_id UUID DEFAULT NULL,
  actor_model TEXT DEFAULT NULL,
  contradiction_confidence REAL DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_claim_versions_claim ON memory_claim_versions (claim_id);
CREATE INDEX IF NOT EXISTS idx_memory_claim_versions_user_valid
  ON memory_claim_versions (user_id, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_memory_claim_versions_claim_valid
  ON memory_claim_versions (claim_id, valid_from, valid_to);

CREATE INDEX IF NOT EXISTS idx_memory_claim_versions_embedding ON memory_claim_versions
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

CREATE TABLE IF NOT EXISTS memory_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_version_id UUID NOT NULL
    REFERENCES memory_claim_versions(id) ON DELETE CASCADE,
  episode_id UUID /* REFERENCES episodes(id) ON DELETE SET NULL -- removed for non-transactional pgvector compat */,
  memory_id UUID REFERENCES memories(id) ON DELETE SET NULL,
  quote_text TEXT NOT NULL DEFAULT '',
  speaker TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_evidence_version ON memory_evidence (claim_version_id);

-- Memory links for 1-hop link expansion (Phase 2, A-MEM style)
-- Bidirectional: stored as (source_id, target_id) where source_id < target_id
-- to avoid duplicate pairs. Query both directions at read time.
CREATE TABLE IF NOT EXISTS memory_links (
  source_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  similarity REAL NOT NULL CHECK (similarity >= 0.0 AND similarity <= 1.0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links (target_id);

-- Phase 5: Entity graph — structured entities extracted from memories
-- SCOPE_TODO: Entities are user-global (entity dedup crosses workspace boundaries).
CREATE TABLE IF NOT EXISTS entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  entity_type TEXT NOT NULL
    CHECK (entity_type IN ('person', 'tool', 'project', 'organization', 'place', 'concept')),
  embedding vector({{EMBEDDING_DIMENSIONS}}) NOT NULL,
  alias_names TEXT[] NOT NULL DEFAULT '{}',
  normalized_alias_names TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entities_user ON entities (user_id);
CREATE INDEX IF NOT EXISTS idx_entities_user_type ON entities (user_id, entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_user_normalized
  ON entities (user_id, entity_type, normalized_name);
CREATE INDEX IF NOT EXISTS idx_entities_embedding ON entities
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- Junction table: many memories ↔ many entities
CREATE TABLE IF NOT EXISTS memory_entities (
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (memory_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities (entity_id);

-- Entity relations: typed, directed edges between entities with temporal validity
CREATE TABLE IF NOT EXISTS entity_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  source_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL
    CHECK (relation_type IN (
      'uses', 'works_on', 'works_at', 'located_in', 'knows',
      'prefers', 'created', 'belongs_to', 'studies', 'manages'
    )),
  source_memory_id UUID REFERENCES memories(id) ON DELETE SET NULL,
  confidence REAL NOT NULL DEFAULT 1.0
    CHECK (confidence >= 0.0 AND confidence <= 1.0),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_entity_id, target_entity_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_entity_relations_source ON entity_relations (source_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_relations_target ON entity_relations (target_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_relations_user ON entity_relations (user_id);

-- Phase 6: Lessons store — detected failure patterns for pre-action defense (A-MemGuard)
-- SCOPE_TODO: Lessons are user-global (failure patterns are personal, not per-workspace).
CREATE TABLE IF NOT EXISTS lessons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  lesson_type TEXT NOT NULL
    CHECK (lesson_type IN (
      'injection_blocked', 'false_memory', 'contradiction_pattern',
      'user_reported', 'consensus_violation', 'trust_violation'
    )),
  pattern TEXT NOT NULL,
  embedding vector({{EMBEDDING_DIMENSIONS}}) NOT NULL,
  source_memory_ids UUID[] NOT NULL DEFAULT '{}',
  source_query TEXT DEFAULT NULL,
  severity TEXT NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lessons_user_active ON lessons (user_id) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_lessons_type ON lessons (user_id, lesson_type);
CREATE INDEX IF NOT EXISTS idx_lessons_embedding ON lessons
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- Temporal metadata index (observed_at separates conversation time from DB insertion time)
CREATE INDEX IF NOT EXISTS idx_memories_user_observed ON memories (user_id, observed_at)
  WHERE deleted_at IS NULL AND expired_at IS NULL;

-- Agent trust levels for multi-agent conflict resolution (from hive-mind Phase 4)
CREATE TABLE IF NOT EXISTS agent_trust (
  agent_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  trust_level REAL NOT NULL DEFAULT 0.5
    CHECK (trust_level >= 0.0 AND trust_level <= 1.0),
  display_name TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_trust_user ON agent_trust (user_id);

-- Conflict tracking for CLARIFY escalation and auto-resolution
CREATE TABLE IF NOT EXISTS memory_conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  new_memory_id UUID REFERENCES memories(id) ON DELETE SET NULL,
  existing_memory_id UUID REFERENCES memories(id) ON DELETE SET NULL,
  new_agent_id TEXT DEFAULT NULL,
  existing_agent_id TEXT DEFAULT NULL,
  new_trust_level REAL DEFAULT NULL,
  existing_trust_level REAL DEFAULT NULL,
  contradiction_confidence REAL NOT NULL DEFAULT 0.5,
  clarification_note TEXT DEFAULT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'auto_resolved', 'resolved_new', 'resolved_existing', 'resolved_both')),
  resolution_policy TEXT DEFAULT NULL,
  resolved_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  auto_resolve_after TIMESTAMPTZ DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_conflicts_user_status ON memory_conflicts (user_id, status)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_conflicts_auto_resolve ON memory_conflicts (auto_resolve_after)
  WHERE status = 'open' AND auto_resolve_after IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Phase 5 Step 9: Add workspace scope columns to representation tables.
-- These are idempotent ALTER TABLE statements that run safely on every startup.
-- NULL means the row was created by user-scoped ingest (pre-Phase 5).
-- ---------------------------------------------------------------------------

ALTER TABLE memory_atomic_facts ADD COLUMN IF NOT EXISTS workspace_id UUID DEFAULT NULL;
ALTER TABLE memory_atomic_facts ADD COLUMN IF NOT EXISTS agent_id UUID DEFAULT NULL;

ALTER TABLE memory_foresight ADD COLUMN IF NOT EXISTS workspace_id UUID DEFAULT NULL;
ALTER TABLE memory_foresight ADD COLUMN IF NOT EXISTS agent_id UUID DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_atomic_facts_workspace
  ON memory_atomic_facts (workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_foresight_workspace
  ON memory_foresight (workspace_id) WHERE workspace_id IS NOT NULL;
