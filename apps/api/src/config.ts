import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_PATH: z.string().default('./data/whistledrop.db'),
  MODERATOR_JWT_SECRET: z.string().min(32).default('local-development-secret-change-me-32-chars'),
  MODERATOR_EMAIL: z.string().email().default('moderator@example.com'),
  MODERATOR_PASSWORD: z.string().min(8).default('change-me-in-development'),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000)
});

export const config = envSchema.parse(process.env);
