CREATE TABLE IF NOT EXISTS inbox_messages (
  id SERIAL PRIMARY KEY,
  from_email TEXT NOT NULL,
  from_name TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  received_at TIMESTAMP NOT NULL DEFAULT NOW(),
  subscriber_id INTEGER,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  is_replied BOOLEAN NOT NULL DEFAULT FALSE,
  thread_id TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inbox_messages_received_at ON inbox_messages(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_from_email ON inbox_messages(from_email);
