import { PermissionFlagsBits } from 'discord.js';
import { logger } from '../../utils/logger.js';

const actions = new Map();

export function registerAction(definition) {
  if (!definition?.id || typeof definition.execute !== 'function') throw new TypeError('Action definitions need an id and executor.');
  if (actions.has(definition.id)) throw new Error(`Action ${definition.id} is already registered.`);
  actions.set(definition.id, Object.freeze({ risk: 'low', automatic: false, ...definition }));
}

export function getAction(actionId) {
  return actions.get(actionId) ?? null;
}

export async function executeAction(actionId, context) {
  const action = getAction(actionId);
  if (!action) throw new Error(`Unknown action: ${actionId}`);
  const { guildConfig = {}, automatic = false, guildId, userId } = context;
  if (automatic && (!action.automatic || guildConfig.automation?.enabled !== true || guildConfig.automation?.emergencyStop === true)) {
    throw new Error('Automatic actions are disabled for this server.');
  }
  if (action.validate) await action.validate(context);
  if (action.requiredBotPermission && !context.channel?.permissionsFor?.(context.client?.user)?.has(action.requiredBotPermission)) {
    throw new Error('Scenario lacks the required channel permission.');
  }
  const result = await action.execute(context);
  logger.info('Scenario action executed', { event: 'scenario.action.executed', actionId, automatic, guildId, userId, risk: action.risk });
  return result;
}

registerAction({
  id: 'message.send',
  risk: 'low',
  automatic: true,
  requiredBotPermission: PermissionFlagsBits.SendMessages,
  validate: ({ content }) => {
    if (typeof content !== 'string' || !content.trim() || content.length > 2_000) throw new Error('Message content must be between 1 and 2,000 characters.');
  },
  execute: async ({ channel, content }) => channel.send({ content, allowedMentions: { parse: [] } }),
});
