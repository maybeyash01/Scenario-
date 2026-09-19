import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { getGuildConfig, patchGuildConfig } from '../../services/config/guildConfig.js';
import {
  getAiUserPreferences,
  resetAiUserPreferences,
  updateAiUserPreferences,
} from '../../services/ai/preferencesService.js';
import { logger } from '../../utils/logger.js';
import { isBotOwner } from '../../config/bot.js';

const PERSONALITIES = ['professional', 'friendly', 'study', 'minimal', 'detailed'];
const LENGTHS = ['concise', 'balanced', 'detailed'];
const EMOJI_LEVELS = ['none', 'minimal', 'normal', 'expressive'];

function choices(values) {
  return [...new Set(values)].map((value) => ({ name: value, value }));
}

function settingsEmbed(ai, automation = {}) {
  return {
    title: 'Scenario AI settings',
    description: 'Server administrators can change these values with `/scenario settings edit`. They affect `/ai` and bot-mention conversations.',
    fields: [
      { name: 'Enabled', value: ai.enabled ? 'Yes' : 'No', inline: true },
      { name: 'Personality', value: ai.personality, inline: true },
      { name: 'Response length', value: ai.responseLength, inline: true },
      { name: 'Emoji usage', value: ai.emoji, inline: true },
      { name: 'Automatic actions', value: automation.enabled ? 'Enabled' : 'Disabled', inline: true },
      { name: 'Emergency stop', value: automation.emergencyStop ? 'Active' : 'Off', inline: true },
    ],
  };
}

function preferencesEmbed(preferences) {
  return {
    title: 'Your Scenario AI preferences',
    description: 'These preferences are private to you and scoped to this server. Memory consent only records consent; this release does not retain conversation memory.',
    fields: [
      { name: 'Language', value: preferences.language, inline: true },
      { name: 'Response length', value: preferences.responseLength, inline: true },
      { name: 'Emoji usage', value: preferences.emoji, inline: true },
      { name: 'Mention replies', value: preferences.mentionReplies ? 'On' : 'Off', inline: true },
      { name: 'Memory consent', value: preferences.memoryConsent ? 'On' : 'Off', inline: true },
    ],
  };
}

function ensureGuild(interaction) {
  if (!interaction.guildId) throw new Error('This command can only be used in a server.');
}

