--
-- Super RAG: Phase 2 — conversation memory
-- Two new tables, purely additive. Nothing existing is touched.
--
-- shown_products replaces ai_bridge.py's in-memory `recent_suggestions` dict,
-- which is lost every time Render restarts the app (see the comment in the
-- code itself: "in-memory, resets on restart"). This is a straight fix for
-- that, not a new feature.
--
-- conversation_messages is a slim per-customer message log — separate from
-- AK Chat's own chat_history table, since ai_bridge.py runs as its own
-- service on Render and doesn't have access to AK Chat's contact-resolution
-- logic. Just enough to let the Groq fallback path reference recent context.
--

CREATE TABLE coexistence.shown_products (
    id bigint NOT NULL,
    customer_id text NOT NULL,
    sku text NOT NULL,
    shown_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE coexistence.shown_products_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE coexistence.shown_products_id_seq OWNED BY coexistence.shown_products.id;

ALTER TABLE ONLY coexistence.shown_products
    ALTER COLUMN id SET DEFAULT nextval('coexistence.shown_products_id_seq'::regclass);

ALTER TABLE ONLY coexistence.shown_products
    ADD CONSTRAINT shown_products_pkey PRIMARY KEY (id);

CREATE INDEX idx_shown_products_customer_id ON coexistence.shown_products USING btree (customer_id, shown_at);


CREATE TABLE coexistence.conversation_messages (
    id bigint NOT NULL,
    customer_id text NOT NULL,
    direction text NOT NULL,
    message_text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT conversation_messages_direction_check CHECK ((direction = ANY (ARRAY['incoming'::text, 'outgoing'::text])))
);

CREATE SEQUENCE coexistence.conversation_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE coexistence.conversation_messages_id_seq OWNED BY coexistence.conversation_messages.id;

ALTER TABLE ONLY coexistence.conversation_messages
    ALTER COLUMN id SET DEFAULT nextval('coexistence.conversation_messages_id_seq'::regclass);

ALTER TABLE ONLY coexistence.conversation_messages
    ADD CONSTRAINT conversation_messages_pkey PRIMARY KEY (id);

CREATE INDEX idx_conversation_messages_customer_id ON coexistence.conversation_messages USING btree (customer_id, created_at);
