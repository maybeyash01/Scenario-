import crypto from 'node:crypto';
import { PermissionFlagsBits } from 'discord.js';
import { z } from 'zod';
import { logger as defaultLogger } from '../../../utils/logger.js';

const SESSION_TTL_MS = 5 * 60 * 1000;
const SNOWFLAKE = /^\d{17,19}$/;
const confirmationSessions = new Map();

export const ActionRisk = Object.freeze({ LOW: 'low', MODERATE: 'moderate', HIGH: 'high', DESTRUCTIVE: 'destructive' });

const EmptyInput = z.object({}).strict();
const SendMessageInput = z.object({
  channelId: z.string().regex(SNOWFLAKE).optional(),
  content: z.string().trim().min(1).max(1_800),
}).strict();

function summarizeServerReport({ guild }) {
  return {
    guildName: guild.name,
    memberCount: guild.memberCount ?? null,
    channelCount: guild.channels?.cache?.size ?? null,
    roleCount: guild.roles?.cache?.size ?? null,
  };
}

async function sendMessage({ guild, channel, input }) {
  const targetChannel = input.channelId ? guild.channels?.cache?.get(input.channelId) : channel;
  if (!targetChannel?.isTextBased?.() || typeof targetChannel.send !== 'function') {
    throw new ActionExecutionError('The requested channel is unavailable or cannot receive messages.', 'AI_ACTION_TARGET_UNAVAILABLE');
  }

  const message = await targetChannel.send({ content: input.content, allowedMentions: { parse: [] } });
  return { channelId: targetChannel.id, messageId: message.id };
}

export class ActionRegistryError extends Error {
  constructor(message, code = 'AI_ACTION_ERROR', details = {}) {
    super(message);
    this.name = 'ActionRegistryError';
    this.code = code;
    this.details = details;
  }
}

export class ActionExecutionError extends ActionRegistryError {
  constructor(message, code = 'AI_ACTION_EXECUTION_FAILED', details = {}) {
    super(message, code, details);
    this.name = 'ActionExecutionError';
  }
}

const actionDefinitions = [
  {
    name: 'server.report',
    aliases: ['server report', 'report server', 'server summary'],
    description: 'Read permitted server counts and return a concise report.',
    requiredUserPermissions: [],
    requiredBotPermissions: [],
    riskLevel: ActionRisk.LOW,
    confirmationRequired: false,
    inputSchema: EmptyInput,
    executor: async (context) => summarizeServerReport(context),
    auditEvent: 'ai_action.server_report',
  },
  {
    name: 'message.send',
    aliases: ['send message', 'send announcement', 'post announcement'],
    description: 'Send a validated message to the current or explicitly selected channel.',
    requiredUserPermissions: [PermissionFlagsBits.ManageMessages],
    requiredBotPermissions: [PermissionFlagsBits.SendMessages],
    riskLevel: ActionRisk.MODERATE,
    confirmationRequired: true,
    inputSchema: SendMessageInput,
    executor: sendMessage,
    auditEvent: 'ai_action.message_send',
  },
];

const actions = new Map(actionDefinitions.map((action) => [action.name, Object.freeze(action)]));
const aliases = new Map(actionDefinitions.flatMap((action) => [action.name, ...action.aliases].map((alias) => [alias.toLowerCase(), action.name])));

export function listRegisteredActions() {
  return [...actions.values()].map(({ executor, inputSchema, ...metadata }) => metadata);
}

export function resolveAction(nameOrAlias) {
  const normalized = String(nameOrAlias || '').trim().toLowerCase();
  return actions.get(normalized) || actions.get(aliases.get(normalized));
}

export function validateActionInput(action, input) {
  const parsed = action?.inputSchema?.safeParse(input ?? {});
  if (!parsed?.success) {
    throw new ActionRegistryError('The action input is incomplete or invalid.', 'AI_ACTION_INVALID_INPUT', {
      issues: parsed?.error?.issues?.map(({ path, message }) => ({ path: path.join('.'), message })) ?? [],
    });
  }
  return parsed.data;
}

function hasPermissions(subject, permissions) {
  if (!permissions?.length) return true;
  return Boolean(subject?.permissions?.has?.(permissions));
}

function memberHasTrustedRole(member, trustedRoleIds) {
  return trustedRoleIds.some((roleId) => member?.roles?.cache?.has?.(roleId));
}

