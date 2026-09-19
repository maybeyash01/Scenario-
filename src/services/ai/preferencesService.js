import { z } from 'zod';
import { logger } from '../../utils/logger.js';

const DEFAULT_PREFERENCES = Object.freeze({
  language: 'en',
  responseLength: 'balanced',
  emoji: 'minimal',
  mentionReplies: false,
  memoryConsent: false,
});

const PreferencesSchema = z.object({
  language: z.string().min(2).max(10).default('en'),
  responseLength: z.enum(['concise', 'balanced', 'detailed']).default('balanced'),
  emoji: z.enum(['none', 'minimal', 'normal', 'expressive']).default('minimal'),
  mentionReplies: z.boolean().default(false),
  memoryConsent: z.boolean().default(false),
}).strict();

export function getAiUserPreferencesKey(guildId, userId) {
  return `scenario:userprefs:${guildId}:${userId}`;
}

export function normalizeAiUserPreferences(value) {
  const parsed = PreferencesSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...DEFAULT_PREFERENCES };
}

export async function getAiUserPreferences(client, guildId, userId) {
  if (!client?.db?.get || !guildId || !userId) return { ...DEFAULT_PREFERENCES };
  const value = await client.db.get(getAiUserPreferencesKey(guildId, userId), null);
  return normalizeAiUserPreferences(value);
}

export async function updateAiUserPreferences(client, guildId, userId, patch) {
  const next = { ...await getAiUserPreferences(client, guildId, userId), ...patch };
  const preferences = normalizeAiUserPreferences(next);
  if (!client?.db?.set || !(await client.db.set(getAiUserPreferencesKey(guildId, userId), preferences))) {
    throw new Error('Unable to persist AI preferences.');
  }
  logger.info('AI user preferences updated', { event: 'ai.preferences.updated', guildId, userId, keys: Object.keys(patch) });
  return preferences;
}

export async function resetAiUserPreferences(client, guildId, userId) {
  if (!client?.db?.delete || !(await client.db.delete(getAiUserPreferencesKey(guildId, userId)))) {
    throw new Error('Unable to reset AI preferences.');
  }
  logger.info('AI user preferences reset', { event: 'ai.preferences.reset', guildId, userId });
  return { ...DEFAULT_PREFERENCES };
}

export { DEFAULT_PREFERENCES };
