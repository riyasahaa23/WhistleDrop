import { z } from 'zod';

export const categories = ['SECURITY', 'HARASSMENT', 'CORRUPTION', 'TECHNICAL', 'OTHER'] as const;
export const statuses = ['SUBMITTED', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED'] as const;
export type Category = (typeof categories)[number];
export type Status = (typeof statuses)[number];

export const createReportSchema = z.object({
  category: z.enum(categories),
  description: z.string().trim().min(10).max(10_000),
  evidenceUrl: z.string().url().max(2_048).optional()
}).strict();

export const trackReportSchema = z.object({ caseCode: z.string().regex(/^[A-Z2-9]{26}$/) });
export const trackReportBodySchema = trackReportSchema.strict();
export const listReportsQuerySchema = z.object({
  category: z.enum(categories).optional(),
  status: z.enum(statuses).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  createdAfter: z.string().datetime({ offset: true }).optional(),
  createdBefore: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0)
});
export const updateReportSchema = z.object({
  status: z.enum(statuses),
  update: z.string().trim().min(1).max(1_000)
}).strict();
export const addUpdateSchema = z.object({ update: z.string().trim().min(1).max(1_000) }).strict();
export type Report = {
  id: string;
  category: Category;
  description: string;
  evidenceUrl: string | null;
  status: Status;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  updates: { status: Status; message: string; createdAt: string }[];
  evidence: Evidence[];
};

export type Evidence = {
  id: string;
  contentType: string;
  fileSize: number;
  createdAt: string;
};
