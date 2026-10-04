import Fastify, { type FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './config.js';
import { addUpdateSchema, createReportSchema, listReportsQuerySchema, trackReportBodySchema, trackReportSchema, updateReportSchema } from './domain.js';
import { addReportUpdate, closeReport, createReport, getEvidence, getReportByCaseCode, listReports, readEvidenceFile, recordModeratorAction, saveEvidence, updateReport } from './repository.js';

export async function buildApp(options: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 20_000 });
  await app.register(helmet);
  await app.register(cors, { origin: false });
  await app.register(rateLimit, { max: config.RATE_LIMIT_MAX, timeWindow: config.RATE_LIMIT_WINDOW_MS });
  await app.register(multipart, { limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1, fields: 0 } });
  await app.register(swagger, { openapi: { info: { title: 'WhistleDrop API', description: 'Confidential anonymous reporting API', version: '1.0.0' }, servers: [{ url: `http://localhost:${config.PORT}` }], tags: [{ name: 'Public' }, { name: 'Moderator' }] } });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.decorate('authenticate', async function (request: any, reply: any) {
    const authorization = request.headers.authorization ?? '';
    const [scheme, supplied = ''] = authorization.split(' ');
    const expected = Buffer.from(config.MODERATOR_TOKEN);
    const received = Buffer.from(scheme?.toLowerCase() === 'bearer' ? supplied : '');
    const valid = received.length === expected.length && timingSafeEqual(received, expected);
    if (!valid) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Moderator authentication required.' });
    }
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.post('/api/v1/reports', async (request, reply) => {
    const parsed = createReportSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
    const result = createReport(parsed.data);
    return reply.header('Cache-Control', 'no-store').code(201).send({ message: 'Report submitted successfully.', caseCode: result.caseCode, report: { status: result.report.status, createdAt: result.report.createdAt } });
  });
  app.get('/api/v1/reports/:caseCode', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = trackReportSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: 'NotFound', message: 'Report not found.' });
    const report = getReportByCaseCode(parsed.data.caseCode);
    if (!report) return reply.code(404).send({ error: 'NotFound', message: 'Report not found.' });
    return { caseCode: parsed.data.caseCode, category: report.category, status: report.status, closed: Boolean(report.closedAt), updates: report.updates, createdAt: report.createdAt, updatedAt: report.updatedAt };
  });
  app.post('/api/v1/reports/track', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = trackReportBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(404).send({ error: 'NotFound', message: 'Report not found.' });
    const report = getReportByCaseCode(parsed.data.caseCode);
    if (!report) return reply.code(404).send({ error: 'NotFound', message: 'Report not found.' });
    return { caseCode: parsed.data.caseCode, category: report.category, status: report.status, closed: Boolean(report.closedAt), updates: report.updates, createdAt: report.createdAt, updatedAt: report.updatedAt };
  });
  app.post('/api/v1/reports/:caseCode/evidence', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = trackReportSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: 'NotFound', message: 'Report not found.' });
    const report = getReportByCaseCode(parsed.data.caseCode);
    if (!report) return reply.code(404).send({ error: 'NotFound', message: 'Report not found.' });
    if (report.closedAt) return reply.code(409).send({ error: 'CaseClosed', message: 'This case is permanently closed.' });
    try {
      const file = await (request as any).file();
      if (!file) return reply.code(400).send({ error: 'ValidationError', message: 'An evidence file is required.' });
      const data = await file.toBuffer();
      const evidence = await saveEvidence(report.id, file.filename, file.mimetype, data);
      return reply.code(201).send({ message: 'Evidence uploaded.', evidence: { id: evidence.id, contentType: evidence.contentType, fileSize: evidence.fileSize, createdAt: evidence.createdAt } });
    } catch (error: any) {
      if (error.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'PayloadTooLarge', message: 'Evidence exceeds the upload size limit.' });
      if (error.name === 'UnsupportedEvidence') return reply.code(415).send({ error: error.name, message: error.message });
      if (error.name === 'MalwareDetected') return reply.code(422).send({ error: error.name, message: error.message });
      if (error.name === 'ClamAVUnavailable') return reply.code(503).send({ error: error.name, message: error.message });
      throw error;
    }
  });
  app.get('/api/v1/moderator/reports', { preHandler: (app as any).authenticate }, async (request, reply) => {
    const parsed = listReportsQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'ValidationError', message: 'Invalid category, status, limit, or offset.' });
    const result = listReports(parsed.data);
    return {
      reports: result.reports.map(toModeratorReport),
      total: result.total,
      limit: parsed.data.limit,
      offset: parsed.data.offset
    };
  });
  app.patch('/api/v1/moderator/reports/:id', { preHandler: (app as any).authenticate }, async (request, reply) => {
    const parsed = updateReportSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
    try {
      const reportId = (request.params as { id: string }).id;
      const report = updateReport(reportId, parsed.data.status, parsed.data.update);
      if (!report) return reply.code(404).send({ error: 'NotFound', message: 'Report not found.' });
      recordModeratorAction('STATUS_UPDATED', reportId, 'moderator-token');
      return { message: 'Report updated.', report: toModeratorReport(report) };
    } catch (error: any) {
      if (error.name === 'InvalidTransition' || error.name === 'CaseClosed') return reply.code(409).send({ error: error.name, message: error.message });
      throw error;
    }
  });
  app.post('/api/v1/moderator/reports/:id/updates', { preHandler: (app as any).authenticate }, async (request, reply) => {
    const parsed = addUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
    const reportId = (request.params as { id: string }).id;
    try {
      const report = addReportUpdate(reportId, parsed.data.update);
      if (!report) return reply.code(404).send({ error: 'NotFound', message: 'Report not found.' });
      recordModeratorAction('UPDATE_ADDED', reportId, 'moderator-token');
      return { message: 'Update added.', update: report.updates.at(-1), report: toModeratorReport(report) };
    } catch (error: any) {
      if (error.name === 'CaseClosed') return reply.code(409).send({ error: error.name, message: error.message });
      throw error;
    }
  });
  app.post('/api/v1/moderator/reports/:id/close', { preHandler: (app as any).authenticate }, async (request, reply) => {
    const reportId = (request.params as { id: string }).id;
    try {
      const report = closeReport(reportId, 'moderator-token');
      if (!report) return reply.code(404).send({ error: 'NotFound', message: 'Report not found.' });
      return { message: 'Case permanently closed.', report: toModeratorReport(report) };
    } catch (error: any) {
      if (error.name === 'InvalidClosure' || error.name === 'CaseClosed') return reply.code(409).send({ error: error.name, message: error.message });
      throw error;
    }
  });
  app.get('/api/v1/moderator/reports/:id/evidence/:evidenceId', { preHandler: (app as any).authenticate }, async (request, reply) => {
    const params = request.params as { id: string; evidenceId: string };
    const evidence = getEvidence(params.evidenceId);
    if (!evidence || evidence.reportId !== params.id) return reply.code(404).send({ error: 'NotFound', message: 'Evidence not found.' });
    reply.header('Content-Type', evidence.contentType);
    reply.header('Content-Disposition', `attachment; filename="evidence-${evidence.id}${evidence.storedName.slice(evidence.storedName.lastIndexOf('.'))}"`);
    return reply.send(readEvidenceFile(evidence));
  });
  app.setErrorHandler((error, _request, reply) => { app.log.error(error); return reply.code((error as any).statusCode ?? 500).send({ error: 'InternalServerError', message: 'An unexpected error occurred.' }); });
  return app;
}

function toModeratorReport(report: NonNullable<ReturnType<typeof updateReport>>) {
  return {
    id: report.id,
    category: report.category,
    description: report.description,
    evidenceUrl: report.evidenceUrl,
    status: report.status,
    closedAt: report.closedAt,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    updates: report.updates,
    evidence: report.evidence
  };
}