function ensureSettingsAccess(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new Error('You need the Manage Server permission to change Scenario AI settings.');
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName('scenario')
    .setDescription('Configure Scenario AI for this server or yourself')
    .addSubcommandGroup((group) => group
      .setName('settings')
      .setDescription('Server-wide Scenario AI settings')
      .addSubcommand((subcommand) => subcommand.setName('view').setDescription('View current AI settings'))
      .addSubcommand((subcommand) => subcommand
        .setName('edit')
        .setDescription('Change a server-wide AI setting')
        .addStringOption((option) => option.setName('setting').setDescription('Setting to change').setRequired(true).addChoices(
          { name: 'enabled', value: 'enabled' },
          { name: 'personality', value: 'personality' },
          { name: 'response length', value: 'responseLength' },
          { name: 'emoji usage', value: 'emoji' },
          { name: 'automatic actions', value: 'automationEnabled' },
          { name: 'emergency stop', value: 'emergencyStop' },
        ))
        .addStringOption((option) => option.setName('value').setDescription('New value').setRequired(true).addChoices(
          { name: 'true', value: 'true' }, { name: 'false', value: 'false' },
          ...choices([...PERSONALITIES, ...LENGTHS, ...EMOJI_LEVELS]),
        )))
      .addSubcommand((subcommand) => subcommand.setName('reset').setDescription('Reset server-wide AI settings to safe defaults')))
    .addSubcommandGroup((group) => group
      .setName('preferences')
      .setDescription('Your Scenario AI preferences')
      .addSubcommand((subcommand) => subcommand.setName('view').setDescription('View your preferences'))
      .addSubcommand((subcommand) => subcommand
        .setName('set')
        .setDescription('Change one of your preferences')
        .addStringOption((option) => option.setName('setting').setDescription('Preference to change').setRequired(true).addChoices(
          { name: 'language', value: 'language' }, { name: 'response length', value: 'responseLength' },
          { name: 'emoji usage', value: 'emoji' }, { name: 'mention replies', value: 'mentionReplies' },
          { name: 'memory consent', value: 'memoryConsent' },
        ))
        .addStringOption((option) => option.setName('value').setDescription('New value').setRequired(true).setMaxLength(10)))
      .addSubcommand((subcommand) => subcommand.setName('reset').setDescription('Reset your preferences'))
      .addSubcommand((subcommand) => subcommand.setName('memory-delete').setDescription('Withdraw memory consent and clear stored preference data'))),

  async execute(interaction, _guildConfig, client) {
    ensureGuild(interaction);
    const group = interaction.options.getSubcommandGroup(true);
    const subcommand = interaction.options.getSubcommand(true);

    if (group === 'settings') {
      if (subcommand === 'view') {
        const config = await getGuildConfig(client, interaction.guildId);
        await interaction.reply({ embeds: [settingsEmbed(config.ai, config.automation)], ephemeral: true });
        return;
      }
      ensureSettingsAccess(interaction);
      if (subcommand === 'reset') {
        const ai = { enabled: true, personality: 'professional', responseLength: 'balanced', emoji: 'minimal' };
        await patchGuildConfig(client, interaction.guildId, { ai });
        logger.info('Scenario AI settings reset', { event: 'ai.settings.reset', guildId: interaction.guildId, userId: interaction.user.id });
        await interaction.reply({ content: 'Scenario AI settings were reset to safe defaults.', ephemeral: true });
        return;
      }
      const setting = interaction.options.getString('setting', true);
      const rawValue = interaction.options.getString('value', true);
      let value = rawValue;
      if (setting === 'enabled') value = rawValue === 'true';
      if (setting === 'enabled' && !['true', 'false'].includes(rawValue)) throw new Error('Enabled must be true or false.');
      if (setting === 'personality' && !PERSONALITIES.includes(value)) throw new Error('Choose a listed personality.');
      if (setting === 'responseLength' && !LENGTHS.includes(value)) throw new Error('Choose concise, balanced, or detailed.');
      if (setting === 'emoji' && !EMOJI_LEVELS.includes(value)) throw new Error('Choose a listed emoji level.');
      const config = await getGuildConfig(client, interaction.guildId);
      if (setting === 'automationEnabled' || setting === 'emergencyStop') {
        if (!isBotOwner(interaction.user.id)) throw new Error('Only a configured bot owner can change automatic-action controls.');
        if (!['true', 'false'].includes(rawValue)) throw new Error('Automatic-action controls must be true or false.');
        const automation = { ...config.automation, [setting === 'automationEnabled' ? 'enabled' : 'emergencyStop']: rawValue === 'true' };
        await patchGuildConfig(client, interaction.guildId, { automation });
        logger.warn('Scenario automation control updated', { event: 'scenario.automation.updated', guildId: interaction.guildId, userId: interaction.user.id, setting });
        await interaction.reply({ content: `Scenario **${setting}** is now **${rawValue}**.`, ephemeral: true });
        return;
      }
      const ai = { ...config.ai, [setting]: value };
      await patchGuildConfig(client, interaction.guildId, { ai });
      logger.info('Scenario AI settings updated', { event: 'ai.settings.updated', guildId: interaction.guildId, userId: interaction.user.id, setting });
      await interaction.reply({ content: `Scenario AI **${setting}** is now **${value}**.`, ephemeral: true });
      return;
    }

    if (subcommand === 'view') {
      await interaction.reply({ embeds: [preferencesEmbed(await getAiUserPreferences(client, interaction.guildId, interaction.user.id))], ephemeral: true });
      return;
    }
    if (subcommand === 'reset' || subcommand === 'memory-delete') {
      const preferences = await resetAiUserPreferences(client, interaction.guildId, interaction.user.id);
      await interaction.reply({ content: subcommand === 'memory-delete'
        ? 'Memory consent was withdrawn and your stored Scenario preference record was deleted.'
        : `Your preferences were reset (language: ${preferences.language}).`, ephemeral: true });
      return;
    }
    const setting = interaction.options.getString('setting', true);
    const rawValue = interaction.options.getString('value', true).trim();
    let value = rawValue;
    if (setting === 'responseLength' && !LENGTHS.includes(value)) throw new Error('Response length must be concise, balanced, or detailed.');
    if (setting === 'emoji' && !EMOJI_LEVELS.includes(value)) throw new Error('Emoji usage must be none, minimal, normal, or expressive.');
    if (setting === 'language' && !/^[a-z]{2,10}(?:-[A-Z]{2})?$/.test(value)) throw new Error('Use a language code such as en or en-US.');
    if (setting === 'mentionReplies' || setting === 'memoryConsent') {
      if (!['true', 'false'].includes(rawValue)) throw new Error('This preference must be true or false.');
      value = rawValue === 'true';
    }
    const preferences = await updateAiUserPreferences(client, interaction.guildId, interaction.user.id, { [setting]: value });
    await interaction.reply({ content: `Your **${setting}** preference is now **${preferences[setting]}**.`, ephemeral: true });
  },
};
