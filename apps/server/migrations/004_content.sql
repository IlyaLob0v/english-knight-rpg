-- Content the teacher publishes from the content sheet. The newest row is live: on start the
-- gateway lays its units, tasks, episodes and places over the repository's content folder,
-- whose taxonomy, characters and daily guests stay in charge.

CREATE TABLE content_versions (
  version_id bigserial PRIMARY KEY,
  content_hash text NOT NULL,
  -- The sheet as read: { units, modules, taskSets, episodes, places }. json, not jsonb: key order
  -- is kept, so the content hash after a restart is the one the teacher published.
  sheet json NOT NULL,
  -- Where it came from: the Google Sheets link, or the uploaded file's name.
  source text NOT NULL,
  published_by text REFERENCES accounts (account_id),
  published_at timestamptz NOT NULL DEFAULT now()
);
