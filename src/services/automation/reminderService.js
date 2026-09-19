import { randomUUID } from 'node:crypto';
import { getGuildConfig } from '../config/guildConfig.js';
import { executeAction } from './actionRegistry.js';
import { logger } from '../../utils/logger.js';

const PREFIX = 'scenario:reminder:';
const MAX_REMINDERS_PER_USER = 50;
const activeRuns = new Set();

export function reminderKey(guildId, reminderId) { return `${PREFIX}${guildId}:${reminderId}`; }

export function parseReminderDate(value) {
  if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/i.test(value)) throw new Error('Use an ISO-8601 date with timezone, for example 2026-09-20T09:00:00+02:00.');
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) throw new Error('Reminder time must be a valid future date.');
  return date;
}

export async function listReminders(client, guildId, ownerId = null) {
  const keys = await client.db.list(`${PREFIX}${guildId}:`);
  const reminders = await Promise.all(keys.map((key) => client.db.get(key, null)));
  return reminders.filter((reminder) => reminder && (!ownerId || reminder.ownerId === ownerId)).sort((a, b) => new Date(a.nextRunAt) - new Date(b.nextRunAt));
}

export async function createReminder(client, { guildId, channelId, ownerId, content, when }) {
  if (!client?.db?.set) throw new Error('Persistent storage is unavailable.');
  if (typeof content !== 'string' || !content.trim() || content.length > 1_800) throw new Error('Reminder text must be between 1 and 1,800 characters.');
  const dueAt = parseReminderDate(when);
  const existing = await listReminders(client, guildId, ownerId);
  if (existing.filter((reminder) => reminder.status === 'scheduled').length >= MAX_REMINDERS_PER_USER) throw new Error('You have reached the 50 active-reminder limit.');
  const reminder = { id: randomUUID(), guildId, channelId, ownerId, content: content.trim(), status: 'scheduled', createdAt: new Date().toISOString(), nextRunAt: dueAt.toISOString(), lastRunAt: null, attempts: 0 };
  if (!(await client.db.set(reminderKey(guildId, reminder.id), reminder))) throw new Error('Unable to save reminder.');
  logger.info('Reminder created', { event: 'scenario.reminder.created', guildId, userId: ownerId, reminderId: reminder.id, channelId });
  return reminder;
}

export async function cancelReminder(client, guildId, ownerId, reminderId) {
  const reminder = await client.db.get(reminderKey(guildId, reminderId), null);
  if (!reminder || reminder.ownerId !== ownerId || reminder.status !== 'scheduled') return false;
  reminder.status = 'cancelled';
  reminder.cancelledAt = new Date().toISOString();
  return Boolean(await client.db.set(reminderKey(guildId, reminderId), reminder));
}

export async function runDueReminders(client, now = new Date()) {
  if (!client?.db || !client?.guilds?.cache) return { delivered: 0, skipped: 0 };
  let delivered = 0; let skipped = 0;
  for (const guild of client.guilds.cache.values()) {
    const config = await getGuildConfig(client, guild.id);
    const reminders = await listReminders(client, guild.id);
    for (const reminder of reminders) {
      if (reminder.status !== 'scheduled' || new Date(reminder.nextRunAt) > now || activeRuns.has(reminder.id)) continue;
      activeRuns.add(reminder.id);
      try {
        if (config.automation?.enabled !== true || config.automation?.emergencyStop === true) {
          skipped += 1;
          continue;
        }
        const channel = guild.channels.cache.get(reminder.channelId) ?? await guild.channels.fetch(reminder.channelId).catch(() => null);
        if (!channel?.isTextBased?.()) { reminder.status = 'failed'; reminder.failureReason = 'CHANNEL_UNAVAILABLE'; await client.db.set(reminderKey(guild.id, reminder.id), reminder); skipped += 1; continue; }
        // Persist completion before sending for at-most-once restart safety; a crash may miss, but never duplicate, a reminder.
        reminder.status = 'completed'; reminder.lastRunAt = now.toISOString(); reminder.attempts += 1;
        await client.db.set(reminderKey(guild.id, reminder.id), reminder);
        await executeAction('message.send', { client, channel, content: `⏰ <@${reminder.ownerId}> Reminder: ${reminder.content}`, guildId: guild.id, userId: reminder.ownerId, guildConfig: config, automatic: true });
        delivered += 1;
      } catch (error) {
        logger.warn('Reminder delivery skipped', { event: 'scenario.reminder.failed', guildId: guild.id, reminderId: reminder.id, errorCode: error?.code || 'REMINDER_DELIVERY_FAILED' });
        skipped += 1;
      } finally { activeRuns.delete(reminder.id); }
    }
  }
  return { delivered, skipped };
}
