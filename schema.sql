--
-- PostgreSQL database dump
--

\restrict 6WnX4zNxkvtDEodO3QblnblWyberBmKhxC1UsgERlXLPhdFAxLHvPMO6jQfne77

-- Dumped from database version 15.18 (Debian 15.18-1.pgdg13+1)
-- Dumped by pg_dump version 15.18 (Debian 15.18-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: coexistence; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA coexistence;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ai_models; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.ai_models (
    id integer NOT NULL,
    provider text NOT NULL,
    label text,
    api_key_encrypted text NOT NULL,
    available_models jsonb DEFAULT '[]'::jsonb NOT NULL,
    last_synced_at timestamp with time zone,
    last_sync_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    enabled_models jsonb,
    base_url text
);


--
-- Name: ai_models_id_seq; Type: SEQUENCE; Schema: coexistence; Owner: -
--

CREATE SEQUENCE coexistence.ai_models_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ai_models_id_seq; Type: SEQUENCE OWNED BY; Schema: coexistence; Owner: -
--

ALTER SEQUENCE coexistence.ai_models_id_seq OWNED BY coexistence.ai_models.id;


--
-- Name: automation_execution_steps; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.automation_execution_steps (
    id bigint NOT NULL,
    execution_id bigint NOT NULL,
    node_id text NOT NULL,
    node_type character varying(32) NOT NULL,
    node_name text,
    input_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    output_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    status character varying(16) DEFAULT 'running'::character varying NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    wa_message_id text,
    wa_message_status character varying(16),
    CONSTRAINT automation_execution_steps_status_check CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying, 'success'::character varying, 'error'::character varying, 'skipped'::character varying])::text[])))
);


--
-- Name: automation_execution_steps_id_seq; Type: SEQUENCE; Schema: coexistence; Owner: -
--

CREATE SEQUENCE coexistence.automation_execution_steps_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: automation_execution_steps_id_seq; Type: SEQUENCE OWNED BY; Schema: coexistence; Owner: -
--

ALTER SEQUENCE coexistence.automation_execution_steps_id_seq OWNED BY coexistence.automation_execution_steps.id;


--
-- Name: automation_executions; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.automation_executions (
    id bigint NOT NULL,
    automation_id bigint NOT NULL,
    status character varying(16) DEFAULT 'running'::character varying NOT NULL,
    trigger_type character varying(32) NOT NULL,
    trigger_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    contact_number text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    awaiting_node_id text,
    paused_at timestamp with time zone,
    expires_at timestamp with time zone,
    wa_number text,
    CONSTRAINT automation_executions_status_check CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying, 'success'::character varying, 'error'::character varying, 'cancelled'::character varying, 'paused'::character varying])::text[])))
);


--
-- Name: automation_executions_id_seq; Type: SEQUENCE; Schema: coexistence; Owner: -
--

CREATE SEQUENCE coexistence.automation_executions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: automation_executions_id_seq; Type: SEQUENCE OWNED BY; Schema: coexistence; Owner: -
--

ALTER SEQUENCE coexistence.automation_executions_id_seq OWNED BY coexistence.automation_executions.id;


--
-- Name: broadcast_logs; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.broadcast_logs (
    id integer NOT NULL,
    broadcast_id integer NOT NULL,
    action character varying(16) NOT NULL,
    sent_to text NOT NULL,
    status character varying(16) DEFAULT 'PENDING'::character varying NOT NULL,
    sent_at timestamp with time zone DEFAULT now(),
    wa_message_id text,
    error_message text,
    CONSTRAINT broadcast_logs_action_check CHECK (((action)::text = ANY ((ARRAY['TEST'::character varying, 'BROADCAST'::character varying])::text[]))),
    CONSTRAINT broadcast_logs_status_check CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'SENT'::character varying, 'FAILED'::character varying, 'sent'::character varying, 'delivered'::character varying, 'read'::character varying, 'failed'::character varying])::text[])))
);


--
-- Name: broadcast_logs_id_seq; Type: SEQUENCE; Schema: coexistence; Owner: -
--

CREATE SEQUENCE coexistence.broadcast_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: broadcast_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: coexistence; Owner: -
--

ALTER SEQUENCE coexistence.broadcast_logs_id_seq OWNED BY coexistence.broadcast_logs.id;


--
-- Name: broadcasts; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.broadcasts (
    id integer NOT NULL,
    from_number text NOT NULL,
    recipient_numbers jsonb DEFAULT '[]'::jsonb NOT NULL,
    template_id integer,
    status character varying(16) DEFAULT 'DRAFT'::character varying NOT NULL,
    test_number text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    name text,
    variable_mapping jsonb DEFAULT '{}'::jsonb,
    message_type text DEFAULT 'template'::text NOT NULL,
    body text,
    url text,
    media_library_id bigint,
    caption text,
    scheduled_at timestamp with time zone,
    CONSTRAINT broadcasts_status_check CHECK (((status)::text = ANY ((ARRAY['DRAFT'::character varying, 'SCHEDULED'::character varying, 'SENDING'::character varying, 'SENT'::character varying, 'PARTIAL'::character varying, 'FAILED'::character varying])::text[])))
);


--
-- Name: broadcasts_id_seq; Type: SEQUENCE; Schema: coexistence; Owner: -
--

CREATE SEQUENCE coexistence.broadcasts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: broadcasts_id_seq; Type: SEQUENCE OWNED BY; Schema: coexistence; Owner: -
--

ALTER SEQUENCE coexistence.broadcasts_id_seq OWNED BY coexistence.broadcasts.id;


