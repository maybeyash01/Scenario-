import { SlashCommandBuilder } from 'discord.js';
import { createReminder, cancelReminder, listReminders } from '../../services/automation/reminderService.js';

function formatReminder(reminder) {
  return `• **${reminder.id.slice(0, 8)}** — <t:${Math.floor(new Date(reminder.nextRunAt).getTime() / 1000)}:F> — ${reminder.content}`;
}

export default {
  data: new SlashCommandBuilder()
    .setName('reminder')
    .setDescription('Create and manage your persistent reminders')
    .addSubcommand((subcommand) => subcommand
      .setName('create').setDescription('Create a one-time reminder')
      .addStringOption((option) => option.setName('when').setDescription('ISO-8601 date including timezone').setRequired(true).setMaxLength(40))
      .addStringOption((option) => option.setName('text').setDescription('What to remind you about').setRequired(true).setMaxLength(1800)))
    .addSubcommand((subcommand) => subcommand.setName('list').setDescription('List your active reminders'))
    .addSubcommand((subcommand) => subcommand
      .setName('cancel').setDescription('Cancel one of your reminders')
      .addStringOption((option) => option.setName('id').setDescription('Reminder ID prefix from /reminder list').setRequired(true).setMinLength(8).setMaxLength(36))),

  async execute(interaction, _guildConfig, client) {
    if (!interaction.guildId || !interaction.channel?.isTextBased?.()) throw new Error('Reminders can only be created in a server text channel.');
    const subcommand = interaction.options.getSubcommand(true);
    if (subcommand === 'create') {
      const reminder = await createReminder(client, {
        guildId: interaction.guildId, channelId: interaction.channelId, ownerId: interaction.user.id,
        when: interaction.options.getString('when', true), content: interaction.options.getString('text', true),
      });
      await interaction.reply({ content: `✅ Reminder **${reminder.id.slice(0, 8)}** is scheduled for <t:${Math.floor(new Date(reminder.nextRunAt).getTime() / 1000)}:F>.`, ephemeral: true });
      return;
    }
    const reminders = await listReminders(client, interaction.guildId, interaction.user.id);
    if (subcommand === 'list') {
      const active = reminders.filter((reminder) => reminder.status === 'scheduled');
      await interaction.reply({ content: active.length ? `## Your reminders\n${active.slice(0, 20).map(formatReminder).join('\n')}` : 'You have no active reminders in this server.', ephemeral: true });
      return;
    }
    const requestedId = interaction.options.getString('id', true);
    const match = reminders.find((reminder) => reminder.id.startsWith(requestedId));
    if (!match || !(await cancelReminder(client, interaction.guildId, interaction.user.id, match.id))) throw new Error('No active reminder with that ID was found.');
    await interaction.reply({ content: `Cancelled reminder **${match.id.slice(0, 8)}**.`, ephemeral: true });
  },
};
