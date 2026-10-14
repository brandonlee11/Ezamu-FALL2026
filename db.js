const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.ALOUD_DATA || path.join(__dirname, 'data');
const VIDEO_DIR = path.join(DATA_DIR, 'videos');
fs.mkdirSync(VIDEO_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'aloud.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  intro TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  prompt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text'
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  tester_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'recording',
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER,
  video_file TEXT,
  mime TEXT,
  user_agent TEXT,
  chunks INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS task_results (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL,
  started_ms INTEGER NOT NULL DEFAULT 0,
  ended_ms INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  answer TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ms INTEGER NOT NULL,
  body TEXT NOT NULL,
  tag TEXT NOT NULL DEFAULT 'note',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tests_user ON tests(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_test ON sessions(test_id);
CREATE INDEX IF NOT EXISTS idx_notes_session ON notes(session_id);
`);

// Upgrades for databases created by earlier versions.
const sessionCols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
if (!sessionCols.includes('video_url')) db.exec('ALTER TABLE sessions ADD COLUMN video_url TEXT');

module.exports = { db, DATA_DIR, VIDEO_DIR };
