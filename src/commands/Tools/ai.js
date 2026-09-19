import { SlashCommandBuilder } from 'discord.js';
import { infoEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { aiService, AiServiceError } from '../../services/ai/aiService.js';
import { aiConfig } from '../../config/ai.js';
import { checkRateLimit } from '../../utils/rateLimiter.js';

const MAX_DISCORD_EMBED_DESCRIPTION = 4_000;

function truncateForDiscord(text) {
  return text.length > MAX_DISCORD_EMBED_DESCRIPTION
    ? `${text.slice(0, MAX_DISCORD_EMBED_DESCRIPTION - 16)}\n\n…Response truncated.`
    : text;
}

export default {
  data: new SlashCommandBuilder()
    .setName('ai')
    .setDescription('Ask Scenario AI a question')
    .addStringOption((option) => option
      .setName('prompt')
      .setDescription('What would you like to ask?')
      .setRequired(true)
      .setMaxLength(2_000)),

  async execute(interaction, guildConfig, client) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const prompt = interaction.options.getString('prompt', true);
    const service = client?.aiService || aiService;
    const rateLimitKey = `ai-command:${interaction.guildId}:${interaction.user.id}`;
    const allowed = await checkRateLimit(rateLimitKey, aiConfig.rateLimit.attempts, aiConfig.rateLimit.windowMs);
    if (!allowed) {
      await replyUserError(interaction, {
        type: ErrorTypes.RATE_LIMIT,
        message: 'You are asking Scenario AI too quickly. Please wait a moment and try again.',
      });
      return;
    }

    try {
      const { text, providerLabel } = await service.generate(prompt);
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [infoEmbed('Scenario AI', truncateForDiscord(text)).setFooter({ text: `Provider: ${providerLabel || 'Scenario AI'}` })],
      });
    } catch (error) {
      const message = error instanceof AiServiceError && error.code === 'AI_NOT_CONFIGURED'
        ? 'Scenario AI is not configured. Ask a server administrator to configure an AI provider.'
        : error instanceof AiServiceError && error.code === 'AI_DISABLED'
          ? 'Scenario AI is currently disabled.'
          : 'Scenario AI is temporarily unavailable. Please try again shortly.';
      await replyUserError(interaction, { type: ErrorTypes.NETWORK, message });
    }
  },
};
