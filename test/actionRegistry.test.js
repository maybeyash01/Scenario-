import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import {
  ActionRegistryError,
  cancelConfirmation,
  clearActionConfirmations,
  createActionPlan,
  createConfirmation,
  executeActionPlan,
  listRegisteredActions,
} from '../src/services/ai/actions/actionRegistry.js';

function permissions(...granted) {
  return { has: (required) => (Array.isArray(required) ? required : [required]).every((permission) => granted.includes(permission)) };
}

function context({ userPermissions = [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.Administrator], botPermissions = [PermissionFlagsBits.SendMessages] } = {}) {
  const channel = { id: '123456789012345678', isTextBased: () => true, permissionsFor: () => permissions(...botPermissions), send: async () => ({ id: '223456789012345678' }) };
  return {
    user: { id: '323456789012345678' },
    member: { permissions: permissions(...userPermissions), roles: { cache: new Map() } },
    guild: { id: '423456789012345678', ownerId: 'owner', members: { me: {} }, channels: { cache: new Map([[channel.id, channel]]) }, name: 'Scenario Test', memberCount: 3, roles: { cache: new Map() } },
    channel,
  };
}

const adminPolicy = { administratorOnly: true, trustedUserIds: [], trustedRoleIds: [] };

test('registry declares complete metadata for every registered action', () => {
  const actions = listRegisteredActions();
  assert.deepEqual(actions.map((action) => action.name), ['server.report', 'message.send']);
  for (const action of actions) {
    assert.ok(action.aliases.length > 0);
    assert.ok(action.description);
    assert.ok(action.riskLevel);
    assert.equal(typeof action.confirmationRequired, 'boolean');
    assert.ok(action.auditEvent.startsWith('ai_action.'));
  }
});

test('server report is a permitted read-only action and reports actual server data', async () => {
  const actionContext = context({ userPermissions: [] });
  actionContext.guild.ownerId = actionContext.user.id;
  const plan = createActionPlan('server summary', {}, actionContext, adminPolicy);
  const result = await executeActionPlan(plan, actionContext, { policy: adminPolicy, logger: { info() {}, warn() {} } });
  assert.deepEqual(result, { guildName: 'Scenario Test', memberCount: 3, channelCount: 1, roleCount: 0 });
});

test('message actions require Discord permission and an explicit confirmation', async () => {
  clearActionConfirmations();
  const deniedContext = context({ userPermissions: [PermissionFlagsBits.Administrator] });
  assert.throws(() => createActionPlan('send announcement', { content: 'Hello' }, deniedContext, adminPolicy), (error) => error instanceof ActionRegistryError && error.code === 'AI_ACTION_USER_PERMISSION_DENIED');

  const actionContext = context();
  const plan = createActionPlan('send message', { content: 'Hello' }, actionContext, adminPolicy);
  await assert.rejects(() => executeActionPlan(plan, actionContext, { policy: adminPolicy, logger: { info() {}, warn() {} } }), (error) => error.code === 'AI_ACTION_CONFIRMATION_REQUIRED');
  const confirmation = createConfirmation(plan);
  assert.deepEqual(await executeActionPlan(plan, actionContext, { confirmationId: confirmation.id, policy: adminPolicy, logger: { info() {}, warn() {} } }), { channelId: actionContext.channel.id, messageId: '223456789012345678' });
});

test('confirmation can only be cancelled by its requester and invalid input is rejected', () => {
  clearActionConfirmations();
  const actionContext = context();
  assert.throws(() => createActionPlan('message.send', { content: '' }, actionContext, adminPolicy), (error) => error.code === 'AI_ACTION_INVALID_INPUT');
  const plan = createActionPlan('message.send', { content: 'Hello' }, actionContext, adminPolicy);
  const confirmation = createConfirmation(plan);
  assert.throws(() => cancelConfirmation(confirmation.id, 'different-user'), (error) => error.code === 'AI_ACTION_CONFIRMATION_FORBIDDEN');
  assert.equal(cancelConfirmation(confirmation.id, actionContext.user.id).status, 'cancelled');
});

test('configured trusted users remain subject to Discord action permissions', () => {
  const actionContext = context({ userPermissions: [] });
  const policy = { administratorOnly: true, trustedUserIds: [actionContext.user.id], trustedRoleIds: [] };
  assert.throws(() => createActionPlan('message.send', { content: 'Hello' }, actionContext, policy), (error) => error.code === 'AI_ACTION_USER_PERMISSION_DENIED');
});

test('message actions stop before execution when Scenario lacks channel permission', () => {
  const actionContext = context({ botPermissions: [] });
  assert.throws(() => createActionPlan('message.send', { content: 'Hello' }, actionContext, adminPolicy), (error) => error.code === 'AI_ACTION_BOT_PERMISSION_DENIED');
});

test('executor failures are reported as failures and never converted into success', async () => {
  clearActionConfirmations();
  const actionContext = context();
  actionContext.channel.send = async () => { throw new Error('Discord rejected the request'); };
  const plan = createActionPlan('message.send', { content: 'Hello' }, actionContext, adminPolicy);
  const confirmation = createConfirmation(plan);
  const logs = [];
  await assert.rejects(
    () => executeActionPlan(plan, actionContext, { confirmationId: confirmation.id, policy: adminPolicy, logger: { info() {}, warn: (...args) => logs.push(args) } }),
    (error) => error.code === 'AI_ACTION_DISCORD_FAILED',
  );
  assert.equal(logs[0][1].result, 'failed');
});
