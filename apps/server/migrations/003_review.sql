-- The teacher's cabinet: every answer a student gives (kept by the gateway as it passes
-- the statement on to the LRS) and the teacher's review of handed-in files.

CREATE TABLE attempts (
  statement_id uuid PRIMARY KEY,
  player_id text NOT NULL,
  answered_at timestamptz NOT NULL,
  task_id text NOT NULL,
  module_id text NOT NULL,
  concept_id text NOT NULL,
  success boolean NOT NULL,
  error_type text,
  attempt_no integer NOT NULL,
  duration_ms integer NOT NULL,
  -- moonbridge_episode, lost_and_found, guest_of_the_day…
  mode text
);
CREATE INDEX attempts_player_time ON attempts (player_id, answered_at);

-- 1–5 and a comment. A new upload clears the review: the new file waits for its own.
ALTER TABLE submissions ADD COLUMN grade smallint CHECK (grade BETWEEN 1 AND 5);
ALTER TABLE submissions ADD COLUMN teacher_comment text;
ALTER TABLE submissions ADD COLUMN reviewed_at timestamptz;
CREATE INDEX submissions_unreviewed ON submissions (submitted_at) WHERE reviewed_at IS NULL;
