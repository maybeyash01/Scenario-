import { PermissionFlagsBits } from 'discord.js';
import { aiConfig } from '../../config/ai.js';
import { checkRateLimit } from '../../utils/rateLimiter.js';
import { logger } from '../../utils/logger.js';
import { AiServiceError } from './aiService.js';
import { getGuildConfig } from '../config/guildConfig.js';
import { getAiUserPreferences } from './preferencesService.js';
import { buildAiSystemInstruction } from './promptContext.js';

const DISCORD_MESSAGE_LIMIT = 2_000;

export function getMentionPrompt(content, botId) {
  if (!content || !botId) return '';
  const mentionPattern = new RegExp(`<@!?${botId}>`, 'g');
  return content.replace(mentionPattern, '').trim();
}

export function isAiMention(message, client, config = aiConfig) {
  if (!config.enabled || !config.mention.enabled || !message?.guild || message?.author?.bot || !client?.user) return false;
  return message.mentions?.has?.(client.user) ?? false;
}

function canReplyInChannel(message, client) {
  const permissions = message.channel?.permissionsFor?.(client.user);
  return !permissions || permissions.has(PermissionFlagsBits.SendMessages);
}

function truncateMessage(text) {
  return text.length > DISCORD_MESSAGE_LIMIT
    ? `${text.slice(0, DISCORD_MESSAGE_LIMIT - 16)}\n\n…Response truncated.`
    : text;
}

export async function handleAiMention(message, client, { config = aiConfig, service = client?.aiService } = {}) {
  if (!isAiMention(message, client, config) || !canReplyInChannel(message, client)) return false;

  const prompt = getMentionPrompt(message.content, client.user.id);
  if (!prompt) {
    await message.reply({ content: 'Hi! Mention me with a question, or use `/ai`.', allowedMentions: { parse: [] } });
    return true;
  }

  const rateLimitKey = `ai-mention:${message.guild.id}:${message.author.id}`;
  const allowed = await checkRateLimit(rateLimitKey, config.rateLimit.attempts, config.rateLimit.windowMs);
  if (!allowed) {
    await message.reply({ content: 'You are asking Scenario AI too quickly. Please wait a moment and try again.', allowedMentions: { parse: [] } });
    return true;
  }

  try {
    const guildConfig = await getGuildConfig(client, message.guild.id);
    const guildAi = guildConfig.ai || {};
    if (guildAi.enabled === false) {
      await message.reply({ content: 'Scenario AI is disabled for this server.', allowedMentions: { parse: [] } });
      return true;
    }
    const userPreferences = await getAiUserPreferences(client, message.guild.id, message.author.id);
    const result = await service.generate(prompt, { systemInstruction: buildAiSystemInstruction({ guildAi, userPreferences }) });
    await message.reply({ content: truncateMessage(result.text), allowedMentions: { parse: [], repliedUser: userPreferences.mentionReplies } });
  } catch (error) {
    const messageText = error instanceof AiServiceError && error.code === 'AI_NOT_CONFIGURED'
      ? 'Scenario AI is not configured on this bot.'
      : error instanceof AiServiceError && error.code === 'AI_DISABLED'
        ? 'Scenario AI is currently disabled.'
        : 'Scenario AI is temporarily unavailable. Please try again shortly.';
    logger.warn('AI mention request failed', { event: 'ai.mention.failure', errorCode: error?.code || 'AI_REQUEST_FAILED', guildId: message.guild.id, userId: message.author.id });
    await message.reply({ content: messageText, allowedMentions: { parse: [] } }).catch(() => {});
  }

  return true;
}