--
-- Name: categories; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.categories (
    id text NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: chat_history; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.chat_history (
    id bigint NOT NULL,
    message_id text NOT NULL,
    phone_number_id text,
    wa_number text NOT NULL,
    contact_number text NOT NULL,
    to_number text,
    direction text NOT NULL,
    message_type text DEFAULT 'unknown'::text NOT NULL,
    message_body text,
    raw_payload jsonb,
    media_url text,
    media_mime_type text,
    status text DEFAULT 'received'::text,
    "timestamp" timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    media_storage_path text,
    media_status text,
    media_size_bytes bigint,
    media_filename text,
    media_error text,
    media_downloaded_at timestamp with time zone,
    error_message text,
    template_meta jsonb,
    context_message_id text,
    starred boolean DEFAULT false NOT NULL,
    CONSTRAINT chat_history_direction_check CHECK ((direction = ANY (ARRAY['incoming'::text, 'outgoing'::text]))),
    CONSTRAINT chat_history_status_check CHECK ((status = ANY (ARRAY['received'::text, 'sending'::text, 'sent'::text, 'delivered'::text, 'read'::text, 'failed'::text, 'error'::text, 'unknown'::text])))
);


--
-- Name: chat_history_id_seq; Type: SEQUENCE; Schema: coexistence; Owner: -
--

CREATE SEQUENCE coexistence.chat_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: chat_history_id_seq; Type: SEQUENCE OWNED BY; Schema: coexistence; Owner: -
--

ALTER SEQUENCE coexistence.chat_history_id_seq OWNED BY coexistence.chat_history.id;


--
-- Name: chatbots; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.chatbots (
    id bigint NOT NULL,
    name text NOT NULL,
    description text,
    status text DEFAULT 'draft'::text NOT NULL,
    trigger_type text DEFAULT 'keyword'::text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: chatbots_id_seq; Type: SEQUENCE; Schema: coexistence; Owner: -
--

CREATE SEQUENCE coexistence.chatbots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: chatbots_id_seq; Type: SEQUENCE OWNED BY; Schema: coexistence; Owner: -
--

ALTER SEQUENCE coexistence.chatbots_id_seq OWNED BY coexistence.chatbots.id;


--
-- Name: contact_field_definitions; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.contact_field_definitions (
    id text NOT NULL,
    name text NOT NULL,
    description text,
    field_type text NOT NULL,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT contact_field_definitions_field_type_check CHECK ((field_type = ANY (ARRAY['text'::text, 'number'::text, 'phone'::text, 'email'::text, 'date'::text, 'url'::text, 'textarea'::text])))
);


--
-- Name: contacts; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.contacts (
    id bigint NOT NULL,
    wa_number text NOT NULL,
    contact_number text NOT NULL,
    name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tags jsonb DEFAULT '[]'::jsonb,
    custom_fields jsonb DEFAULT '{}'::jsonb,
    assigned_user_id bigint,
    profile_name text,
    ai_paused boolean DEFAULT false NOT NULL,
    ai_paused_at timestamp with time zone,
    ai_paused_by_user integer,
    last_agent_reply_at timestamp with time zone,
    last_agent_reply_by integer
);


--
-- Name: contacts_id_seq; Type: SEQUENCE; Schema: coexistence; Owner: -
--

CREATE SEQUENCE coexistence.contacts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contacts_id_seq; Type: SEQUENCE OWNED BY; Schema: coexistence; Owner: -
--

ALTER SEQUENCE coexistence.contacts_id_seq OWNED BY coexistence.contacts.id;


--
-- Name: conversation_reads; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.conversation_reads (
    wa_number text NOT NULL,
    contact_number text NOT NULL,
    last_read_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: deals; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.deals (
    id bigint NOT NULL,
    pipeline_id bigint NOT NULL,
    stage_id bigint NOT NULL,
    title text NOT NULL,
    value numeric(14,2) DEFAULT 0 NOT NULL,
    currency text DEFAULT 'INR'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    assigned_user_id bigint,
    contact_wa_number text,
    contact_number text,
    contact_name text,
    expected_close_date date,
    notes text,
    "position" integer DEFAULT 0 NOT NULL,
    won_at timestamp with time zone,
    lost_at timestamp with time zone,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deals_status_check CHECK ((status = ANY (ARRAY['open'::text, 'won'::text, 'lost'::text])))
);


--
-- Name: deals_id_seq; Type: SEQUENCE; Schema: coexistence; Owner: -
--

CREATE SEQUENCE coexistence.deals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: deals_id_seq; Type: SEQUENCE OWNED BY; Schema: coexistence; Owner: -
--

ALTER SEQUENCE coexistence.deals_id_seq OWNED BY coexistence.deals.id;


--
-- Name: akchat_users; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.akchat_users (
    id bigint NOT NULL,
    username text NOT NULL,
    email text NOT NULL,
    password text NOT NULL,
    display_name text,
    role text DEFAULT 'viewer'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    permissions jsonb,
    last_login_at timestamp with time zone,
    created_by bigint,
    CONSTRAINT akchat_users_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'bda_sales'::text, 'viewer'::text])))
);


--
-- Name: akchat_users_id_seq; Type: SEQUENCE; Schema: coexistence; Owner: -
--

CREATE SEQUENCE coexistence.akchat_users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: akchat_users_id_seq; Type: SEQUENCE OWNED BY; Schema: coexistence; Owner: -
--

ALTER SEQUENCE coexistence.akchat_users_id_seq OWNED BY coexistence.akchat_users.id;


--
-- Name: media_library; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.media_library (
    id bigint NOT NULL,
    filename text NOT NULL,
    original_name text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    media_type text NOT NULL,
    storage_backend text DEFAULT 'postgres'::text NOT NULL,
    storage_key text NOT NULL,
    sha256 text,
    auto_resync boolean DEFAULT false NOT NULL,
    notes text,
    uploaded_by integer,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    name text,
    whatsapp_account_id bigint,
    CONSTRAINT media_library_media_type_check CHECK ((media_type = ANY (ARRAY['image'::text, 'video'::text, 'audio'::text, 'document'::text])))
);


--
-- Name: media_library_id_seq; Type: SEQUENCE; Schema: coexistence; Owner: -
--

CREATE SEQUENCE coexistence.media_library_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: media_library_id_seq; Type: SEQUENCE OWNED BY; Schema: coexistence; Owner: -
--

ALTER SEQUENCE coexistence.media_library_id_seq OWNED BY coexistence.media_library.id;


--
-- Name: media_meta_sync; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.media_meta_sync (
    id bigint NOT NULL,
    media_id bigint NOT NULL,
    account_id integer NOT NULL,
    meta_media_id text,
    synced_at timestamp with time zone,
    expires_at timestamp with time zone,
    status text DEFAULT 'pending'::text NOT NULL,
    last_error text,
    attempts integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT media_meta_sync_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'syncing'::text, 'synced'::text, 'failed'::text, 'expired'::text])))
);


