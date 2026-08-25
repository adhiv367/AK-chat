--
-- Super RAG: Phase 0 — foundation
-- Enables pgvector and creates the knowledge base tables (documents + chunks).
-- Purely additive: no existing table is touched, no existing code path reads
-- from these tables yet. Safe to run against production.
--

CREATE EXTENSION IF NOT EXISTS vector;

-- One row per uploaded document (a PDF, FAQ page, product sheet, policy doc, etc.)
CREATE TABLE coexistence.knowledge_documents (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    source_type text DEFAULT 'manual'::text NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE coexistence.knowledge_documents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE coexistence.knowledge_documents_id_seq OWNED BY coexistence.knowledge_documents.id;

ALTER TABLE ONLY coexistence.knowledge_documents
    ALTER COLUMN id SET DEFAULT nextval('coexistence.knowledge_documents_id_seq'::regclass);

ALTER TABLE ONLY coexistence.knowledge_documents
    ADD CONSTRAINT knowledge_documents_pkey PRIMARY KEY (id);

CREATE INDEX idx_knowledge_documents_workspace_id ON coexistence.knowledge_documents USING btree (workspace_id);

-- One row per chunk of a document, with its embedding vector, for semantic search.
-- 1536 dims fits OpenAI text-embedding-3-small and Gemini text-embedding-004.
CREATE TABLE coexistence.knowledge_chunks (
    id bigint NOT NULL,
    document_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    chunk_text text NOT NULL,
    embedding vector(1536),
    token_count integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE coexistence.knowledge_chunks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE coexistence.knowledge_chunks_id_seq OWNED BY coexistence.knowledge_chunks.id;

ALTER TABLE ONLY coexistence.knowledge_chunks
    ALTER COLUMN id SET DEFAULT nextval('coexistence.knowledge_chunks_id_seq'::regclass);

ALTER TABLE ONLY coexistence.knowledge_chunks
    ADD CONSTRAINT knowledge_chunks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY coexistence.knowledge_chunks
    ADD CONSTRAINT knowledge_chunks_document_id_fkey FOREIGN KEY (document_id) REFERENCES coexistence.knowledge_documents(id) ON DELETE CASCADE;

CREATE INDEX idx_knowledge_chunks_workspace_id ON coexistence.knowledge_chunks USING btree (workspace_id);
CREATE INDEX idx_knowledge_chunks_document_id ON coexistence.knowledge_chunks USING btree (document_id);

-- Approximate nearest-neighbor index for fast semantic search.
-- (Built after you have some rows in the table ideally, but fine to create now — it's a no-op on an empty table.)
CREATE INDEX idx_knowledge_chunks_embedding ON coexistence.knowledge_chunks
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
