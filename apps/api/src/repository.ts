import { createHash, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import { db } from './db.js';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { extname, join } from 'node:path';
import { config } from './config.js';
import type { Category, Evidence, Report, Status } from './domain.js';

const hashCaseCode = (code: string) => createHash('sha256').update(code).digest('hex');
const toReport = (row: any, updates: any[] = []): Report => ({
  id: row.id, category: row.category, description: row.description,
  evidenceUrl: row.evidence_url, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
  closedAt: row.closed_at ?? null,
  updates: updates.map((u) => ({ status: u.status, message: u.message, createdAt: u.created_at })),
  evidence: (db.prepare('SELECT id, content_type, file_size, created_at FROM evidence WHERE report_id = ? ORDER BY created_at ASC').all(row.id) as any[])
    .map((e) => ({ id: e.id, contentType: e.content_type, fileSize: e.file_size, createdAt: e.created_at }))
});

export function makeCaseCode(): string {
  // Base32-like alphabet avoids ambiguous characters. Rejection sampling keeps
  // every character uniformly distributed instead of introducing modulo bias.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const maxUsableByte = Math.floor(256 / alphabet.length) * alphabet.length;
  const characters: string[] = [];
  while (characters.length < 26) {
    for (const byte of randomBytes(32)) {
      if (byte >= maxUsableByte) continue;
      characters.push(alphabet[byte % alphabet.length]);
      if (characters.length === 26) break;
    }
  }
  return characters.join('');
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

export function listReports(filters: { category?: Category; status?: Status; search?: string; createdAfter?: string; createdBefore?: string; limit: number; offset: number }) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.category) { where.push('category = ?'); params.push(filters.category); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.search) { where.push('description LIKE ?'); params.push(`%${filters.search}%`); }
  if (filters.createdAfter) { where.push('created_at >= ?'); params.push(filters.createdAfter); }
  if (filters.createdBefore) { where.push('created_at <= ?'); params.push(filters.createdBefore); }
  params.push(filters.limit, filters.offset);
  const rows = db.prepare(`SELECT * FROM reports ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params) as any[];
  const countParams = params.slice(0, -2);
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM reports ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).get(...countParams) as any).count as number;
  return { reports: rows.map((row) => toReport(row)), total };
}

export function updateReport(id: string, status: Status, message: string) {
  const existing = getReportById(id);
  if (!existing) return null;
  if (existing.closedAt) { const error = new Error('This case is permanently closed'); error.name = 'CaseClosed'; throw error; }
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

export function addReportUpdate(id: string, message: string) {
  const existing = getReportById(id);
  if (!existing) return null;
  if (existing.closedAt) { const error = new Error('This case is permanently closed'); error.name = 'CaseClosed'; throw error; }
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    db.prepare('UPDATE reports SET updated_at = ? WHERE id = ?').run(now, id);
    db.prepare('INSERT INTO report_updates (id, report_id, status, message, created_at) VALUES (?, ?, ?, ?, ?)').run(nanoid(), id, existing.status, message, now);
  });
  transaction();
  return getReportById(id);
}

const evidenceRules: Record<string, { extension: string; signature?: Buffer }> = {
  'application/pdf': { extension: '.pdf', signature: Buffer.from('%PDF-') },
  'image/png': { extension: '.png', signature: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  'image/jpeg': { extension: '.jpg', signature: Buffer.from([0xff, 0xd8, 0xff]) },
  'text/plain': { extension: '.txt' }
};

class ClamAVUnavailable extends Error { name = 'ClamAVUnavailable'; }
class MalwareDetected extends Error { name = 'MalwareDetected'; }

async function scanWithClamAV(data: Buffer): Promise<void> {
  if (!config.CLAMAV_HOST) throw new ClamAVUnavailable('ClamAV is not configured');
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: config.CLAMAV_HOST, port: config.CLAMAV_PORT });
    const response: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve();
    };
    socket.setTimeout(config.CLAMAV_TIMEOUT_SECONDS * 1000, () => finish(new ClamAVUnavailable('ClamAV timed out')));
    socket.on('error', () => finish(new ClamAVUnavailable('ClamAV did not respond')));
    socket.on('data', (chunk: Buffer) => {
      response.push(chunk);
      if (chunk.includes(0)) {
        const result = Buffer.concat(response).toString('utf8').replace(/\0/g, '').trim();
        if (result.endsWith('FOUND')) finish(new MalwareDetected('Evidence was rejected by malware scanning'));
        else if (result.endsWith('OK')) finish();
        else finish(new ClamAVUnavailable('ClamAV returned an invalid response'));
      }
    });
    socket.on('connect', () => {
      socket.write(Buffer.from('zINSTREAM\0'));
      for (let offset = 0; offset < data.length; offset += 64 * 1024) {
        const chunk = data.subarray(offset, offset + 64 * 1024);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(chunk.length);
        socket.write(length);
        socket.write(chunk);
      }
      const terminator = Buffer.alloc(4);
      socket.write(terminator);
    });
  });
}

export async function saveEvidence(reportId: string, originalName: string, contentType: string, data: Buffer) {
  const rule = evidenceRules[contentType];
  const extension = extname(originalName).toLowerCase();
  if (!rule || (extension !== rule.extension && !(rule.extension === '.jpg' && extension === '.jpeg'))) {
    const error = new Error('Unsupported evidence type'); error.name = 'UnsupportedEvidence'; throw error;
  }
  if (rule.signature && !data.subarray(0, rule.signature.length).equals(rule.signature)) {
    const error = new Error('Evidence content does not match its file type'); error.name = 'UnsupportedEvidence'; throw error;
  }
  if (contentType === 'text/plain') {
    if (data.includes(0) || !Buffer.from(data.toString('utf8'), 'utf8').equals(data)) {
      const error = new Error('Text evidence must be valid UTF-8 without NUL bytes'); error.name = 'UnsupportedEvidence'; throw error;
    }
  }
  try {
    await scanWithClamAV(data);
  } catch (error) {
    if (error instanceof MalwareDetected || error instanceof ClamAVUnavailable) throw error;
    throw new ClamAVUnavailable('ClamAV scan failed');
  }
  const id = nanoid();
  const storedName = `${randomBytes(24).toString('hex')}${rule.extension}`;
  const directory = config.EVIDENCE_DIRECTORY;
  mkdirSync(directory, { recursive: true });
  const path = join(directory, storedName);
  writeFileSync(path, data, { flag: 'wx', mode: 0o600 });
  try {
    db.prepare('INSERT INTO evidence (id, report_id, stored_name, content_type, file_size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, reportId, storedName, contentType, data.length, new Date().toISOString());
  } catch (error) {
    unlinkSync(path);
    throw error;
  }
  return getEvidence(id)!;
}

export function getEvidence(id: string) {
  const row = db.prepare('SELECT id, report_id, stored_name, content_type, file_size, created_at FROM evidence WHERE id = ?').get(id) as any;
  if (!row) return null;
  return { id: row.id, reportId: row.report_id, storedName: row.stored_name, contentType: row.content_type, fileSize: row.file_size, createdAt: row.created_at };
}

export function readEvidenceFile(evidence: { storedName: string }) {
  return readFileSync(join(config.EVIDENCE_DIRECTORY, evidence.storedName));
}

export function closeReport(id: string, moderatorEmail: string) {
  const existing = getReportById(id);
  if (!existing) return null;
  if (existing.closedAt) return existing;
  if (existing.status !== 'RESOLVED' && existing.status !== 'DISMISSED') {
    const error = new Error('Only resolved or dismissed cases can be permanently closed'); error.name = 'InvalidClosure'; throw error;
  }
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    db.prepare('UPDATE reports SET closed_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    db.prepare('INSERT INTO audit_logs (id, action, report_id, moderator_email, created_at) VALUES (?, ?, ?, ?, ?)').run(nanoid(), 'CASE_CLOSED', id, moderatorEmail, now);
  });
  transaction();
  return getReportById(id);
}

export function recordModeratorAction(action: string, reportId: string, moderatorEmail: string) {
  db.prepare('INSERT INTO audit_logs (id, action, report_id, moderator_email, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(nanoid(), action, reportId, moderatorEmail, new Date().toISOString());
}
