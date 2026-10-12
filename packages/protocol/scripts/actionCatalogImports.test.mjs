import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('keeps private Automation read projections cold during catalog import', () => {
  // Count real Classic constructor allocations in a fresh native graph. This is
  // instrumentation, not a replacement parser or a mocked schema factory.
  const output = execFileSync(process.execPath, [
    '--experimental-transform-types', '--expose-gc',
    fileURLToPath(new URL('./profile-schema-memory.mjs', import.meta.url)),
    'packages/protocol/src/automations/automationApiV3.ts', '--census', '--all-owners',
  ], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8' });
  const census = JSON.parse(output.trim());
  const projections = census.ownersByLiveCount.find(([owner]) => owner.endsWith('/json/storedReadSchema.ts'));
  assert.equal(projections?.[1].instances ?? 0, 0);
});

test('initializes the Action vocabulary before loading its payload catalog in native ESM', async () => {
  // Vitest transforms the module graph; native ESM also has to admit an ID-first
  // consumer without reading a catalog binding in its temporal dead zone.
  const { ACTION_IDS, ActionIdSchema } = await import('../src/actions/actionIds.js');
  const { PluginInvocableActionIdSchema } = await import('../src/actions/pluginActionSurface.js');
  const { getActionSpec } = await import('../src/actions/actionSpecs.js');

  assert.ok(ACTION_IDS.includes('memory.remember'));
  assert.equal(ActionIdSchema.parse('memory.remember'), 'memory.remember');
  assert.equal(PluginInvocableActionIdSchema.parse('memory.remember'), 'memory.remember');
  assert.equal(PluginInvocableActionIdSchema.safeParse('session.handoff.commit').success, false);
  assert.equal(PluginInvocableActionIdSchema.safeParse('not.an.action').success, false);
  assert.equal(getActionSpec('memory.remember').executionPlacement, 'account');

  const groupInput = getActionSpec('widgets.group.ungroup').inputSchema;
  const ref = { surface: { serverId: 'home', accountId: 'account', owner: { kind: 'home' } }, instanceId: 'group' };
  assert.deepEqual(groupInput.parse({ ref }), { ref });
  assert.equal(groupInput.safeParse({ ref: { ...ref, extra: true } }).success, false);
  assert.equal(groupInput.safeParse({ ref: { ...ref, surface: {
    ...ref.surface, owner: { kind: 'sessionBoard', sessionId: 'session' },
  } } }).success, false);
});
