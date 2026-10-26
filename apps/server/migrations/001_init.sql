-- Gateway state. The game's own state (progress, FSRS cards, attempt journal) lives
-- in the browser; player_progress below is only its latest backup.

-- LMS identity (iss, sub) → game player. xAPI always uses player_id.
CREATE TABLE lti_identities (
  iss text NOT NULL,
  sub text NOT NULL,
  player_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (iss, sub)
);

-- OIDC login state → nonce, one-time, short-lived.
CREATE TABLE lti_login_states (
  state text PRIMARY KEY,
  nonce text NOT NULL,
  issuer text NOT NULL,
  client_id text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX lti_login_states_expires ON lti_login_states (expires_at);

-- Best boss result per player and module: AGS keeps the latest score, so only the best is ever sent.
CREATE TABLE module_scores (
  player_id text NOT NULL,
  module_id text NOT NULL,
  best double precision NOT NULL CHECK (best >= 0 AND best <= 1),
  results integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, module_id)
);

-- Grades on their way to an LMS gradebook (AGS), retried until the LMS accepts them.
-- One row per player, module and LMS context; a better score replaces a pending one.
CREATE TABLE grade_outbox (
  player_id text NOT NULL,
  module_id text NOT NULL,
  context_key text NOT NULL,
  job jsonb NOT NULL,
  score_given double precision NOT NULL,
  sent_score double precision,
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, module_id, context_key)
);
CREATE INDEX grade_outbox_due ON grade_outbox (next_attempt_at) WHERE status = 'pending';

-- xAPI statements on their way to the LRS. Sent rows keep only the id, so a resend from a
-- client's offline queue is recognised and dropped (the LRS deduplicates by id as well).
CREATE TABLE xapi_outbox (
  id uuid PRIMARY KEY,
  -- Arrival order: statements of one request share queued_at.
  seq bigserial,
  statement jsonb,
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  queued_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  last_error text
);
CREATE INDEX xapi_outbox_due ON xapi_outbox (next_attempt_at, queued_at, seq) WHERE status = 'pending';

-- Latest backup of a player's game state, so an LMS player keeps their city on another device.
CREATE TABLE player_progress (
  player_id text PRIMARY KEY,
  snapshot jsonb NOT NULL,
  saved_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
