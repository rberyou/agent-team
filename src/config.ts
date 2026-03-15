import { z } from 'zod/v4';
import { resolve } from 'node:path';

const configSchema = z.object({
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  host: z.string().min(1).default('localhost'),
  dataDir: z.string().min(1).default('.agent-team'),
  logLevel: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // LLM configuration
  llmProvider: z.string().default('openai-compatible'),
  llmBaseUrl: z.string().default(''),
  llmApiKey: z.string().default(''),
  llmModel: z.string().default(''),
  llmTemperature: z.coerce.number().min(0).max(2).default(0.7),
  llmMaxTokens: z.coerce.number().int().positive().default(4096),
  llmTimeoutMs: z.coerce.number().int().positive().default(60000),
  llmMaxRetries: z.coerce.number().int().min(0).default(3),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  const raw = {
    nodeEnv: process.env['NODE_ENV'],
    port: process.env['PORT'],
    host: process.env['HOST'],
    dataDir: process.env['DATA_DIR'],
    logLevel: process.env['LOG_LEVEL'],
    llmProvider: process.env['LLM_PROVIDER'],
    llmBaseUrl: process.env['LLM_BASE_URL'],
    llmApiKey: process.env['LLM_API_KEY'],
    llmModel: process.env['LLM_MODEL'],
    llmTemperature: process.env['LLM_TEMPERATURE'],
    llmMaxTokens: process.env['LLM_MAX_TOKENS'],
    llmTimeoutMs: process.env['LLM_TIMEOUT_MS'],
    llmMaxRetries: process.env['LLM_MAX_RETRIES'],
  };

  const result = configSchema.safeParse(raw);

  if (!result.success) {
    const formatted = z.prettifyError(result.error);
    throw new Error(`Invalid configuration:\n${formatted}`);
  }

  const config = result.data;

  // Resolve dataDir to absolute path
  if (!config.dataDir.startsWith('/')) {
    config.dataDir = resolve(process.cwd(), config.dataDir);
  }

  return Object.freeze(config);
}

export const config = loadConfig();
