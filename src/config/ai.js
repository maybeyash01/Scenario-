const PROVIDER_NAMES = Object.freeze(['grok', 'gemini', 'openrouter']);
const DEFAULT_TIMEOUT_MS = 25_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;

function parsePositiveInteger(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function parseTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(parsed)));
}

export const aiConfig = Object.freeze({
  enabled: process.env.AI_ENABLED !== 'false',
  timeoutMs: parseTimeout(process.env.AI_TIMEOUT_MS),
  maxPromptLength: 2_000,
  maxOutputTokens: 1_000,
  rateLimit: Object.freeze({
    attempts: parsePositiveInteger(process.env.AI_RATE_LIMIT_ATTEMPTS, 3, 1, 20),
    windowMs: parsePositiveInteger(process.env.AI_RATE_LIMIT_WINDOW_MS, 60_000, 1_000, 3_600_000),
  }),
  mention: Object.freeze({
    enabled: process.env.AI_MENTION_ENABLED !== 'false',
  }),
  providers: Object.freeze({
    grok: Object.freeze({
      apiKey: process.env.XAI_API_KEY,
      model: process.env.XAI_MODEL || 'grok-4-1-fast-reasoning',
      baseUrl: 'https://api.x.ai/v1',
    }),
    gemini: Object.freeze({
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    }),
    openrouter: Object.freeze({
      apiKey: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL || 'openai/gpt-4.1-mini',
      baseUrl: 'https://openrouter.ai/api/v1',
    }),
  }),
});

export function getConfiguredAiProviders(config = aiConfig) {
  return PROVIDER_NAMES.filter((name) => Boolean(config?.providers?.[name]?.apiKey));
}

export { PROVIDER_NAMES };
