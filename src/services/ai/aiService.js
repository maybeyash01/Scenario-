import { aiConfig, PROVIDER_NAMES } from '../../config/ai.js';
import { logger as defaultLogger } from '../../utils/logger.js';

export class AiServiceError extends Error {
  constructor(message, { code = 'AI_REQUEST_FAILED', cause, attempts = [] } = {}) {
    super(message, { cause });
    this.name = 'AiServiceError';
    this.code = code;
    this.attempts = attempts;
  }
}

async function requestJson(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new AiServiceError(`Provider returned HTTP ${response.status}`, { code: `AI_HTTP_${response.status}` });
    }
    return body;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new AiServiceError(`Provider request timed out after ${timeoutMs}ms`, { code: 'AI_TIMEOUT', cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractOpenAiText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  throw new AiServiceError('Provider returned an empty response', { code: 'AI_EMPTY_RESPONSE' });
}

function extractGeminiText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((part) => part?.text || '').join('').trim() : '';
  if (text) return text;
  throw new AiServiceError('Provider returned an empty response', { code: 'AI_EMPTY_RESPONSE' });
}

function createOpenAiCompatibleProvider(config, fetchImpl) {
  return async (prompt) => {
    const payload = await requestJson(fetchImpl, `${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: prompt }], max_tokens: config.maxOutputTokens }),
    }, config.timeoutMs);
    return extractOpenAiText(payload);
  };
}

function createGeminiProvider(config, fetchImpl) {
  return async (prompt) => {
    const url = new URL(`${config.baseUrl}/models/${encodeURIComponent(config.model)}:generateContent`);
    url.searchParams.set('key', config.apiKey);
    const payload = await requestJson(fetchImpl, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: config.maxOutputTokens } }),
    }, config.timeoutMs);
    return extractGeminiText(payload);
  };
}

export function createAiService({ config = aiConfig, fetchImpl = globalThis.fetch, logger = defaultLogger } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');

  const providerConfig = (name) => ({ ...config.providers[name], timeoutMs: config.timeoutMs, maxOutputTokens: config.maxOutputTokens });
  const providers = {
    grok: createOpenAiCompatibleProvider(providerConfig('grok'), fetchImpl),
    gemini: createGeminiProvider(providerConfig('gemini'), fetchImpl),
    openrouter: createOpenAiCompatibleProvider(providerConfig('openrouter'), fetchImpl),
  };

  return {
    async generate(prompt) {
      if (!config.enabled) throw new AiServiceError('AI features are disabled', { code: 'AI_DISABLED' });
      if (typeof prompt !== 'string' || !prompt.trim()) throw new AiServiceError('A prompt is required', { code: 'AI_INVALID_PROMPT' });
      if (prompt.length > config.maxPromptLength) throw new AiServiceError(`Prompt exceeds ${config.maxPromptLength} characters`, { code: 'AI_PROMPT_TOO_LONG' });

      const attempts = [];
      for (const providerName of PROVIDER_NAMES) {
        if (!config.providers?.[providerName]?.apiKey) continue;
        try {
          const text = await providers[providerName](prompt.trim());
          logger.info('AI provider completed request', { event: 'ai.request.success', provider: providerName });
          return { text, provider: providerName };
        } catch (error) {
          attempts.push({ provider: providerName, code: error?.code || 'AI_PROVIDER_ERROR' });
          logger.warn('AI provider failed; trying next configured provider', { event: 'ai.request.failure', provider: providerName, errorCode: error?.code || 'AI_PROVIDER_ERROR' });
        }
      }
      throw new AiServiceError('All configured AI providers failed', { code: attempts.length ? 'AI_ALL_PROVIDERS_FAILED' : 'AI_NOT_CONFIGURED', attempts });
    },
  };
}

export const aiService = createAiService();
