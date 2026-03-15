import type { LLMProvider, LLMRequest, LLMResponse, LLMConfig } from '../types.js';
import { LLMError } from '../types.js';
import { createChildLogger } from '../../../logger.js';

const logger = createChildLogger('llm:openai-compatible');

/**
 * OpenAI-compatible LLM provider.
 * Works with any API that implements the /v1/chat/completions endpoint:
 * OpenAI, MiniMax, Deepseek, Moonshot, Ollama, vLLM, etc.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = 'openai-compatible';

  constructor(private readonly config: LLMConfig) {}

  async chatCompletion(request: LLMRequest): Promise<LLMResponse> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const body = {
      model: this.config.model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: request.temperature ?? this.config.temperature,
      max_tokens: request.maxTokens ?? this.config.maxTokens,
      ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
    };

    logger.debug({ url, model: this.config.model }, 'Sending chat completion request');

    const startTime = performance.now();

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new LLMError(
        `Network error calling ${url}: ${message}`,
        true, // network errors are retryable
      );
    }

    const latencyMs = Math.round(performance.now() - startTime);

    if (!res.ok) {
      let errorBody = '';
      try {
        errorBody = await res.text();
      } catch {
        // ignore
      }

      const retryable = res.status === 429 || res.status >= 500;
      throw new LLMError(
        `LLM API error ${res.status}: ${errorBody}`,
        retryable,
        res.status,
      );
    }

    const data = await res.json() as {
      choices?: Array<{
        message?: { content?: string };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
      model?: string;
    };

    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? '';
    const usage = data.usage;

    return {
      content,
      usage: {
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? 0,
      },
      model: data.model ?? this.config.model,
      latencyMs,
      finishReason: choice?.finish_reason ?? 'unknown',
    };
  }
}
