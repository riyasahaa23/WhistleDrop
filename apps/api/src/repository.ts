import { createHash, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import { db } from './db.js';
import type { Category, Report, Status } from './domain.js';

const hashCaseCode = (code: string) => createHash('sha256').update(code).digest('hex');
const toReport = (row: any, updates: any[] = []): Report => ({
  id: row.id, caseCodeHash: row.case_code_hash, category: row.category, description: row.description,
  evidenceUrl: row.evidence_url, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
  updates: updates.map((u) => ({ status: u.status, message: u.message, createdAt: u.created_at }))
});

export function makeCaseCode(): string {
  // Base32-like alphabet avoids ambiguous characters and is generated from 128 bits of entropy.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(26);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

export function createReport(input: { category: Category; description: string; evidenceUrl?: string }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const caseCode = makeCaseCode();
    const id = nanoid();
    const now = new Date().toISOString();
    try {
      db.prepare('INSERT INTO reports (id, case_code_hash, category, description, evidence_url, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, hashCaseCode(caseCode), input.category, input.description, input.evidenceUrl ?? null, 'SUBMITTED', now, now);
      db.prepare('INSERT INTO report_updates (id, report_id, status, message, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(nanoid(), id, 'SUBMITTED', 'Report received and awaiting review.', now);
      return { caseCode, report: getReportById(id)! };
    } catch (error) {
      if (attempt === 4) throw error;
    }
  }
  throw new Error('Could not generate a case code');
}

export function getReportByCaseCode(caseCode: string) {
  const row = db.prepare('SELECT * FROM reports WHERE case_code_hash = ?').get(hashCaseCode(caseCode)) as any;
  return row ? getReportById(row.id) : null;
}

export function getReportById(id: string) {
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as any;
  if (!row) return null;
  const updates = db.prepare('SELECT status, message, created_at FROM report_updates WHERE report_id = ? ORDER BY created_at ASC').all(id);
  return toReport(row, updates);
}

export function listReports(filters: { category?: Category; status?: Status; limit: number; offset: number }) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.category) { where.push('category = ?'); params.push(filters.category); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  params.push(filters.limit, filters.offset);
  const rows = db.prepare(`SELECT * FROM reports ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params) as any[];
  return rows.map((row) => toReport(row));
}

export function updateReport(id: string, status: Status, message: string) {
  const existing = getReportById(id);
  if (!existing) return null;
  const allowed: Record<Status, Status[]> = {
    SUBMITTED: ['UNDER_REVIEW'], UNDER_REVIEW: ['RESOLVED', 'DISMISSED'], RESOLVED: [], DISMISSED: []
  };
  if (status !== existing.status && !allowed[existing.status].includes(status)) {
    const error = new Error(`Cannot change status from ${existing.status} to ${status}`); error.name = 'InvalidTransition'; throw error;
  }
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    db.prepare('UPDATE reports SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
    db.prepare('INSERT INTO report_updates (id, report_id, status, message, created_at) VALUES (?, ?, ?, ?, ?)').run(nanoid(), id, status, message, now);
  });
  transaction();
  return getReportById(id);
}
