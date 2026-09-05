--
-- Super RAG: Phase 3 — customer interest tracking + personalized follow-ups
-- Purely additive. Nothing existing is touched. Mirrors the shape of
-- coexistence.retarget_customers so the existing send pipeline
-- (routes/broadcasts.js#executeBroadcast, services/retargetSendService.js)
-- can be reused with minimal new code.
--

CREATE TABLE coexistence.customer_interests (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    customer_number text NOT NULL,
    product_sku text NOT NULL,
    product_category text,          -- e.g. 'kurthi', 'salwar', 'maxi'
    product_color text,             -- e.g. 'blue', 'red', 'green'
    -- 'open'        = shown interest, no purchase yet, no match found
    -- 'match_found' = a new matching product was detected, awaiting your review
    -- 'contacted'   = you approved it and the follow-up was sent
    -- 'dismissed'   = you reviewed a match and chose not to send
    status text DEFAULT 'open' NOT NULL,
    matched_sku text,                -- filled in once status = 'match_found'
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_interests_status_check
      CHECK (status IN ('open', 'match_found', 'contacted', 'dismissed'))
);

CREATE SEQUENCE coexistence.customer_interests_id_seq
    START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

ALTER SEQUENCE coexistence.customer_interests_id_seq OWNED BY coexistence.customer_interests.id;

ALTER TABLE ONLY coexistence.customer_interests
    ALTER COLUMN id SET DEFAULT nextval('coexistence.customer_interests_id_seq'::regclass);

ALTER TABLE ONLY coexistence.customer_interests
    ADD CONSTRAINT customer_interests_pkey PRIMARY KEY (id);

CREATE INDEX idx_customer_interests_status ON coexistence.customer_interests USING btree (status, workspace_id);
CREATE INDEX idx_customer_interests_customer ON coexistence.customer_interests USING btree (customer_number, workspace_id);

-- Prevents the same customer+category+color interest being logged over and
-- over from every single suggestion reply — only one OPEN interest per
-- customer/category/color at a time.
CREATE UNIQUE INDEX idx_customer_interests_dedupe
    ON coexistence.customer_interests (workspace_id, customer_number, product_category, product_color)
    WHERE status = 'open';
