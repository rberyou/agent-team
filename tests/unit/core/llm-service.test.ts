import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod/v4';
import { LLMService } from '../../../src/core/llm/llm-service.js';
import { PromptLoader } from '../../../src/core/llm/prompt-loader.js';
import { LLMError } from '../../../src/core/llm/types.js';
import type { LLMProvider, LLMResponse, LLMConfig } from '../../../src/core/llm/types.js';

// --- Mock provider ---
function createMockProvider(responses: Array<LLMResponse | Error>): LLMProvider {
  let callIndex = 0;
  return {
    name: 'mock',
    async chatCompletion() {
      const response = responses[callIndex++];
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function makeResponse(content: string, overrides?: Partial<LLMResponse>): LLMResponse {
  return {
    content,
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    model: 'mock-model',
    latencyMs: 100,
    finishReason: 'stop',
    ...overrides,
  };
}

const enabledConfig: LLMConfig = {
  provider: 'mock',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'test-key',
  model: 'mock-model',
  temperature: 0.7,
  maxTokens: 4096,
  timeoutMs: 5000,
  maxRetries: 2,
};

const disabledConfig: LLMConfig = {
  ...enabledConfig,
  baseUrl: '',
  apiKey: '',
};

// Minimal prompt loader with in-memory templates
function createMockPromptLoader(templates: Record<string, string>): PromptLoader {
  const loader = new PromptLoader('/nonexistent');
  // Directly inject templates into the internal map
  const map = (loader as any).templates as Map<string, string>;
  for (const [key, value] of Object.entries(templates)) {
    map.set(key, value);
  }
  return loader;
}

describe('LLMService', () => {
  describe('isEnabled', () => {
    it('should be enabled when baseUrl and apiKey are configured', () => {
      const provider = createMockProvider([]);
      const service = new LLMService(provider, createMockPromptLoader({}), enabledConfig);
      expect(service.isEnabled).toBe(true);
    });

    it('should be disabled when baseUrl is empty', () => {
      const provider = createMockProvider([]);
      const service = new LLMService(provider, createMockPromptLoader({}), disabledConfig);
      expect(service.isEnabled).toBe(false);
    });
  });

  describe('chatCompletion', () => {
    it('should return response on success', async () => {
      const provider = createMockProvider([makeResponse('Hello')]);
      const service = new LLMService(provider, createMockPromptLoader({}), enabledConfig);

      const response = await service.chatCompletion({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.content).toBe('Hello');
    });

    it('should throw when service is disabled', async () => {
      const provider = createMockProvider([]);
      const service = new LLMService(provider, createMockPromptLoader({}), disabledConfig);

      await expect(
        service.chatCompletion({ messages: [{ role: 'user', content: 'Hi' }] }),
      ).rejects.toThrow('LLM service is not configured');
    });

    it('should retry on retryable error and succeed', async () => {
      const provider = createMockProvider([
        new LLMError('Rate limited', true, 429),
        makeResponse('Success after retry'),
      ]);
      const service = new LLMService(provider, createMockPromptLoader({}), {
        ...enabledConfig,
        maxRetries: 2,
      });

      // Override sleep to avoid actual delay
      (service as any).sleep = () => Promise.resolve();

      const response = await service.chatCompletion({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.content).toBe('Success after retry');
    });

    it('should not retry non-retryable errors', async () => {
      const provider = createMockProvider([
        new LLMError('Unauthorized', false, 401),
        makeResponse('Should not reach'),
      ]);
      const service = new LLMService(provider, createMockPromptLoader({}), enabledConfig);

      await expect(
        service.chatCompletion({ messages: [{ role: 'user', content: 'Hi' }] }),
      ).rejects.toThrow('Unauthorized');
    });

    it('should throw after exhausting retries', async () => {
      const provider = createMockProvider([
        new LLMError('Error 1', true),
        new LLMError('Error 2', true),
        new LLMError('Error 3', true),
      ]);
      const service = new LLMService(provider, createMockPromptLoader({}), {
        ...enabledConfig,
        maxRetries: 2,
      });

      (service as any).sleep = () => Promise.resolve();

      await expect(
        service.chatCompletion({ messages: [{ role: 'user', content: 'Hi' }] }),
      ).rejects.toThrow('Error 3');
    });
  });

  describe('generateStructuredOutput', () => {
    const testSchema = z.object({
      title: z.string(),
      count: z.number(),
    });

    it('should parse and validate JSON response', async () => {
      const provider = createMockProvider([
        makeResponse(JSON.stringify({ title: 'Test', count: 42 })),
      ]);
      const service = new LLMService(provider, createMockPromptLoader({}), enabledConfig);

      const result = await service.generateStructuredOutput({
        systemPrompt: 'System',
        userPrompt: 'User',
        schema: testSchema,
      });

      expect(result.data).toEqual({ title: 'Test', count: 42 });
      expect(result.usage.totalTokens).toBe(30);
      expect(result.model).toBe('mock-model');
    });

    it('should throw on invalid JSON', async () => {
      const provider = createMockProvider([
        makeResponse('not json at all'),
      ]);
      const service = new LLMService(provider, createMockPromptLoader({}), enabledConfig);

      await expect(
        service.generateStructuredOutput({
          systemPrompt: 'S',
          userPrompt: 'U',
          schema: testSchema,
        }),
      ).rejects.toThrow('Failed to parse LLM response as JSON');
    });

    it('should throw on schema validation failure', async () => {
      const provider = createMockProvider([
        makeResponse(JSON.stringify({ title: 'Test', count: 'not a number' })),
      ]);
      const service = new LLMService(provider, createMockPromptLoader({}), enabledConfig);

      await expect(
        service.generateStructuredOutput({
          systemPrompt: 'S',
          userPrompt: 'U',
          schema: testSchema,
        }),
      ).rejects.toThrow('failed schema validation');
    });
  });

  describe('loadPrompt', () => {
    it('should load and render prompts', () => {
      const loader = createMockPromptLoader({
        'test-agent/greeting': 'Hello {{name}}!',
      });
      const service = new LLMService(createMockProvider([]), loader, enabledConfig);

      const result = service.loadPrompt('test-agent', 'greeting', { name: 'World' });
      expect(result).toBe('Hello World!');
    });
  });
});
