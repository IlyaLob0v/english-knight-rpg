-- The pilot: the Monday its first week starts (the metrics page counts weeks from it) and
-- the testers' reports of problems, sent from the platform's "Сообщить о проблеме" form.

ALTER TABLE school_groups ADD COLUMN pilot_from date;

CREATE TABLE feedback (
  feedback_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts (account_id) ON DELETE CASCADE,
  page text NOT NULL,
  message text NOT NULL,
  user_agent text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_time ON feedback (created_at);
