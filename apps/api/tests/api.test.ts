import { beforeEach, describe, expect, it } from 'vitest';
import { unlinkSync, existsSync } from 'node:fs';

process.env.DATABASE_PATH = './data/test-whistledrop.db';
process.env.MODERATOR_TOKEN ??= 'local-development-moderator-token-change-me';
const databasePath = process.env.DATABASE_PATH;
const moderatorToken = process.env.MODERATOR_TOKEN ?? 'local-development-moderator-token-change-me';
if (existsSync(databasePath)) unlinkSync(databasePath);
const { buildApp } = await import('../src/app.js');
const { db } = await import('../src/db.js');

describe('WhistleDrop API', () => {
  const appPromise = buildApp();
  beforeEach(() => { db.exec('DELETE FROM report_updates; DELETE FROM reports;'); });

  it('submits an anonymous report and returns a strong case code', async () => {
    const app = await appPromise;
    const response = await app.inject({ method: 'POST', url: '/api/v1/reports', payload: { category: 'SECURITY', description: 'A serious security issue exists in the building.' } });
    expect(response.statusCode).toBe(201);
    expect(response.json().caseCode).toMatch(/^[A-Z2-9]{26}$/);
  });

  it('tracks a report without returning the description or identity', async () => {
    const app = await appPromise;
    const submitted = await app.inject({ method: 'POST', url: '/api/v1/reports', payload: { category: 'OTHER', description: 'Something needs confidential review.' } });
    const tracked = await app.inject({ method: 'GET', url: `/api/v1/reports/${submitted.json().caseCode}` });
    expect(tracked.statusCode).toBe(200);
    expect(tracked.json().description).toBeUndefined();
    expect(tracked.json().updates[0].status).toBe('SUBMITTED');
  });

  it('supports privacy-preferred body-based tracking without caching', async () => {
    const app = await appPromise;
    const submitted = await app.inject({ method: 'POST', url: '/api/v1/reports', payload: { category: 'OTHER', description: 'A body-tracked confidential report.' } });
    const tracked = await app.inject({ method: 'POST', url: '/api/v1/reports/track', payload: { caseCode: submitted.json().caseCode } });
    expect(tracked.statusCode).toBe(200);
    expect(tracked.headers['cache-control']).toBe('no-store');
    expect(tracked.json().description).toBeUndefined();
  });

  it('requires moderator authentication', async () => {
    const app = await appPromise;
    const response = await app.inject({ method: 'GET', url: '/api/v1/moderator/reports' });
    expect(response.statusCode).toBe(401);
  });

  it('does not expose the case-code hash to moderators', async () => {
    const app = await appPromise;
    await app.inject({ method: 'POST', url: '/api/v1/reports', payload: { category: 'SECURITY', description: 'A confidential security report for review.' } });
    const response = await app.inject({ method: 'GET', url: '/api/v1/moderator/reports', headers: { authorization: `Bearer ${moderatorToken}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json().reports[0].caseCodeHash).toBeUndefined();
  });

  it('rejects invalid workflow transitions', async () => {
    const app = await appPromise;
    const submitted = await app.inject({ method: 'POST', url: '/api/v1/reports', payload: { category: 'TECHNICAL', description: 'A technical issue that needs attention.' } });
    const reports = await app.inject({ method: 'GET', url: '/api/v1/moderator/reports', headers: { authorization: `Bearer ${moderatorToken}` } });
    const id = reports.json().reports[0].id;
    const response = await app.inject({ method: 'PATCH', url: `/api/v1/moderator/reports/${id}`, headers: { authorization: `Bearer ${moderatorToken}` }, payload: { status: 'RESOLVED', update: 'Attempted invalid transition.' } });
    expect(response.statusCode).toBe(409);
    void submitted;
  });

  it('allows a moderator update without changing the report status', async () => {
    const app = await appPromise;
    const submitted = await app.inject({ method: 'POST', url: '/api/v1/reports', payload: { category: 'TECHNICAL', description: 'A report that needs a progress update.' } });
    const reportId = (await app.inject({ method: 'GET', url: '/api/v1/moderator/reports', headers: { authorization: `Bearer ${moderatorToken}` } })).json().reports[0].id;
    const response = await app.inject({ method: 'POST', url: `/api/v1/moderator/reports/${reportId}/updates`, headers: { authorization: `Bearer ${moderatorToken}` }, payload: { update: 'The review team is continuing its assessment.' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().report.status).toBe('SUBMITTED');
    const tracked = await app.inject({ method: 'POST', url: '/api/v1/reports/track', payload: { caseCode: submitted.json().caseCode } });
    expect(tracked.json().updates.at(-1).message).toContain('continuing');
  });

  it('validates evidence uploads and keeps downloads moderator-only', async () => {
    const app = await appPromise;
    const submitted = await app.inject({ method: 'POST', url: '/api/v1/reports', payload: { category: 'SECURITY', description: 'A report with a validated evidence file.' } });
    const boundary = 'whistledrop-test-boundary';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="evidence.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from('%PDF-1.7 test evidence'),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const uploaded = await app.inject({ method: 'POST', url: `/api/v1/reports/${submitted.json().caseCode}/evidence`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect([201, 503]).toContain(uploaded.statusCode);
    if (uploaded.statusCode === 503) {
      expect(uploaded.json().error).toBe('ClamAVUnavailable');
      return;
    }
    const evidenceId = uploaded.json().evidence.id;
    const unauthorized = await app.inject({ method: 'GET', url: `/api/v1/moderator/reports/nope/evidence/${evidenceId}` });
    expect(unauthorized.statusCode).toBe(401);
  });

  it('exposes OpenAPI docs and supports permanent closure', async () => {
    const app = await appPromise;
    const docs = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(docs.statusCode).toBe(200);
    expect(docs.json().info.title).toBe('WhistleDrop API');

    const submitted = await app.inject({ method: 'POST', url: '/api/v1/reports', payload: { category: 'OTHER', description: 'A report that should be permanently closed.' } });
    const reports = await app.inject({ method: 'GET', url: '/api/v1/moderator/reports', headers: { authorization: `Bearer ${moderatorToken}` } });
    const id = reports.json().reports[0].id;
    await app.inject({ method: 'PATCH', url: `/api/v1/moderator/reports/${id}`, headers: { authorization: `Bearer ${moderatorToken}` }, payload: { status: 'UNDER_REVIEW', update: 'Review started.' } });
    await app.inject({ method: 'PATCH', url: `/api/v1/moderator/reports/${id}`, headers: { authorization: `Bearer ${moderatorToken}` }, payload: { status: 'RESOLVED', update: 'Review completed.' } });
    const closed = await app.inject({ method: 'POST', url: `/api/v1/moderator/reports/${id}/close`, headers: { authorization: `Bearer ${moderatorToken}` } });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().report.closedAt).toBeTruthy();
    void submitted;
  });
});