--
-- Name: media_meta_sync_id_seq; Type: SEQUENCE; Schema: coexistence; Owner: -
--

CREATE SEQUENCE coexistence.media_meta_sync_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: media_meta_sync_id_seq; Type: SEQUENCE OWNED BY; Schema: coexistence; Owner: -
--

ALTER SEQUENCE coexistence.media_meta_sync_id_seq OWNED BY coexistence.media_meta_sync.id;


--
-- Name: media_objects; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.media_objects (
    object_key text NOT NULL,
    data bytea NOT NULL,
    mime_type text,
    size_bytes bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: message_reactions; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.message_reactions (
    id bigint NOT NULL,
    wa_number text NOT NULL,
    contact_number text NOT NULL,
    target_message_id text NOT NULL,
    direction text NOT NULL,
    emoji text NOT NULL,
    reactor text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_reactions_direction_check CHECK ((direction = ANY (ARRAY['incoming'::text, 'outgoing'::text])))
);


--
-- Name: message_reactions_id_seq; Type: SEQUENCE; Schema: coexistence; Owner: -
--

CREATE SEQUENCE coexistence.message_reactions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: message_reactions_id_seq; Type: SEQUENCE OWNED BY; Schema: coexistence; Owner: -
--

ALTER SEQUENCE coexistence.message_reactions_id_seq OWNED BY coexistence.message_reactions.id;


--
-- Name: message_template_analytics_daily; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.message_template_analytics_daily (
    template_id integer NOT NULL,
    day date NOT NULL,
    sent integer DEFAULT 0 NOT NULL,
    delivered integer DEFAULT 0 NOT NULL,
    read_count integer DEFAULT 0 NOT NULL,
    clicked_total integer DEFAULT 0 NOT NULL,
    clicked_by_button jsonb DEFAULT '[]'::jsonb NOT NULL,
    last_fetched_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: message_template_revisions; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.message_template_revisions (
    id bigint NOT NULL,
    template_id integer NOT NULL,
    revised_at timestamp with time zone DEFAULT now() NOT NULL,
    revised_by text,
    source text DEFAULT 'manual_edit'::text NOT NULL,
    change_summary text,
    snapshot jsonb NOT NULL,
    CONSTRAINT message_template_revisions_source_check CHECK ((source = ANY (ARRAY['manual_edit'::text, 'restore'::text, 'meta_sync'::text, 'initial'::text])))
);


--
-- Name: message_template_revisions_id_seq; Type: SEQUENCE; Schema: coexistence; Owner: -
--

CREATE SEQUENCE coexistence.message_template_revisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: message_template_revisions_id_seq; Type: SEQUENCE OWNED BY; Schema: coexistence; Owner: -
--

ALTER SEQUENCE coexistence.message_template_revisions_id_seq OWNED BY coexistence.message_template_revisions.id;


--
-- Name: message_templates; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.message_templates (
    id integer NOT NULL,
    name character varying(512) NOT NULL,
    category character varying(32) NOT NULL,
    language character varying(10) DEFAULT 'en'::character varying NOT NULL,
    header_type character varying(16) DEFAULT 'NONE'::character varying NOT NULL,
    header_text text,
    media_handle text,
    body text NOT NULL,
    footer text,
    buttons jsonb DEFAULT '[]'::jsonb,
    samples jsonb DEFAULT '{}'::jsonb,
    security_recommendation boolean DEFAULT false,
    code_expiry_minutes integer,
    allow_category_change boolean DEFAULT true,
    status character varying(16) DEFAULT 'DRAFT'::character varying NOT NULL,
    meta_template_id text,
    submitted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    whatsapp_account_id bigint,
    quality_score text,
    rejection_reason text,
    previous_category text,
    last_synced_at timestamp with time zone,
    template_group_key text,
    header_media_library_id integer,
    CONSTRAINT message_templates_category_check CHECK (((category)::text = ANY ((ARRAY['MARKETING'::character varying, 'UTILITY'::character varying, 'AUTHENTICATION'::character varying])::text[]))),
    CONSTRAINT message_templates_header_type_check CHECK (((header_type)::text = ANY ((ARRAY['NONE'::character varying, 'TEXT'::character varying, 'IMAGE'::character varying, 'VIDEO'::character varying, 'DOCUMENT'::character varying])::text[]))),
    CONSTRAINT message_templates_status_check CHECK (((status)::text = ANY ((ARRAY['DRAFT'::character varying, 'SUBMITTED'::character varying, 'APPROVED'::character varying, 'REJECTED'::character varying, 'PAUSED'::character varying, 'DISABLED'::character varying])::text[])))
);


--
-- Name: message_templates_id_seq; Type: SEQUENCE; Schema: coexistence; Owner: -
--

CREATE SEQUENCE coexistence.message_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: message_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: coexistence; Owner: -
--

ALTER SEQUENCE coexistence.message_templates_id_seq OWNED BY coexistence.message_templates.id;


--
-- Name: pipeline_stages; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.pipeline_stages (
    id bigint NOT NULL,
    pipeline_id bigint NOT NULL,
    name text NOT NULL,
    probability integer DEFAULT 0 NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    stage_type text DEFAULT 'open'::text NOT NULL,
    color text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pipeline_stages_probability_check CHECK (((probability >= 0) AND (probability <= 100))),
    CONSTRAINT pipeline_stages_stage_type_check CHECK ((stage_type = ANY (ARRAY['open'::text, 'won'::text, 'lost'::text])))
);


--
-- Name: pipeline_stages_id_seq; Type: SEQUENCE; Schema: coexistence; Owner: -
--

CREATE SEQUENCE coexistence.pipeline_stages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pipeline_stages_id_seq; Type: SEQUENCE OWNED BY; Schema: coexistence; Owner: -
--

ALTER SEQUENCE coexistence.pipeline_stages_id_seq OWNED BY coexistence.pipeline_stages.id;


--
-- Name: pipelines; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.pipelines (
    id bigint NOT NULL,
    name text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pipelines_id_seq; Type: SEQUENCE; Schema: coexistence; Owner: -
--

CREATE SEQUENCE coexistence.pipelines_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pipelines_id_seq; Type: SEQUENCE OWNED BY; Schema: coexistence; Owner: -
--

ALTER SEQUENCE coexistence.pipelines_id_seq OWNED BY coexistence.pipelines.id;


--
-- Name: tags; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.tags (
    id text NOT NULL,
    name text NOT NULL,
    color text DEFAULT '#dc2626'::text,
    category_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: team_members; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.team_members (
    id text NOT NULL,
    name text NOT NULL,
    phone_number text,
    bda_id text,
    address text,
    email text,
    profile_picture_url text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: user_audit_log; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.user_audit_log (
    id bigint NOT NULL,
    actor_user_id bigint,
    actor_username text,
    action text NOT NULL,
    target_type text,
    target_id text,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_audit_log_id_seq; Type: SEQUENCE; Schema: coexistence; Owner: -
--

CREATE SEQUENCE coexistence.user_audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: coexistence; Owner: -
--

ALTER SEQUENCE coexistence.user_audit_log_id_seq OWNED BY coexistence.user_audit_log.id;


--
-- Name: user_wa_assignments; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.user_wa_assignments (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    wa_number text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by bigint
);


--
-- Name: user_wa_assignments_id_seq; Type: SEQUENCE; Schema: coexistence; Owner: -
--

CREATE SEQUENCE coexistence.user_wa_assignments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_wa_assignments_id_seq; Type: SEQUENCE OWNED BY; Schema: coexistence; Owner: -
--

ALTER SEQUENCE coexistence.user_wa_assignments_id_seq OWNED BY coexistence.user_wa_assignments.id;


--
-- Name: wa_links; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.wa_links (
    id bigint NOT NULL,
    name text NOT NULL,
    message text,
    phone_number text NOT NULL,
    slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wa_links_id_seq; Type: SEQUENCE; Schema: coexistence; Owner: -
--

CREATE SEQUENCE coexistence.wa_links_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wa_links_id_seq; Type: SEQUENCE OWNED BY; Schema: coexistence; Owner: -
--

ALTER SEQUENCE coexistence.wa_links_id_seq OWNED BY coexistence.wa_links.id;


--
-- Name: webhook_events; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.webhook_events (
    id bigint NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    source text,
    remote_ip text,
    request_headers jsonb,
    payload jsonb NOT NULL,
    payload_kind text,
    records_extracted integer DEFAULT 0 NOT NULL,
    processing_status text DEFAULT 'received'::text NOT NULL,
    processing_error text,
    processing_ms integer,
    meta_object text,
    phone_number_id text,
    payload_subtype text,
    CONSTRAINT webhook_events_processing_status_check CHECK ((processing_status = ANY (ARRAY['received'::text, 'processed'::text, 'partial'::text, 'error'::text, 'verified'::text])))
);


--
-- Name: webhook_events_id_seq; Type: SEQUENCE; Schema: coexistence; Owner: -
--

CREATE SEQUENCE coexistence.webhook_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: webhook_events_id_seq; Type: SEQUENCE OWNED BY; Schema: coexistence; Owner: -
--

ALTER SEQUENCE coexistence.webhook_events_id_seq OWNED BY coexistence.webhook_events.id;


--
-- Name: whatsapp_accounts; Type: TABLE; Schema: coexistence; Owner: -
--

CREATE TABLE coexistence.whatsapp_accounts (
    id bigint NOT NULL,
    display_name text NOT NULL,
    display_phone_number text NOT NULL,
    phone_number_id text NOT NULL,
    waba_id text NOT NULL,
    access_token_encrypted text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    health_status text DEFAULT 'unknown'::text NOT NULL,
    last_error_at timestamp with time zone,
    last_error_message text,
    last_success_at timestamp with time zone,
    meta_app_id text,
    verify_token_encrypted text,
    CONSTRAINT whatsapp_accounts_health_status_check CHECK ((health_status = ANY (ARRAY['unknown'::text, 'healthy'::text, 'invalid_token'::text, 'rate_limited'::text, 'unknown_error'::text])))
);


--
-- Name: whatsapp_accounts_id_seq; Type: SEQUENCE; Schema: coexistence; Owner: -
--

CREATE SEQUENCE coexistence.whatsapp_accounts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: whatsapp_accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: coexistence; Owner: -
--

ALTER SEQUENCE coexistence.whatsapp_accounts_id_seq OWNED BY coexistence.whatsapp_accounts.id;


--
-- Name: ai_models id; Type: DEFAULT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.ai_models ALTER COLUMN id SET DEFAULT nextval('coexistence.ai_models_id_seq'::regclass);


--
-- Name: automation_execution_steps id; Type: DEFAULT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.automation_execution_steps ALTER COLUMN id SET DEFAULT nextval('coexistence.automation_execution_steps_id_seq'::regclass);


--
-- Name: automation_executions id; Type: DEFAULT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.automation_executions ALTER COLUMN id SET DEFAULT nextval('coexistence.automation_executions_id_seq'::regclass);


--
-- Name: broadcast_logs id; Type: DEFAULT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.broadcast_logs ALTER COLUMN id SET DEFAULT nextval('coexistence.broadcast_logs_id_seq'::regclass);


--
-- Name: broadcasts id; Type: DEFAULT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.broadcasts ALTER COLUMN id SET DEFAULT nextval('coexistence.broadcasts_id_seq'::regclass);


--
-- Name: chat_history id; Type: DEFAULT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.chat_history ALTER COLUMN id SET DEFAULT nextval('coexistence.chat_history_id_seq'::regclass);


--
-- Name: chatbots id; Type: DEFAULT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.chatbots ALTER COLUMN id SET DEFAULT nextval('coexistence.chatbots_id_seq'::regclass);


--
-- Name: contacts id; Type: DEFAULT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.contacts ALTER COLUMN id SET DEFAULT nextval('coexistence.contacts_id_seq'::regclass);


--
-- Name: deals id; Type: DEFAULT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.deals ALTER COLUMN id SET DEFAULT nextval('coexistence.deals_id_seq'::regclass);


--
-- Name: akchat_users id; Type: DEFAULT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.akchat_users ALTER COLUMN id SET DEFAULT nextval('coexistence.akchat_users_id_seq'::regclass);


--
-- Name: media_library id; Type: DEFAULT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.media_library ALTER COLUMN id SET DEFAULT nextval('coexistence.media_library_id_seq'::regclass);


--
-- Name: media_meta_sync id; Type: DEFAULT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.media_meta_sync ALTER COLUMN id SET DEFAULT nextval('coexistence.media_meta_sync_id_seq'::regclass);


--
-- Name: message_reactions id; Type: DEFAULT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.message_reactions ALTER COLUMN id SET DEFAULT nextval('coexistence.message_reactions_id_seq'::regclass);


--
-- Name: message_template_revisions id; Type: DEFAULT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.message_template_revisions ALTER COLUMN id SET DEFAULT nextval('coexistence.message_template_revisions_id_seq'::regclass);


--
-- Name: message_templates id; Type: DEFAULT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.message_templates ALTER COLUMN id SET DEFAULT nextval('coexistence.message_templates_id_seq'::regclass);


--
-- Name: pipeline_stages id; Type: DEFAULT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.pipeline_stages ALTER COLUMN id SET DEFAULT nextval('coexistence.pipeline_stages_id_seq'::regclass);


--
-- Name: pipelines id; Type: DEFAULT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.pipelines ALTER COLUMN id SET DEFAULT nextval('coexistence.pipelines_id_seq'::regclass);


--
-- Name: user_audit_log id; Type: DEFAULT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.user_audit_log ALTER COLUMN id SET DEFAULT nextval('coexistence.user_audit_log_id_seq'::regclass);


--
-- Name: user_wa_assignments id; Type: DEFAULT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.user_wa_assignments ALTER COLUMN id SET DEFAULT nextval('coexistence.user_wa_assignments_id_seq'::regclass);


--
-- Name: wa_links id; Type: DEFAULT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.wa_links ALTER COLUMN id SET DEFAULT nextval('coexistence.wa_links_id_seq'::regclass);


--
-- Name: webhook_events id; Type: DEFAULT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.webhook_events ALTER COLUMN id SET DEFAULT nextval('coexistence.webhook_events_id_seq'::regclass);


--
-- Name: whatsapp_accounts id; Type: DEFAULT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.whatsapp_accounts ALTER COLUMN id SET DEFAULT nextval('coexistence.whatsapp_accounts_id_seq'::regclass);


--
-- Name: ai_models ai_models_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.ai_models
    ADD CONSTRAINT ai_models_pkey PRIMARY KEY (id);


--
-- Name: automation_execution_steps automation_execution_steps_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.automation_execution_steps
    ADD CONSTRAINT automation_execution_steps_pkey PRIMARY KEY (id);


--
-- Name: automation_executions automation_executions_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.automation_executions
    ADD CONSTRAINT automation_executions_pkey PRIMARY KEY (id);


--
-- Name: broadcast_logs broadcast_logs_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.broadcast_logs
    ADD CONSTRAINT broadcast_logs_pkey PRIMARY KEY (id);


--
-- Name: broadcasts broadcasts_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.broadcasts
    ADD CONSTRAINT broadcasts_pkey PRIMARY KEY (id);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


--
-- Name: chat_history chat_history_message_id_key; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.chat_history
    ADD CONSTRAINT chat_history_message_id_key UNIQUE (message_id);


--
-- Name: chat_history chat_history_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.chat_history
    ADD CONSTRAINT chat_history_pkey PRIMARY KEY (id);


--
-- Name: chatbots chatbots_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.chatbots
    ADD CONSTRAINT chatbots_pkey PRIMARY KEY (id);


--
-- Name: contact_field_definitions contact_field_definitions_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.contact_field_definitions
    ADD CONSTRAINT contact_field_definitions_pkey PRIMARY KEY (id);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);


--
-- Name: contacts contacts_wa_number_contact_number_key; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.contacts
    ADD CONSTRAINT contacts_wa_number_contact_number_key UNIQUE (wa_number, contact_number);


--
-- Name: conversation_reads conversation_reads_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.conversation_reads
    ADD CONSTRAINT conversation_reads_pkey PRIMARY KEY (wa_number, contact_number);


--
-- Name: deals deals_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.deals
    ADD CONSTRAINT deals_pkey PRIMARY KEY (id);


--
-- Name: akchat_users akchat_users_email_key; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.akchat_users
    ADD CONSTRAINT akchat_users_email_key UNIQUE (email);


--
-- Name: akchat_users akchat_users_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.akchat_users
    ADD CONSTRAINT akchat_users_pkey PRIMARY KEY (id);


--
-- Name: akchat_users akchat_users_username_key; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.akchat_users
    ADD CONSTRAINT akchat_users_username_key UNIQUE (username);


--
-- Name: media_library media_library_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.media_library
    ADD CONSTRAINT media_library_pkey PRIMARY KEY (id);


--
-- Name: media_meta_sync media_meta_sync_media_id_account_id_key; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.media_meta_sync
    ADD CONSTRAINT media_meta_sync_media_id_account_id_key UNIQUE (media_id, account_id);


--
-- Name: media_meta_sync media_meta_sync_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.media_meta_sync
    ADD CONSTRAINT media_meta_sync_pkey PRIMARY KEY (id);


--
-- Name: media_objects media_objects_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.media_objects
    ADD CONSTRAINT media_objects_pkey PRIMARY KEY (object_key);


--
-- Name: message_reactions message_reactions_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.message_reactions
    ADD CONSTRAINT message_reactions_pkey PRIMARY KEY (id);


--
-- Name: message_reactions message_reactions_target_message_id_direction_key; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.message_reactions
    ADD CONSTRAINT message_reactions_target_message_id_direction_key UNIQUE (target_message_id, direction);


--
-- Name: message_template_analytics_daily message_template_analytics_daily_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.message_template_analytics_daily
    ADD CONSTRAINT message_template_analytics_daily_pkey PRIMARY KEY (template_id, day);


--
-- Name: message_template_revisions message_template_revisions_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.message_template_revisions
    ADD CONSTRAINT message_template_revisions_pkey PRIMARY KEY (id);


--
-- Name: message_templates message_templates_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.message_templates
    ADD CONSTRAINT message_templates_pkey PRIMARY KEY (id);


--
-- Name: pipeline_stages pipeline_stages_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.pipeline_stages
    ADD CONSTRAINT pipeline_stages_pkey PRIMARY KEY (id);


--
-- Name: pipelines pipelines_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.pipelines
    ADD CONSTRAINT pipelines_pkey PRIMARY KEY (id);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: team_members team_members_bda_id_key; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.team_members
    ADD CONSTRAINT team_members_bda_id_key UNIQUE (bda_id);


--
-- Name: team_members team_members_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.team_members
    ADD CONSTRAINT team_members_pkey PRIMARY KEY (id);


--
-- Name: user_audit_log user_audit_log_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.user_audit_log
    ADD CONSTRAINT user_audit_log_pkey PRIMARY KEY (id);


--
-- Name: user_wa_assignments user_wa_assignments_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.user_wa_assignments
    ADD CONSTRAINT user_wa_assignments_pkey PRIMARY KEY (id);


--
-- Name: user_wa_assignments user_wa_assignments_user_id_wa_number_key; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.user_wa_assignments
    ADD CONSTRAINT user_wa_assignments_user_id_wa_number_key UNIQUE (user_id, wa_number);


--
-- Name: wa_links wa_links_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.wa_links
    ADD CONSTRAINT wa_links_pkey PRIMARY KEY (id);


--
-- Name: wa_links wa_links_slug_key; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.wa_links
    ADD CONSTRAINT wa_links_slug_key UNIQUE (slug);


--
-- Name: webhook_events webhook_events_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.webhook_events
    ADD CONSTRAINT webhook_events_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_accounts whatsapp_accounts_phone_number_id_key; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.whatsapp_accounts
    ADD CONSTRAINT whatsapp_accounts_phone_number_id_key UNIQUE (phone_number_id);


--
-- Name: whatsapp_accounts whatsapp_accounts_pkey; Type: CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.whatsapp_accounts
    ADD CONSTRAINT whatsapp_accounts_pkey PRIMARY KEY (id);


--
-- Name: ai_models_provider_idx; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX ai_models_provider_idx ON coexistence.ai_models USING btree (provider);


--
-- Name: idx_audit_action; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_audit_action ON coexistence.user_audit_log USING btree (action);


--
-- Name: idx_audit_actor; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_audit_actor ON coexistence.user_audit_log USING btree (actor_user_id);


--
-- Name: idx_audit_created; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_audit_created ON coexistence.user_audit_log USING btree (created_at DESC);


--
-- Name: idx_audit_target; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_audit_target ON coexistence.user_audit_log USING btree (target_type, target_id, created_at DESC);


--
-- Name: idx_automation_executions_automation_id; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_automation_executions_automation_id ON coexistence.automation_executions USING btree (automation_id);


--
-- Name: idx_automation_executions_started_at; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_automation_executions_started_at ON coexistence.automation_executions USING btree (started_at DESC);


--
-- Name: idx_automation_executions_status; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_automation_executions_status ON coexistence.automation_executions USING btree (status);


--
-- Name: idx_broadcast_logs_broadcast_id; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_broadcast_logs_broadcast_id ON coexistence.broadcast_logs USING btree (broadcast_id);


--
-- Name: idx_broadcast_logs_sent_at; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_broadcast_logs_sent_at ON coexistence.broadcast_logs USING btree (sent_at DESC);


--
-- Name: idx_broadcast_logs_wa_message_id; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_broadcast_logs_wa_message_id ON coexistence.broadcast_logs USING btree (wa_message_id) WHERE (wa_message_id IS NOT NULL);


--
-- Name: idx_broadcasts_created_at; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_broadcasts_created_at ON coexistence.broadcasts USING btree (created_at DESC);


--
-- Name: idx_broadcasts_scheduled; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_broadcasts_scheduled ON coexistence.broadcasts USING btree (scheduled_at, status) WHERE (((status)::text = 'SCHEDULED'::text) AND (scheduled_at IS NOT NULL));


--
-- Name: idx_broadcasts_status; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_broadcasts_status ON coexistence.broadcasts USING btree (status);


--
-- Name: idx_chat_contact; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_chat_contact ON coexistence.chat_history USING btree (wa_number, contact_number, "timestamp" DESC);


--
-- Name: idx_chat_history_context; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_chat_history_context ON coexistence.chat_history USING btree (context_message_id) WHERE (context_message_id IS NOT NULL);


--
-- Name: idx_chat_history_starred; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_chat_history_starred ON coexistence.chat_history USING btree (wa_number, contact_number) WHERE (starred = true);


--
-- Name: idx_chat_incoming; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_chat_incoming ON coexistence.chat_history USING btree (wa_number, contact_number, "timestamp" DESC) WHERE (direction = 'incoming'::text);


--
-- Name: idx_chat_media_status; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_chat_media_status ON coexistence.chat_history USING btree (media_status) WHERE (media_status IS NOT NULL);


--
-- Name: idx_chat_phone_number_id_contact; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_chat_phone_number_id_contact ON coexistence.chat_history USING btree (phone_number_id, contact_number, "timestamp" DESC) WHERE (direction = 'incoming'::text);


--
-- Name: idx_chat_timestamp; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_chat_timestamp ON coexistence.chat_history USING btree ("timestamp" DESC);


--
-- Name: idx_chat_wa_number; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_chat_wa_number ON coexistence.chat_history USING btree (wa_number, "timestamp" DESC);


--
-- Name: idx_chatbots_status; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_chatbots_status ON coexistence.chatbots USING btree (status);


--
-- Name: idx_contact_field_definitions_sort; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_contact_field_definitions_sort ON coexistence.contact_field_definitions USING btree (sort_order);


--
-- Name: idx_contacts_assigned_user; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_contacts_assigned_user ON coexistence.contacts USING btree (assigned_user_id) WHERE (assigned_user_id IS NOT NULL);


--
-- Name: idx_contacts_custom_fields; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_contacts_custom_fields ON coexistence.contacts USING gin (custom_fields);


--
-- Name: idx_contacts_display_name; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_contacts_display_name ON coexistence.contacts USING btree (wa_number, COALESCE(name, profile_name));


--
-- Name: idx_contacts_lookup; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_contacts_lookup ON coexistence.contacts USING btree (wa_number, contact_number);


--
-- Name: idx_deals_assigned; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_deals_assigned ON coexistence.deals USING btree (assigned_user_id);


--
-- Name: idx_deals_pipeline; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_deals_pipeline ON coexistence.deals USING btree (pipeline_id);


--
-- Name: idx_deals_pipeline_position; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_deals_pipeline_position ON coexistence.deals USING btree (pipeline_id, stage_id, "position");


--
-- Name: idx_deals_stage; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_deals_stage ON coexistence.deals USING btree (stage_id);


--
-- Name: idx_deals_status; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_deals_status ON coexistence.deals USING btree (pipeline_id, status);


--
-- Name: idx_deals_won_at; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_deals_won_at ON coexistence.deals USING btree (won_at DESC) WHERE (status = 'won'::text);


--
-- Name: idx_execution_steps_exec_wa_status; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_execution_steps_exec_wa_status ON coexistence.automation_execution_steps USING btree (execution_id, wa_message_status);


--
-- Name: idx_execution_steps_execution_id; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_execution_steps_execution_id ON coexistence.automation_execution_steps USING btree (execution_id);


--
-- Name: idx_execution_steps_node_id; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_execution_steps_node_id ON coexistence.automation_execution_steps USING btree (node_id);


--
-- Name: idx_execution_steps_wa_msg_id; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_execution_steps_wa_msg_id ON coexistence.automation_execution_steps USING btree (wa_message_id);


--
-- Name: idx_execution_steps_wa_status; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_execution_steps_wa_status ON coexistence.automation_execution_steps USING btree (wa_message_status);


--
-- Name: idx_executions_resume_lookup; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_executions_resume_lookup ON coexistence.automation_executions USING btree (wa_number, contact_number, expires_at) WHERE ((status)::text = 'paused'::text);


--
-- Name: idx_media_library_account; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_media_library_account ON coexistence.media_library USING btree (whatsapp_account_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_media_library_type; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_media_library_type ON coexistence.media_library USING btree (media_type) WHERE (deleted_at IS NULL);


--
-- Name: idx_media_library_uploaded_at; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_media_library_uploaded_at ON coexistence.media_library USING btree (uploaded_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_media_meta_sync_account; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_media_meta_sync_account ON coexistence.media_meta_sync USING btree (account_id);


--
-- Name: idx_media_meta_sync_expiring; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_media_meta_sync_expiring ON coexistence.media_meta_sync USING btree (expires_at) WHERE (status = 'synced'::text);


--
-- Name: idx_message_reactions_convo; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_message_reactions_convo ON coexistence.message_reactions USING btree (wa_number, contact_number);


--
-- Name: idx_message_reactions_target; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_message_reactions_target ON coexistence.message_reactions USING btree (target_message_id);


--
-- Name: idx_message_templates_category; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_message_templates_category ON coexistence.message_templates USING btree (category);


--
-- Name: idx_message_templates_group_key; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_message_templates_group_key ON coexistence.message_templates USING btree (template_group_key);


--
-- Name: idx_message_templates_language; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_message_templates_language ON coexistence.message_templates USING btree (language);


--
-- Name: idx_message_templates_name; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_message_templates_name ON coexistence.message_templates USING btree (name);


--
-- Name: idx_message_templates_status; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_message_templates_status ON coexistence.message_templates USING btree (status);


--
-- Name: idx_message_templates_whatsapp_account; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_message_templates_whatsapp_account ON coexistence.message_templates USING btree (whatsapp_account_id);


--
-- Name: idx_pipeline_stages_pipeline; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_pipeline_stages_pipeline ON coexistence.pipeline_stages USING btree (pipeline_id);


--
-- Name: idx_team_members_bda_id; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_team_members_bda_id ON coexistence.team_members USING btree (bda_id);


--
-- Name: idx_template_analytics_day; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_template_analytics_day ON coexistence.message_template_analytics_daily USING btree (day DESC);


--
-- Name: idx_template_revisions_template; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_template_revisions_template ON coexistence.message_template_revisions USING btree (template_id, revised_at DESC);


--
-- Name: idx_user_wa_assignments_wa; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_user_wa_assignments_wa ON coexistence.user_wa_assignments USING btree (wa_number);


--
-- Name: idx_wa_links_created_at; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_wa_links_created_at ON coexistence.wa_links USING btree (created_at DESC);


--
-- Name: idx_wa_links_slug; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_wa_links_slug ON coexistence.wa_links USING btree (slug);


--
-- Name: idx_webhook_events_kind; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_webhook_events_kind ON coexistence.webhook_events USING btree (payload_kind);


--
-- Name: idx_webhook_events_phone; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_webhook_events_phone ON coexistence.webhook_events USING btree (phone_number_id);


--
-- Name: idx_webhook_events_received; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_webhook_events_received ON coexistence.webhook_events USING btree (received_at DESC);


--
-- Name: idx_webhook_events_status; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_webhook_events_status ON coexistence.webhook_events USING btree (processing_status);


--
-- Name: idx_webhook_events_subtype; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_webhook_events_subtype ON coexistence.webhook_events USING btree (payload_subtype);


--
-- Name: idx_whatsapp_accounts_one_default; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE UNIQUE INDEX idx_whatsapp_accounts_one_default ON coexistence.whatsapp_accounts USING btree (is_default) WHERE (is_default = true);


--
-- Name: idx_whatsapp_accounts_phone_number_id; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE INDEX idx_whatsapp_accounts_phone_number_id ON coexistence.whatsapp_accounts USING btree (phone_number_id);


--
-- Name: whatsapp_accounts_singleton; Type: INDEX; Schema: coexistence; Owner: -
--

CREATE UNIQUE INDEX whatsapp_accounts_singleton ON coexistence.whatsapp_accounts USING btree ((true));


--
-- Name: automation_execution_steps automation_execution_steps_execution_id_fkey; Type: FK CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.automation_execution_steps
    ADD CONSTRAINT automation_execution_steps_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES coexistence.automation_executions(id) ON DELETE CASCADE;


--
-- Name: automation_executions automation_executions_automation_id_fkey; Type: FK CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.automation_executions
    ADD CONSTRAINT automation_executions_automation_id_fkey FOREIGN KEY (automation_id) REFERENCES coexistence.chatbots(id) ON DELETE CASCADE;


--
-- Name: broadcast_logs broadcast_logs_broadcast_id_fkey; Type: FK CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.broadcast_logs
    ADD CONSTRAINT broadcast_logs_broadcast_id_fkey FOREIGN KEY (broadcast_id) REFERENCES coexistence.broadcasts(id) ON DELETE CASCADE;


--
-- Name: broadcasts broadcasts_template_id_fkey; Type: FK CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.broadcasts
    ADD CONSTRAINT broadcasts_template_id_fkey FOREIGN KEY (template_id) REFERENCES coexistence.message_templates(id) ON DELETE SET NULL;


--
-- Name: contacts contacts_assigned_user_id_fkey; Type: FK CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.contacts
    ADD CONSTRAINT contacts_assigned_user_id_fkey FOREIGN KEY (assigned_user_id) REFERENCES coexistence.akchat_users(id) ON DELETE SET NULL;


--
-- Name: deals deals_assigned_user_id_fkey; Type: FK CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.deals
    ADD CONSTRAINT deals_assigned_user_id_fkey FOREIGN KEY (assigned_user_id) REFERENCES coexistence.akchat_users(id) ON DELETE SET NULL;


--
-- Name: deals deals_created_by_fkey; Type: FK CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.deals
    ADD CONSTRAINT deals_created_by_fkey FOREIGN KEY (created_by) REFERENCES coexistence.akchat_users(id) ON DELETE SET NULL;


--
-- Name: deals deals_pipeline_id_fkey; Type: FK CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.deals
    ADD CONSTRAINT deals_pipeline_id_fkey FOREIGN KEY (pipeline_id) REFERENCES coexistence.pipelines(id) ON DELETE CASCADE;


--
-- Name: deals deals_stage_id_fkey; Type: FK CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.deals
    ADD CONSTRAINT deals_stage_id_fkey FOREIGN KEY (stage_id) REFERENCES coexistence.pipeline_stages(id) ON DELETE RESTRICT;


--
-- Name: akchat_users akchat_users_created_by_fkey; Type: FK CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.akchat_users
    ADD CONSTRAINT akchat_users_created_by_fkey FOREIGN KEY (created_by) REFERENCES coexistence.akchat_users(id) ON DELETE SET NULL;


--
-- Name: media_library media_library_whatsapp_account_id_fkey; Type: FK CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.media_library
    ADD CONSTRAINT media_library_whatsapp_account_id_fkey FOREIGN KEY (whatsapp_account_id) REFERENCES coexistence.whatsapp_accounts(id) ON DELETE SET NULL;


--
-- Name: media_meta_sync media_meta_sync_account_id_fkey; Type: FK CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.media_meta_sync
    ADD CONSTRAINT media_meta_sync_account_id_fkey FOREIGN KEY (account_id) REFERENCES coexistence.whatsapp_accounts(id) ON DELETE CASCADE;


--
-- Name: media_meta_sync media_meta_sync_media_id_fkey; Type: FK CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.media_meta_sync
    ADD CONSTRAINT media_meta_sync_media_id_fkey FOREIGN KEY (media_id) REFERENCES coexistence.media_library(id) ON DELETE CASCADE;


--
-- Name: message_template_analytics_daily message_template_analytics_daily_template_id_fkey; Type: FK CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.message_template_analytics_daily
    ADD CONSTRAINT message_template_analytics_daily_template_id_fkey FOREIGN KEY (template_id) REFERENCES coexistence.message_templates(id) ON DELETE CASCADE;


--
-- Name: message_template_revisions message_template_revisions_template_id_fkey; Type: FK CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.message_template_revisions
    ADD CONSTRAINT message_template_revisions_template_id_fkey FOREIGN KEY (template_id) REFERENCES coexistence.message_templates(id) ON DELETE CASCADE;


--
-- Name: message_templates message_templates_whatsapp_account_id_fkey; Type: FK CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.message_templates
    ADD CONSTRAINT message_templates_whatsapp_account_id_fkey FOREIGN KEY (whatsapp_account_id) REFERENCES coexistence.whatsapp_accounts(id) ON DELETE SET NULL;


--
-- Name: pipeline_stages pipeline_stages_pipeline_id_fkey; Type: FK CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.pipeline_stages
    ADD CONSTRAINT pipeline_stages_pipeline_id_fkey FOREIGN KEY (pipeline_id) REFERENCES coexistence.pipelines(id) ON DELETE CASCADE;


--
-- Name: pipelines pipelines_created_by_fkey; Type: FK CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.pipelines
    ADD CONSTRAINT pipelines_created_by_fkey FOREIGN KEY (created_by) REFERENCES coexistence.akchat_users(id) ON DELETE SET NULL;


--
-- Name: tags tags_category_id_fkey; Type: FK CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.tags
    ADD CONSTRAINT tags_category_id_fkey FOREIGN KEY (category_id) REFERENCES coexistence.categories(id) ON DELETE CASCADE;


--
-- Name: user_audit_log user_audit_log_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.user_audit_log
    ADD CONSTRAINT user_audit_log_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES coexistence.akchat_users(id) ON DELETE SET NULL;


--
-- Name: user_wa_assignments user_wa_assignments_created_by_fkey; Type: FK CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.user_wa_assignments
    ADD CONSTRAINT user_wa_assignments_created_by_fkey FOREIGN KEY (created_by) REFERENCES coexistence.akchat_users(id) ON DELETE SET NULL;


--
-- Name: user_wa_assignments user_wa_assignments_user_id_fkey; Type: FK CONSTRAINT; Schema: coexistence; Owner: -
--

ALTER TABLE ONLY coexistence.user_wa_assignments
    ADD CONSTRAINT user_wa_assignments_user_id_fkey FOREIGN KEY (user_id) REFERENCES coexistence.akchat_users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict 6WnX4zNxkvtDEodO3QblnblWyberBmKhxC1UsgERlXLPhdFAxLHvPMO6jQfne77


