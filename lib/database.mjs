function createLibrary(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tests (
      id INTEGER PRIMARY KEY, type TEXT NOT NULL, config TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS invitations (
      code TEXT PRIMARY KEY, test_id INTEGER NOT NULL REFERENCES tests(id), config TEXT NOT NULL,
      label TEXT NOT NULL, created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function migrateLibrary(db) {
  // Keep invitation codes intact for existing links, attempts, and submissions.
  db.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE new_tests (
        id INTEGER PRIMARY KEY, type TEXT NOT NULL, config TEXT NOT NULL, deleted_at TEXT
      );
      CREATE TABLE new_invitations (
        code TEXT PRIMARY KEY, test_id INTEGER NOT NULL REFERENCES tests(id), config TEXT NOT NULL,
        label TEXT NOT NULL, created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO new_tests (id, type, config)
        SELECT t.id, t.type, (SELECT config FROM test_versions WHERE test_id = t.id AND version = t.version)
        FROM tests t;
      INSERT INTO new_invitations (code, test_id, config, label, created_at, revoked)
        SELECT i.code, i.test_id,
          (SELECT config FROM test_versions WHERE test_id = i.test_id AND version = i.version),
          i.label, i.created_at, i.revoked FROM invitations i;
      DROP TABLE invitations;
      DROP TABLE test_versions;
      DROP TABLE tests;
      ALTER TABLE new_tests RENAME TO tests;
      ALTER TABLE new_invitations RENAME TO invitations;
    `);
    if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Invalid references after migrating the test library.');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export function initializeDatabase(db) {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'test_versions'").get()) {
    migrateLibrary(db);
  }
  createLibrary(db);
  db.exec(`
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
      id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE, code TEXT NOT NULL UNIQUE REFERENCES invitations(code),
      name TEXT NOT NULL, email TEXT NOT NULL, completed_at TEXT NOT NULL, results TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attempts_by_expiry ON attempts(expires);
    CREATE INDEX IF NOT EXISTS invitations_by_test_date ON invitations(test_id, created_at);
    DROP INDEX IF EXISTS invitations_by_test;
  `);
}
