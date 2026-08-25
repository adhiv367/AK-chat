--
-- Target Message: import batches
-- One row per customer import (CSV/XLSX/manual entry) for the Target Message module.
--

CREATE TABLE coexistence.target_import_batches (
    id bigint NOT NULL,
    name text NOT NULL,
    source_type text DEFAULT 'csv'::text NOT NULL,
    filename text,
    row_count integer DEFAULT 0 NOT NULL,
    uploaded_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT target_import_batches_source_type_check CHECK ((source_type = ANY (ARRAY['csv'::text, 'xlsx'::text, 'manual'::text])))
);

CREATE SEQUENCE coexistence.target_import_batches_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE coexistence.target_import_batches_id_seq OWNED BY coexistence.target_import_batches.id;

ALTER TABLE ONLY coexistence.target_import_batches
    ALTER COLUMN id SET DEFAULT nextval('coexistence.target_import_batches_id_seq'::regclass);

ALTER TABLE ONLY coexistence.target_import_batches
    ADD CONSTRAINT target_import_batches_pkey PRIMARY KEY (id);

ALTER TABLE ONLY coexistence.target_import_batches
    ADD CONSTRAINT target_import_batches_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES coexistence.akchat_users(id) ON DELETE SET NULL;

CREATE INDEX idx_target_import_batches_uploaded_by ON coexistence.target_import_batches USING btree (uploaded_by);
CREATE INDEX idx_target_import_batches_created_at ON coexistence.target_import_batches USING btree (created_at);
