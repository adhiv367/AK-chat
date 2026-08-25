--
-- Target Message: link broadcasts back to the import batch/filter that produced them.
-- Purely additive - existing broadcasts rows get source = 'manual' and
-- target_batch_id = NULL, so Bulk Message and the send pipeline are unaffected.
--

ALTER TABLE coexistence.broadcasts
    ADD COLUMN source text DEFAULT 'manual'::text NOT NULL;

ALTER TABLE coexistence.broadcasts
    ADD COLUMN target_batch_id bigint;

ALTER TABLE coexistence.broadcasts
    ADD CONSTRAINT broadcasts_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'target'::text])));

ALTER TABLE ONLY coexistence.broadcasts
    ADD CONSTRAINT broadcasts_target_batch_id_fkey FOREIGN KEY (target_batch_id) REFERENCES coexistence.target_import_batches(id) ON DELETE SET NULL;

CREATE INDEX idx_broadcasts_target_batch_id ON coexistence.broadcasts USING btree (target_batch_id);
