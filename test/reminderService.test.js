import test from 'node:test';
import assert from 'node:assert/strict';
import { createReminder, parseReminderDate, runDueReminders } from '../src/services/automation/reminderService.js';

function memoryClient() {
  const values = new Map();
  return { db: {
    get: async (key, fallback) => values.has(key) ? values.get(key) : fallback,
    set: async (key, value) => { values.set(key, structuredClone(value)); return true; },
    list: async (prefix) => [...values.keys()].filter((key) => key.startsWith(prefix)),
  }, guilds: { cache: new Map() } };
}

test('requires an ISO reminder date with explicit timezone', () => {
  assert.throws(() => parseReminderDate('2030-01-01T10:00:00'), /timezone/i);
  assert.throws(() => parseReminderDate('not-a-date'), /timezone/i);
});

test('creates a persistent scheduled reminder', async () => {
  const client = memoryClient();
  const reminder = await createReminder(client, { guildId: 'guild', channelId: 'channel', ownerId: 'user', content: 'Review notes', when: '2030-01-01T10:00:00Z' });
  assert.equal(reminder.status, 'scheduled');
  assert.equal(reminder.ownerId, 'user');
  assert.ok(reminder.id);
});

test('does not deliver automatic reminders while automation is disabled', async () => {
  const client = memoryClient();
  const sent = [];
  client.guilds.cache.set('guild', { id: 'guild', channels: { cache: new Map([['channel', { isTextBased: () => true, permissionsFor: () => ({ has: () => true }), send: async (payload) => sent.push(payload) }]]), fetch: async () => null } });
  const reminder = await createReminder(client, { guildId: 'guild', channelId: 'channel', ownerId: 'user', content: 'Review notes', when: '2030-01-01T10:00:00Z' });
  reminder.nextRunAt = '2020-01-01T00:00:00.000Z';
  await client.db.set(`scenario:reminder:guild:${reminder.id}`, reminder);
  await runDueReminders(client, new Date('2021-01-01T00:00:00Z'));
  assert.equal(sent.length, 0);
});

test('delivers a due reminder once when automation is enabled', async () => {
  const client = memoryClient();
  const sent = [];
  client.db.set('guild:guild:config', { automation: { enabled: true, emergencyStop: false } });
  client.guilds.cache.set('guild', { id: 'guild', channels: { cache: new Map([['channel', { isTextBased: () => true, permissionsFor: () => ({ has: () => true }), send: async (payload) => sent.push(payload) }]]), fetch: async () => null } });
  const reminder = await createReminder(client, { guildId: 'guild', channelId: 'channel', ownerId: 'user', content: 'Review notes', when: '2030-01-01T10:00:00Z' });
  reminder.nextRunAt = '2020-01-01T00:00:00.000Z';
  await client.db.set(`scenario:reminder:guild:${reminder.id}`, reminder);
  await runDueReminders(client, new Date('2021-01-01T00:00:00Z'));
  await runDueReminders(client, new Date('2021-01-01T00:01:00Z'));
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /Review notes/);
});
