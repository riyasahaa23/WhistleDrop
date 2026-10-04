import { z } from 'zod';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

// Support both `npm run dev` from the monorepo root and workspace-local starts.
loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), '../../.env') });

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_PATH: z.string().default('./data/whistledrop.db'),
  MODERATOR_TOKEN: z.string().min(32),
  EVIDENCE_DIRECTORY: z.string().default('./data/evidence'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(10_485_760).default(5_242_880),
  CLAMAV_HOST: z.string().default(''),
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),
  CLAMAV_TIMEOUT_SECONDS: z.coerce.number().positive().default(15),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000)
});

export const config = envSchema.parse(process.env);
