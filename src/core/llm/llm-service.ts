import { z } from 'zod/v4';
import type { LLMProvider, LLMRequest, LLMResponse, LLMConfig } from './types.js';
import { LLMError } from './types.js';
import { PromptLoader } from './prompt-loader.js';
import { createChildLogger } from '../../logger.js';

const logger = createChildLogger('llm-service');

export interface StructuredOutputResult<T> {
  data: T;
  usage: LLMResponse['usage'];
  model: string;
  latencyMs: number;
}

/**
 * High-level LLM service for agents.
 * Wraps a provider with retry logic, prompt management, and structured output parsing.
 */
export class LLMService {
  private readonly enabled: boolean;

  constructor(
    private readonly provider: LLMProvider,
    private readonly promptLoader: PromptLoader,
    private readonly config: LLMConfig,
  ) {
    this.enabled = !!(config.baseUrl && config.apiKey);
    if (!this.enabled) {
      logger.warn('LLM service is disabled (no baseUrl or apiKey configured)');
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Load and render a prompt template.
   */
  loadPrompt(agentRole: string, promptName: string, variables?: Record<string, string>): string {
    return this.promptLoader.render(`${agentRole}/${promptName}`, variables);
  }

  /**
   * Low-level chat completion with retry logic.
   */
  async chatCompletion(request: LLMRequest): Promise<LLMResponse> {
    if (!this.enabled) {
      throw new LLMError('LLM service is not configured', false);
    }

    let lastError: Error | undefined;
    const maxRetries = this.config.maxRetries;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.provider.chatCompletion(request);

        logger.info({
          model: response.model,
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
          latencyMs: response.latencyMs,
          finishReason: response.finishReason,
        }, 'LLM call succeeded');

        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        const isRetryable = err instanceof LLMError ? err.retryable : false;
        if (!isRetryable || attempt >= maxRetries) {
          logger.error({ error: lastError, attempt, maxRetries }, 'LLM call failed (not retrying)');
          throw lastError;
        }

        const delay = this.calculateDelay(attempt);
        logger.warn({ error: lastError, attempt, nextRetryMs: delay }, 'LLM call failed, retrying');
        await this.sleep(delay);
      }
    }

    throw lastError ?? new Error('LLM call failed with no error details');
  }

  /**
   * Generate structured output: call LLM with JSON mode, parse + validate with Zod schema.
   */
  async generateStructuredOutput<T>(params: {
    systemPrompt: string;
    userPrompt: string;
    schema: z.ZodType<T>;
    temperature?: number;
    maxTokens?: number;
  }): Promise<StructuredOutputResult<T>> {
    const request: LLMRequest = {
      messages: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: params.userPrompt },
      ],
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      responseFormat: { type: 'json_object' },
    };

    const response = await this.chatCompletion(request);

    // Extract JSON from response — strip reasoning model <think> blocks, markdown fences, etc.
    let jsonStr = this.extractJSON(response.content);

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      logger.error({ raw: response.content.slice(0, 500) }, 'Failed to parse LLM response as JSON');
      throw new LLMError(
        `Failed to parse LLM response as JSON: ${response.content.slice(0, 200)}`,
        false,
      );
    }

    // Validate with Zod schema — retry once with coercion if initial validation fails
    let result = params.schema.safeParse(parsed);
    if (!result.success) {
      const coerced = this.coerceForSchema(parsed, result.error);
      if (coerced !== parsed) {
        result = params.schema.safeParse(coerced);
      }
    }
    if (!result.success) {
      const errorMsg = JSON.stringify(result.error);
      logger.error({ validationError: errorMsg.slice(0, 1000), parsedKeys: Object.keys(parsed as any) }, 'Schema validation failed');
      throw new LLMError(
        `LLM response failed schema validation: ${errorMsg}`,
        false,
      );
    }

    return {
      data: result.data,
      usage: response.usage,
      model: response.model,
      latencyMs: response.latencyMs,
    };
  }

  private calculateDelay(attempt: number): number {
    const baseDelay = 1000;
    const exponential = baseDelay * Math.pow(2, attempt);
    const jitter = Math.random() * baseDelay * 0.5;
    return exponential + jitter;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Extract JSON content from LLM response.
   * Handles reasoning model <think>...</think> blocks, markdown fences, etc.
   */
  private extractJSON(raw: string): string {
    let str = raw.trim();

    // Strip <think>...</think> blocks (reasoning models like MiniMax-M2.5)
    str = str.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    // Handle unclosed <think> blocks (model stopped mid-reasoning or no closing tag)
    if (str.includes('<think>')) {
      str = str.replace(/<think>[\s\S]*/g, '').trim();
    }

    // Strip markdown code fences
    const fenceMatch = str.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      str = fenceMatch[1].trim();
    }

    // If still not starting with { or [, try to find the first JSON object
    if (!str.startsWith('{') && !str.startsWith('[')) {
      const jsonStart = str.search(/[{\[]/);
      if (jsonStart >= 0) {
        str = str.slice(jsonStart);
      }
    }

    return str;
  }

  /**
   * Auto-coerce LLM output to match schema expectations.
   * LLMs often return objects where strings are expected (e.g. { category: "...", description: "..." }
   * instead of a plain string). This walks the Zod error paths and converts mismatched values.
   */
  private coerceForSchema(data: unknown, error: z.core.$ZodError): unknown {
    const clone = JSON.parse(JSON.stringify(data));

    for (const issue of error.issues) {
      if (issue.code !== 'invalid_type' || issue.path.length === 0) continue;

      let parent = clone;
      for (let i = 0; i < issue.path.length - 1; i++) {
        parent = parent[issue.path[i]];
        if (parent == null) break;
      }
      if (parent == null) continue;

      const key = issue.path[issue.path.length - 1];
      const val = parent[key];

      if (issue.expected === 'string' && val != null && typeof val === 'object' && !Array.isArray(val)) {
        // Object → string: flatten to most descriptive field
        parent[key] = val.description ?? val.name ?? val.content ?? val.text ?? val.summary ?? JSON.stringify(val);
      } else if (issue.expected === 'string' && val != null && typeof val !== 'string') {
        // number/boolean → string
        parent[key] = String(val);
      } else if (issue.expected === 'number' && typeof val === 'string') {
        // string → number (e.g. "15" → 15)
        const num = Number(val);
        if (!Number.isNaN(num)) parent[key] = num;
      } else if (issue.expected === 'array' && val != null && !Array.isArray(val)) {
        // Single value → array: wrap in array
        parent[key] = [val];
      }
    }

    return clone;
  }
}
