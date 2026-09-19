import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiService } from '../src/services/ai/aiService.js';
import { buildAiSystemInstruction } from '../src/services/ai/promptContext.js';
import {
  getAiUserPreferences,
  resetAiUserPreferences,
  updateAiUserPreferences,
} from '../src/services/ai/preferencesService.js';

const silentLogger = { info() {}, warn() {} };
const config = {
  enabled: true,
  timeoutMs: 100,
  maxPromptLength: 100,
  maxOutputTokens: 50,
  providers: {
    grok: { apiKey: 'grok', model: 'grok', baseUrl: 'https://grok.test/v1' },
    gemini: { apiKey: 'gemini', model: 'gemini', baseUrl: 'https://gemini.test/v1beta' },
    openrouter: { apiKey: undefined, model: 'router', baseUrl: 'https://router.test/v1' },
  },
};

test('passes a server and user context instruction without exposing it in output', async () => {
  let request;
  const service = createAiService({
    config,
    logger: silentLogger,
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'answer' } }] }), { status: 200 });
    },
  });
  const systemInstruction = buildAiSystemInstruction({
    guildAi: { personality: 'study', responseLength: 'detailed', emoji: 'normal' },
    userPreferences: { language: 'en', responseLength: 'concise', emoji: 'none' },
  });

  await service.generate('Explain gravity', { systemInstruction });
  assert.equal(request.messages[0].role, 'system');
  assert.match(request.messages[0].content, /patient study assistant/i);
  assert.match(request.messages[0].content, /concise response length/i);
});

test('uses a validated provider order for a request', async () => {
  const calls = [];
  const service = createAiService({
    config,
    logger: silentLogger,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'gemini' }] } }] }), { status: 200 });
    },
  });
  const result = await service.generate('Hello', { providerOrder: ['gemini', 'invalid', 'grok'] });
  assert.deepEqual(result, { text: 'gemini', provider: 'gemini' });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /gemini\.test/);
});

test('persists and resets user preferences with a guild-scoped key', async () => {
  const values = new Map();
  const client = { db: {
    get: async (key, fallback) => values.has(key) ? values.get(key) : fallback,
    set: async (key, value) => { values.set(key, value); return true; },
    delete: async (key) => values.delete(key),
  } };
  const updated = await updateAiUserPreferences(client, 'guild-a', 'user-a', { emoji: 'none', memoryConsent: true });
  assert.equal(updated.emoji, 'none');
  assert.equal(updated.memoryConsent, true);
  assert.equal((await getAiUserPreferences(client, 'guild-b', 'user-a')).emoji, 'minimal');
  await resetAiUserPreferences(client, 'guild-a', 'user-a');
  assert.equal((await getAiUserPreferences(client, 'guild-a', 'user-a')).memoryConsent, false);
});
