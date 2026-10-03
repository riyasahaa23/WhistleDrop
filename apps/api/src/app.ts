import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { createReportSchema, listReportsQuerySchema, loginSchema, trackReportSchema, updateReportSchema } from './domain.js';
import { createReport, getReportByCaseCode, listReports, updateReport } from './repository.js';

export async function buildApp(options: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 20_000 });
  await app.register(helmet);
  await app.register(cors, { origin: false });
  await app.register(jwt, { secret: config.MODERATOR_JWT_SECRET });
  await app.register(rateLimit, { max: config.RATE_LIMIT_MAX, timeWindow: config.RATE_LIMIT_WINDOW_MS });

  app.decorate('authenticate', async function (request: any, reply: any) {
    try { await request.jwtVerify(); } catch { return reply.code(401).send({ error: 'Unauthorized', message: 'Moderator authentication required.' }); }
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.post('/api/v1/reports', async (request, reply) => {
    const parsed = createReportSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
    const result = createReport(parsed.data);
    return reply.code(201).send({ message: 'Report submitted successfully.', caseCode: result.caseCode, report: { status: result.report.status, createdAt: result.report.createdAt } });
  });
  app.get('/api/v1/reports/:caseCode', async (request, reply) => {
    const parsed = trackReportSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: 'NotFound', message: 'Report not found.' });
    const report = getReportByCaseCode(parsed.data.caseCode);
    if (!report) return reply.code(404).send({ error: 'NotFound', message: 'Report not found.' });
    return { caseCode: parsed.data.caseCode, category: report.category, status: report.status, updates: report.updates, createdAt: report.createdAt, updatedAt: report.updatedAt };
  });
  app.post('/api/v1/moderator/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success || parsed.data.email !== config.MODERATOR_EMAIL || parsed.data.password !== config.MODERATOR_PASSWORD) return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid moderator credentials.' });
    return { accessToken: app.jwt.sign({ role: 'moderator', email: config.MODERATOR_EMAIL }, { expiresIn: '1h' }), tokenType: 'Bearer', expiresIn: 3600 };
  });
  app.get('/api/v1/moderator/reports', { preHandler: (app as any).authenticate }, async (request, reply) => {
    const parsed = listReportsQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'ValidationError', message: 'Invalid category, status, limit, or offset.' });
    return { reports: listReports(parsed.data) };
  });
  app.patch('/api/v1/moderator/reports/:id', { preHandler: (app as any).authenticate }, async (request, reply) => {
    const parsed = updateReportSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
    try {
      const report = updateReport((request.params as { id: string }).id, parsed.data.status, parsed.data.update);
      if (!report) return reply.code(404).send({ error: 'NotFound', message: 'Report not found.' });
      return { message: 'Report updated.', report };
    } catch (error: any) {
      if (error.name === 'InvalidTransition') return reply.code(409).send({ error: 'InvalidStatusTransition', message: error.message });
      throw error;
    }
  });
  app.setErrorHandler((error, _request, reply) => { app.log.error(error); return reply.code((error as any).statusCode ?? 500).send({ error: 'InternalServerError', message: 'An unexpected error occurred.' }); });
  return app;
}
