import { beforeEach, describe, expect, it } from 'vitest';
import { unlinkSync, existsSync } from 'node:fs';

process.env.DATABASE_PATH = './data/test-whistledrop.db';
const databasePath = process.env.DATABASE_PATH;
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

  it('requires moderator authentication', async () => {
    const app = await appPromise;
    const response = await app.inject({ method: 'GET', url: '/api/v1/moderator/reports' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects invalid workflow transitions', async () => {
    const app = await appPromise;
    const login = await app.inject({ method: 'POST', url: '/api/v1/moderator/login', payload: { email: process.env.MODERATOR_EMAIL ?? 'moderator@example.com', password: process.env.MODERATOR_PASSWORD ?? 'change-me-in-development' } });
    const submitted = await app.inject({ method: 'POST', url: '/api/v1/reports', payload: { category: 'TECHNICAL', description: 'A technical issue that needs attention.' } });
    const reports = await app.inject({ method: 'GET', url: '/api/v1/moderator/reports', headers: { authorization: `Bearer ${login.json().accessToken}` } });
    const id = reports.json().reports[0].id;
    const response = await app.inject({ method: 'PATCH', url: `/api/v1/moderator/reports/${id}`, headers: { authorization: `Bearer ${login.json().accessToken}` }, payload: { status: 'RESOLVED', update: 'Attempted invalid transition.' } });
    expect(response.statusCode).toBe(409);
    void submitted;
  });
});
