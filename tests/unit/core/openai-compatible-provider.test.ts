import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatibleProvider } from '../../../src/core/llm/providers/openai-compatible.js';
import { LLMError } from '../../../src/core/llm/types.js';
import type { LLMConfig, LLMRequest } from '../../../src/core/llm/types.js';

const defaultConfig: LLMConfig = {
  provider: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'test-key',
  model: 'test-model',
  temperature: 0.7,
  maxTokens: 4096,
  timeoutMs: 5000,
  maxRetries: 3,
};

const simpleRequest: LLMRequest = {
  messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' },
  ],
};

function mockFetchSuccess(content: string, usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage,
      model: 'test-model',
    }),
  });
}

describe('OpenAICompatibleProvider', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should make a successful request and parse response', async () => {
    const mockFetch = mockFetchSuccess('Hello! How can I help?');
    globalThis.fetch = mockFetch;

    const provider = new OpenAICompatibleProvider(defaultConfig);
    const response = await provider.chatCompletion(simpleRequest);

    expect(response.content).toBe('Hello! How can I help?');
    expect(response.usage.promptTokens).toBe(10);
    expect(response.usage.completionTokens).toBe(20);
    expect(response.usage.totalTokens).toBe(30);
    expect(response.model).toBe('test-model');
    expect(response.finishReason).toBe('stop');
    expect(response.latencyMs).toBeGreaterThanOrEqual(0);

    // Verify request body
    const call = mockFetch.mock.calls[0];
    expect(call[0]).toBe('https://api.example.com/v1/chat/completions');
    const body = JSON.parse(call[1].body);
    expect(body.model).toBe('test-model');
    expect(body.messages).toHaveLength(2);
    expect(body.temperature).toBe(0.7);
  });

  it('should include response_format when specified', async () => {
    const mockFetch = mockFetchSuccess('{"result": true}');
    globalThis.fetch = mockFetch;

    const provider = new OpenAICompatibleProvider(defaultConfig);
    const request: LLMRequest = {
      ...simpleRequest,
      responseFormat: { type: 'json_object' },
    };
    await provider.chatCompletion(request);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('should include Authorization header', async () => {
    globalThis.fetch = mockFetchSuccess('ok');

    const provider = new OpenAICompatibleProvider(defaultConfig);
    await provider.chatCompletion(simpleRequest);

    const headers = (globalThis.fetch as any).mock.calls[0][1].headers;
    expect(headers['Authorization']).toBe('Bearer test-key');
  });

  it('should throw retryable LLMError on 429', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'Rate limited',
    });

    const provider = new OpenAICompatibleProvider(defaultConfig);

    try {
      await provider.chatCompletion(simpleRequest);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      expect((err as LLMError).retryable).toBe(true);
      expect((err as LLMError).statusCode).toBe(429);
    }
  });

  it('should throw retryable LLMError on 500', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Server error',
    });

    const provider = new OpenAICompatibleProvider(defaultConfig);

    try {
      await provider.chatCompletion(simpleRequest);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      expect((err as LLMError).retryable).toBe(true);
      expect((err as LLMError).statusCode).toBe(500);
    }
  });

  it('should throw non-retryable LLMError on 401', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    const provider = new OpenAICompatibleProvider(defaultConfig);

    try {
      await provider.chatCompletion(simpleRequest);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      expect((err as LLMError).retryable).toBe(false);
      expect((err as LLMError).statusCode).toBe(401);
    }
  });

  it('should throw retryable LLMError on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));

    const provider = new OpenAICompatibleProvider(defaultConfig);

    try {
      await provider.chatCompletion(simpleRequest);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      expect((err as LLMError).retryable).toBe(true);
    }
  });

  it('should override temperature and maxTokens from request', async () => {
    const mockFetch = mockFetchSuccess('ok');
    globalThis.fetch = mockFetch;

    const provider = new OpenAICompatibleProvider(defaultConfig);
    await provider.chatCompletion({
      ...simpleRequest,
      temperature: 0.1,
      maxTokens: 1024,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.temperature).toBe(0.1);
    expect(body.max_tokens).toBe(1024);
  });
});
