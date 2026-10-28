-- The school platform: accounts, groups with their schedule, invitations, homework and
-- the files students hand in. Moonbridge progress stays in player_progress, keyed by the
-- account's player_id, so a student finds it on any phone they sign in on.

CREATE TABLE accounts (
  account_id text PRIMARY KEY,
  role text NOT NULL CHECK (role IN ('student', 'teacher')),
  name text NOT NULL,
  -- What the person types to sign in: an e-mail or a nickname, stored in lower case.
  login text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  -- The learner behind the account: xAPI actor, progress backup, error journal.
  player_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE school_groups (
  group_id text PRIMARY KEY,
  teacher_id text NOT NULL REFERENCES accounts (account_id),
  name text NOT NULL,
  -- The link to the video call the lessons happen in.
  call_url text,
  -- [{ "weekday": 1–7 (Monday = 1), "time": "HH:MM", "minutes": 60 }], Moscow time.
  schedule jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX school_groups_teacher ON school_groups (teacher_id);

CREATE TABLE group_members (
  group_id text NOT NULL REFERENCES school_groups (group_id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounts (account_id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, account_id)
);
CREATE INDEX group_members_account ON group_members (account_id);

-- A group's invitation link; anyone with it can join the group until it expires.
CREATE TABLE invites (
  code text PRIMARY KEY,
  group_id text NOT NULL REFERENCES school_groups (group_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE homework (
  homework_id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES school_groups (group_id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  due_at timestamptz,
  -- Handed in as a file (a voice recording, a photo of the notebook) and checked by the teacher.
  needs_file boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX homework_group ON homework (group_id, created_at);

-- One hand-in per student and homework; a new upload replaces the file.
CREATE TABLE submissions (
  submission_id text PRIMARY KEY,
  homework_id text NOT NULL REFERENCES homework (homework_id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounts (account_id),
  file_key text NOT NULL,
  file_name text NOT NULL,
  mime text NOT NULL,
  size bigint NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (homework_id, account_id)
);
