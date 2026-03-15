import { z } from 'zod/v4';

// --- Chat message (OpenAI compatible format) ---

export const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

// --- LLM request ---

export const llmRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  responseFormat: z
    .object({ type: z.enum(['text', 'json_object']) })
    .optional(),
});

export type LLMRequest = z.infer<typeof llmRequestSchema>;

// --- LLM response ---

export const llmUsageSchema = z.object({
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  totalTokens: z.number().int(),
});

export type LLMUsage = z.infer<typeof llmUsageSchema>;

export const llmResponseSchema = z.object({
  content: z.string(),
  usage: llmUsageSchema,
  model: z.string(),
  latencyMs: z.number(),
  finishReason: z.string(),
});

export type LLMResponse = z.infer<typeof llmResponseSchema>;

// --- LLM provider interface ---

export interface LLMProvider {
  readonly name: string;
  chatCompletion(request: LLMRequest): Promise<LLMResponse>;
}

// --- LLM error with retryable flag ---

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

// --- LLM config schema ---

export const llmConfigSchema = z.object({
  provider: z.string().default('openai-compatible'),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  model: z.string().default(''),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.coerce.number().int().positive().default(4096),
  timeoutMs: z.coerce.number().int().positive().default(60000),
  maxRetries: z.coerce.number().int().min(0).default(3),
});

export type LLMConfig = z.infer<typeof llmConfigSchema>;
