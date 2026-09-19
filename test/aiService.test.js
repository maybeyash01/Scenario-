import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiService, AiServiceError } from '../src/services/ai/aiService.js';

const silentLogger = { info() {}, warn() {} };

function config(keys = {}) {
  return {
    enabled: true,
    timeoutMs: 100,
    maxPromptLength: 20,
    maxOutputTokens: 50,
    providers: {
      grok: { apiKey: keys.grok, model: 'grok-model', baseUrl: 'https://grok.test/v1' },
      gemini: { apiKey: keys.gemini, model: 'gemini-model', baseUrl: 'https://gemini.test/v1beta' },
      openrouter: { apiKey: keys.openrouter, model: 'router-model', baseUrl: 'https://router.test/v1' },
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('uses Grok as the primary provider', async () => {
  const fetchCalls = [];
  const service = createAiService({
    config: config({ grok: 'grok-key', gemini: 'gemini-key' }),
    logger: silentLogger,
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url: String(url), options });
      return jsonResponse({ choices: [{ message: { content: 'Grok answer' } }] });
    },
  });

  assert.deepEqual(await service.generate('Hello'), { text: 'Grok answer', provider: 'grok' });
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /grok\.test/);
  assert.equal(fetchCalls[0].options.headers.Authorization, 'Bearer grok-key');
});

test('falls back from Grok to Gemini and parses Gemini content', async () => {
  const service = createAiService({
    config: config({ grok: 'grok-key', gemini: 'gemini-key', openrouter: 'router-key' }),
    logger: silentLogger,
    fetchImpl: async (url) => {
      if (String(url).includes('grok.test')) return jsonResponse({ error: 'unavailable' }, 503);
      return jsonResponse({ candidates: [{ content: { parts: [{ text: 'Gemini answer' }] } }] });
    },
  });

  assert.deepEqual(await service.generate('Hello'), { text: 'Gemini answer', provider: 'gemini' });
});

test('falls back through Gemini to OpenRouter when earlier providers fail', async () => {
  const service = createAiService({
    config: config({ grok: 'grok-key', gemini: 'gemini-key', openrouter: 'router-key' }),
    logger: silentLogger,
    fetchImpl: async (url) => {
      if (!String(url).includes('router.test')) return jsonResponse({ error: 'unavailable' }, 503);
      return jsonResponse({ choices: [{ message: { content: 'OpenRouter answer' } }] });
    },
  });

  assert.deepEqual(await service.generate('Hello'), { text: 'OpenRouter answer', provider: 'openrouter' });
});

test('returns a safe error when no providers are configured', async () => {
  const service = createAiService({ config: config(), logger: silentLogger, fetchImpl: async () => { throw new Error('not called'); } });
  await assert.rejects(() => service.generate('Hello'), (error) => error instanceof AiServiceError && error.code === 'AI_NOT_CONFIGURED');
});

test('rejects oversized prompts before making a provider request', async () => {
  const service = createAiService({ config: config({ grok: 'grok-key' }), logger: silentLogger, fetchImpl: async () => { throw new Error('not called'); } });
  await assert.rejects(() => service.generate('x'.repeat(21)), (error) => error.code === 'AI_PROMPT_TOO_LONG');
});
