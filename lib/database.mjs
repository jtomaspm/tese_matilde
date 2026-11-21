export function initializeDatabase(db) {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tests (
      id INTEGER PRIMARY KEY, type TEXT NOT NULL, config TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS invitations (
      code TEXT PRIMARY KEY, test_id INTEGER NOT NULL REFERENCES tests(id), config TEXT NOT NULL,
      label TEXT NOT NULL CHECK(length(trim(label)) > 0), created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS admin (
      id INTEGER PRIMARY KEY CHECK (id = 1), salt TEXT NOT NULL, password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, code TEXT NOT NULL REFERENCES invitations(code),
      plan TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE, code TEXT NOT NULL REFERENCES invitations(code),
      name TEXT NOT NULL, email TEXT NOT NULL, completed_at TEXT NOT NULL, results TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attempts_by_expiry ON attempts(expires);
    CREATE INDEX IF NOT EXISTS invitations_by_test_date ON invitations(test_id, created_at);
    CREATE INDEX IF NOT EXISTS submissions_by_code ON submissions(code);
  `);
}
