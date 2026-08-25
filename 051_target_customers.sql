--
-- Target Message: imported customers
-- One row per customer within an import batch. `attributes` holds whatever
-- extra columns came in the sheet (city, spend, last_order_date, etc.) so the
-- filter engine can query/condition on arbitrary imported fields without
-- needing a schema change per new column. `contact_id` is an optional link
-- if the imported number matches an existing coexistence.contacts row.
--

CREATE TABLE coexistence.target_customers (
    id bigint NOT NULL,
    batch_id bigint NOT NULL,
    contact_number text NOT NULL,
    wa_number text,
    name text,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    contact_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE coexistence.target_customers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE coexistence.target_customers_id_seq OWNED BY coexistence.target_customers.id;

ALTER TABLE ONLY coexistence.target_customers
    ALTER COLUMN id SET DEFAULT nextval('coexistence.target_customers_id_seq'::regclass);

ALTER TABLE ONLY coexistence.target_customers
    ADD CONSTRAINT target_customers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY coexistence.target_customers
    ADD CONSTRAINT target_customers_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES coexistence.target_import_batches(id) ON DELETE CASCADE;

ALTER TABLE ONLY coexistence.target_customers
    ADD CONSTRAINT target_customers_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES coexistence.contacts(id) ON DELETE SET NULL;

CREATE INDEX idx_target_customers_batch_id ON coexistence.target_customers USING btree (batch_id);
CREATE INDEX idx_target_customers_contact_number ON coexistence.target_customers USING btree (contact_number);
CREATE INDEX idx_target_customers_contact_id ON coexistence.target_customers USING btree (contact_id);
CREATE INDEX idx_target_customers_attributes ON coexistence.target_customers USING gin (attributes);
