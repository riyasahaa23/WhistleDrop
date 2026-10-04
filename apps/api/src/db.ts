import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });
export const db = new Database(config.DATABASE_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    case_code_hash TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL CHECK(category IN ('SECURITY','HARASSMENT','CORRUPTION','TECHNICAL','OTHER')),
    description TEXT NOT NULL,
    evidence_url TEXT,
    status TEXT NOT NULL CHECK(status IN ('SUBMITTED','UNDER_REVIEW','RESOLVED','DISMISSED')),
    closed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS report_updates (
    id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
  CREATE INDEX IF NOT EXISTS idx_reports_category ON reports(category);
  CREATE INDEX IF NOT EXISTS idx_updates_report ON report_updates(report_id);
  CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    stored_name TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_evidence_report ON evidence(report_id);
  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    report_id TEXT,
    moderator_email TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

try { db.exec('ALTER TABLE reports ADD COLUMN closed_at TEXT'); } catch { /* existing database already migrated */ }