export function authorizeAction(action, context, policy = {}) {
  if (!action || !context?.guild || !context?.member || !context?.user) {
    throw new ActionRegistryError('This action can only run in a server.', 'AI_ACTION_GUILD_REQUIRED');
  }

  if (!hasPermissions(context.member, action.requiredUserPermissions)) {
    throw new ActionRegistryError('You do not have the Discord permissions required for this action.', 'AI_ACTION_USER_PERMISSION_DENIED');
  }

  const trustedUsers = policy.trustedUserIds ?? [];
  const trustedRoles = policy.trustedRoleIds ?? [];
  const isOwner = context.guild.ownerId === context.user.id;
  const isAdministrator = context.member.permissions?.has?.(PermissionFlagsBits.Administrator) ?? false;
  const isTrusted = trustedUsers.includes(context.user.id) || memberHasTrustedRole(context.member, trustedRoles);
  if (policy.administratorOnly && !isOwner && !isAdministrator && !isTrusted) {
    throw new ActionRegistryError('This server allows AI actions only for administrators or configured trusted users.', 'AI_ACTION_POLICY_DENIED');
  }

  const botMember = context.guild.members?.me;
  const targetChannel = context.input?.channelId ? context.guild.channels?.cache?.get(context.input.channelId) : context.channel;
  const botPermissions = targetChannel?.permissionsFor?.(botMember);
  if (action.requiredBotPermissions.length && (!botPermissions || !botPermissions.has(action.requiredBotPermissions))) {
    throw new ActionRegistryError('Scenario does not have the Discord permissions required to complete this action.', 'AI_ACTION_BOT_PERMISSION_DENIED');
  }

  return true;
}

export function createActionPlan(nameOrAlias, input, context, policy = {}) {
  const action = resolveAction(nameOrAlias);
  if (!action) throw new ActionRegistryError('That AI action is not registered.', 'AI_ACTION_NOT_FOUND');
  const validatedInput = validateActionInput(action, input);
  const planContext = { ...context, input: validatedInput };
  authorizeAction(action, planContext, policy);
  return Object.freeze({ action, input: validatedInput, requesterId: context.user.id, guildId: context.guild.id, createdAt: Date.now() });
}

export function createConfirmation(plan, { now = Date.now, ttlMs = SESSION_TTL_MS } = {}) {
  if (!plan?.action?.confirmationRequired) return null;
  const id = crypto.randomUUID();
  const session = Object.freeze({ id, plan, expiresAt: now() + ttlMs, status: 'pending' });
  confirmationSessions.set(id, session);
  return session;
}

export function cancelConfirmation(id, requesterId, { now = Date.now } = {}) {
  const session = confirmationSessions.get(id);
  if (!session || session.expiresAt <= now()) throw new ActionRegistryError('This action confirmation has expired.', 'AI_ACTION_CONFIRMATION_EXPIRED');
  if (session.plan.requesterId !== requesterId) throw new ActionRegistryError('Only the requester can cancel this action.', 'AI_ACTION_CONFIRMATION_FORBIDDEN');
  confirmationSessions.delete(id);
  return { ...session, status: 'cancelled' };
}

export async function executeActionPlan(plan, context, { confirmationId = null, policy = {}, logger = defaultLogger, now = Date.now } = {}) {
  if (!plan || plan.guildId !== context?.guild?.id || plan.requesterId !== context?.user?.id) {
    throw new ActionRegistryError('This action plan does not belong to the current requester and server.', 'AI_ACTION_PLAN_FORBIDDEN');
  }
  authorizeAction(plan.action, { ...context, input: plan.input }, policy);

  if (plan.action.confirmationRequired) {
    const session = confirmationSessions.get(confirmationId);
    if (!session || session.plan !== plan || session.expiresAt <= now()) {
      throw new ActionRegistryError('A valid confirmation is required before this action can run.', 'AI_ACTION_CONFIRMATION_REQUIRED');
    }
    confirmationSessions.delete(confirmationId);
  }

  try {
    const result = await plan.action.executor({ ...context, input: plan.input });
    logger.info('AI action completed', { event: plan.action.auditEvent, action: plan.action.name, guildId: context.guild.id, userId: context.user.id, targetChannelId: result?.channelId ?? context.channel?.id ?? null, result: 'success', timestamp: new Date(now()).toISOString() });
    return result;
  } catch (error) {
    logger.warn('AI action failed', { event: plan.action.auditEvent, action: plan.action.name, guildId: context.guild.id, userId: context.user.id, result: 'failed', errorCode: error?.code || 'AI_ACTION_EXECUTION_FAILED', timestamp: new Date(now()).toISOString() });
    throw error instanceof ActionRegistryError ? error : new ActionExecutionError('Discord did not confirm this action.', 'AI_ACTION_DISCORD_FAILED');
  }
}

export function clearActionConfirmations() {
  confirmationSessions.clear();
}
