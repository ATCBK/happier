import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { ConversationProvidersContributionProtocolV1 } from '@happier-dev/channels-protocol/v1';

import { manifest } from '../src/index.ts';
import * as daemon from '../src/index.ts';

const plainJson = (value) => JSON.parse(JSON.stringify(value));

const connectionInput = Object.freeze({
  v: 1,
  connectionId: 'connection-1',
  providerConnectionKey: 'acme:example-bot',
  providerConfigVersion: 1,
  providerConfig: {},
  credentialRef: null,
});

const deliveryInput = Object.freeze({
  ...connectionInput,
  endpoint: {
    kind: 'direct',
    audience: 'direct',
    id: 'user-1',
    label: 'User 1',
  },
  content: 'Hello from Happier',
  deliveryKey: 'delivery-1',
  mentionPolicy: 'suppress',
  linkPreviewPolicy: 'providerDefault',
});

test('binds public Channels roles and provider presentation without declaring a target or renderer', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');

  assert.equal(packageJson.dependencies['@happier-dev/channels-protocol'], '0.0.0');
  assert.deepEqual(manifest.entrypoints, { daemon: './dist/index.js' });
  assert.match(source, /from '@happier-dev\/channels-protocol\/v1'/u);
  assert.match(source, /ConversationProvidersContributionProtocolV1\.contribute\(\{/u);
  for (const role of ['setup', 'connectionTest', 'messageDeliver', 'connectionStop']) {
    assert.match(source, new RegExp(`roles\\.${role}\\.bind\\(`, 'u'));
  }
  assert.deepEqual(manifest.contributes.targetedPluginContributions[0].descriptor, { v: 1, displayName: 'Acme Chat' });
  assert.doesNotMatch(source, /\brenderers\s*:/u);
});

test('daemon entrypoint registers and executes every bound operation role', async (t) => {
  const plugin = await createPluginTestkit({ manifest, module: daemon });
  t.after(async () => plugin.dispose());

  assert.deepEqual(plugin.registrations()
    .filter((registration) => registration.family === 'actions')
    .map((registration) => registration.localId)
    .sort(), [
      'acme/check-connection',
      'acme/connect',
      'acme/send-message',
      'acme/stop-socket',
    ]);

  assert.deepEqual(plainJson(await plugin.invokeAction('acme/connect', {}, { surface: 'plugin' })), {
    v: 1,
    credentialRef: null,
    providerConnectionKey: 'acme:example-bot',
    providerConfigVersion: 1,
    providerConfig: {},
    integrationPrincipal: { id: 'acme:example-bot' },
    supportedTransports: ['socket'],
    recommendedTransport: 'socket',
    overlapSafety: 'safe',
    replayContinuity: 'sessionBound',
    outboundTextLimit: { maximum: 4000, unit: 'unicodeCodePoints' },
  });
  assert.deepEqual(plainJson(await plugin.invokeAction(
    'acme/check-connection',
    { ...connectionInput, selectedTransport: 'socket' },
    { surface: 'plugin' },
  )), {
    kind: 'ready',
    integrationPrincipal: { id: 'acme:example-bot' },
    providerConnectionKey: 'acme:example-bot',
  });
  assert.deepEqual(plainJson(await plugin.invokeAction('acme/send-message', deliveryInput, { surface: 'plugin' })), {
    kind: 'delivered',
    providerMessageIds: [],
  });
  assert.deepEqual(plainJson(await plugin.invokeAction(
    'acme/stop-socket',
    { ...connectionInput, authorityEpoch: 1, reason: 'disable' },
    { surface: 'plugin' },
  )), { kind: 'stopped' });
});

test('operation bindings keep protocol-owned action facts and reject caller-surface drift', () => {
  const roles = ConversationProvidersContributionProtocolV1.operations;
  const actionById = new Map(manifest.contributes.actions.map((action) => [action.id, action]));
  const provider = manifest.contributes.targetedPluginContributions.find(
    (contribution) => contribution.id === 'acme',
  );
  assert.ok(provider);

  for (const [roleName, actionId] of Object.entries({
    setup: 'acme/connect',
    connectionTest: 'acme/check-connection',
    messageDeliver: 'acme/send-message',
    connectionStop: 'acme/stop-socket',
  })) {
    const role = roles[roleName];
    const action = actionById.get(actionId);
    assert.ok(action, `missing ${actionId}`);
    assert.deepEqual(action.surfaces, role.declaration.surfaces);
    assert.equal(action.dangerLevel, role.declaration.dangerLevel);
    // One explicit public execution target on every contributed Action is a
    // required part of the minimal complete declaration; assert it through the
    // projected manifest so a missing target fails this conformance boundary.
    assert.deepEqual(action.execution, { target: 'daemon' });
    assert.deepEqual(action.resultSchema, role.declaration.resultSchema.jsonSchema);
    assert.ok(!action.surfaces.includes('cli'));
    assert.ok(!action.surfaces.includes('mcp'));
    assert.ok(!action.surfaces.includes('agent'));
  }

  assert.deepEqual(provider.target, { pluginId: 'happier.channels', pointId: 'providers' });
  assert.deepEqual(provider.protocol, {
    id: ConversationProvidersContributionProtocolV1.id,
    version: ConversationProvidersContributionProtocolV1.version,
  });
  assert.deepEqual(provider.operations, {
    setup: 'acme/connect',
    connectionTest: 'acme/check-connection',
    messageDeliver: 'acme/send-message',
    connectionStop: 'acme/stop-socket',
  });
});

test('rejects a plugin caller without current host-stamped provenance', async (t) => {
  // A Channels target invokes these provider roles through the contributed
  // Action service. That caller path is rejected unless the calling plugin
  // carries current host-stamped materialization provenance; a caller surface
  // a role does not declare is rejected by the daemon dispatcher itself.
  const plugin = await createPluginTestkit({ manifest, module: daemon });
  t.after(async () => plugin.dispose());

  const caller = await createPluginTestkit({
    manifest: {
      schemaVersion: 2,
      id: 'acme.caller',
      version: '0.1.0',
      displayName: 'Acme Caller Fixture',
      runtime: manifest.runtime,
      contributes: {
        actions: [{
          id: 'relay-connect',
          title: 'Relay connect',
          scopes: ['global'],
          execution: { target: 'daemon' },
          dangerLevel: 'safe',
          surfaces: ['plugin'],
        }],
      },
    },
    actionTargets: [plugin],
    resolveCurrentPluginMaterializationRef: () => null,
    module: {
      activate(api) {
        api.actions.register('relay-connect', async (input, context) => context.services.actions.execute(
          { pluginId: 'examples.operation-only-channel-provider', localId: 'acme/connect' },
          input,
        ));
      },
    },
  });
  t.after(async () => caller.dispose());

  await assert.rejects(
    () => caller.invokeAction('relay-connect', {}, { surface: 'plugin' }),
    { code: 'plugin_action_caller_unavailable' },
  );
});
