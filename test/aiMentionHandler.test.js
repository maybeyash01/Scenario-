import test from 'node:test';
import assert from 'node:assert/strict';
import { clearRateLimit } from '../src/utils/rateLimiter.js';
import { getMentionPrompt, handleAiMention } from '../src/services/ai/mentionHandler.js';

const bot = { id: '123456789012345678' };
const config = {
  enabled: true,
  rateLimit: { attempts: 1, windowMs: 60_000 },
  mention: { enabled: true },
};

function createMessage(content, { canSend = true } = {}) {
  const replies = [];
  return {
    content,
    guild: { id: 'guild-1' },
    author: { id: 'user-1', bot: false },
    mentions: { has: (user) => user.id === bot.id && content.includes(bot.id) },
    channel: { permissionsFor: () => ({ has: () => canSend }) },
    reply: async (payload) => { replies.push(payload); },
    replies,
  };
}

test('extracts bot mentions without changing the rest of the prompt', () => {
  assert.equal(getMentionPrompt('<@123456789012345678> explain this <@!123456789012345678>', bot.id), 'explain this');
});

test('answers an AI mention and suppresses outbound mentions in model output', async () => {
  clearRateLimit('ai-mention:guild-1:user-1');
  const message = createMessage(`<@${bot.id}> hello`);
  const handled = await handleAiMention(message, { user: bot }, {
    config,
    service: { generate: async (prompt) => ({ text: `Answer to ${prompt} @everyone`, provider: 'grok' }) },
  });

  assert.equal(handled, true);
  assert.deepEqual(message.replies, [{ content: 'Answer to hello @everyone', allowedMentions: { parse: [], repliedUser: false } }]);
});

test('rate limits mention conversations per guild and user', async () => {
  clearRateLimit('ai-mention:guild-1:user-1');
  const service = { generate: async () => ({ text: 'answer', provider: 'grok' }) };
  const first = createMessage(`<@${bot.id}> first`);
  const second = createMessage(`<@${bot.id}> second`);

  await handleAiMention(first, { user: bot }, { config, service });
  await handleAiMention(second, { user: bot }, { config, service });

  assert.match(second.replies[0].content, /too quickly/i);
});

test('does not handle unmentioned messages or channels without send permission', async () => {
  const unmentioned = createMessage('hello');
  const noPermission = createMessage(`<@${bot.id}> hello`, { canSend: false });
  const service = { generate: async () => { throw new Error('should not run'); } };

  assert.equal(await handleAiMention(unmentioned, { user: bot }, { config, service }), false);
  assert.equal(await handleAiMention(noPermission, { user: bot }, { config, service }), false);
});
