// @vitest-environment jsdom

import { act, cloneElement, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { arePluginMachineExecutionOriginsEqual, definePlugin, PluginError, type JsonValue, type PluginInvocationContext, type PluginServices } from '@happier-dev/plugin-sdk';
import { arePluginMachineExecutionRoutingsEqual, getPluginMachineExecutionRouting, type ActionHandler, type PluginMachineExecutionOriginV1 } from '@happier-dev/plugin-sdk/actions';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { createPluginTestkit, createPluginUiTestkit, createSurfaceContextFixture, type PluginTestkit, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { CONVERSATION_MANAGEMENT_ACTION_IDS_V1, ConversationConnectionListResultV1Schema } from '@happier-dev/channels-protocol/v1';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { PluginUiDataClient } from '@happier-dev/plugin-ui/data';
import { createUnavailablePluginUiAccountKv } from '../../../plugin-ui/src/data/accountKv.js';
import { activate as activateTelegram, PLUGIN_MANIFEST as TELEGRAM_MANIFEST } from '@happier-dev/plugins-channel-telegram';

import { CHANNELS_PLUGIN, CHANNELS_PROVIDER_POINT_REF, PLUGIN_MANIFEST } from './manifest.js';
import { CHANNEL_DELIVERIES_COLLECTION, CHANNEL_STATE_COLLECTION } from './collections.js';
import { runConversationCheckpointedPollForInvocation } from './ingress.js';
import { recordConversationCheckpointedPollHistoryGapForInvocation } from './management.js';
import { createConversationOutwardDeliveryCollectionStore } from './outwardDelivery.js';
import { deliverConversationOutwardDeliveryThroughProviderAction } from './outwardDeliveryProviderActions.js';
import { MemoryCollection } from './testkit/memoryCollection.js';
import { channelsTargetedContributionServices } from './testkit/operationOnlyTargetedContributionsFixture.js';
import { CONNECTIONS_RESOURCE_RUNTIME } from './connectionsResource.js';
import { resourceText } from './testkit/resourceContract.js';
import { renderSurface } from './ui/renderSurface.js';

const pluginId = TELEGRAM_MANIFEST.id;
const credentialRef = { service: { pluginId, localId: 'telegram-bot' }, accountId: 'journey-account' };
const compiledState = compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema);
const compiledDeliveries = compilePluginJsonSchema(CHANNEL_DELIVERIES_COLLECTION.schema);

async function journey(kind: 'source' | 'bundled' | 'materialization', omitCreateRegistration = false, omitPollRetryRegistration = false) {
  const state = new MemoryCollection<Record<string, JsonValue>>();
  const deliveries = new MemoryCollection<Record<string, JsonValue>>();
  const effects: string[] = [];
  const providerActions: string[] = [];
  let pollNetworkUnavailable = false;
  let generation = 'a';
  const materializationRef = () => ({ pluginId, machineId: 'journey-machine', materializationId: `telegram-${generation}` });
  const currentOrigin = (): PluginMachineExecutionOriginV1 => kind !== 'materialization'
    ? { serverIdentityId: 'srv_plugin_testkit', sourceRef: { pluginId, machineId: 'journey-machine',
      sourceCustody: kind === 'source'
        ? { kind: 'development', registeredRootId: `/source-bundle/${generation}` }
        : { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: `cli-root-${generation}` } } } }
    : { serverIdentityId: 'srv_plugin_testkit', materializationRef: materializationRef() };
  const http: PluginServices['http'] = {
    async openWebSocket() { throw new Error('Telegram uses HTTP'); },
    async request(request) {
      const operation = new URL(request.url).pathname.split('/').at(-1)!;
      effects.push(operation);
      if (operation === 'getUpdates' && pollNetworkUnavailable) throw new Error('The fixture network is unavailable.');
      const result = operation === 'getWebhookInfo' ? { url: '', pending_update_count: 0 }
        : operation === 'getUpdates' ? []
          : operation === 'getChat' ? { id: 456, type: 'private', first_name: 'Journey recipient' }
          : operation === 'sendMessage' ? { message_id: 101 }
            : operation === 'getMe' ? { id: 123, is_bot: true, first_name: 'Journey Bot', username: 'JourneyBot', can_read_all_group_messages: true }
              : undefined;
      if (result === undefined) throw new Error(`Unexpected Telegram operation ${operation}`);
      return { status: 200, finalUrl: request.url, headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ ok: true, result })) };
    },
  };
  // Credentials and HTTP are external system boundaries. Telegram codecs,
  // setup, test, polling and delivery remain the actual provider handlers.
  const connectedAccounts = { async materialize() {
    return { kind: 'environment', env: { TELEGRAM_BOT_TOKEN: '123:journey-token' } };
  } } as unknown as PluginServices['connectedAccounts'];
  const provider = await createPluginTestkit({ manifest: TELEGRAM_MANIFEST,
    module: { activate: api => activateTelegram({ ...api, actions: { ...api.actions,
      register<I extends JsonValue, O extends JsonValue | void>(id: string, handler: ActionHandler<I, O>) {
        api.actions.register<I, O>(id, async (input, context) => {
          providerActions.push(id);
          return await handler(input, context);
        });
      },
    } }) }, services: { http, connectedAccounts }, resolveCurrentPluginMaterializationRef: materializationRef });
  const storage = { account: { collection(definition: { id: string }) {
    if (definition.id === CHANNEL_STATE_COLLECTION.id) return state;
    if (definition.id === CHANNEL_DELIVERIES_COLLECTION.id) return deliveries;
    throw new Error('Unexpected Collection');
  } } } as unknown as PluginServices['storage'];
  let kit: PluginTestkit;
  let connectionId = '';
  let deliverySequence = 0;
  let pollFailure: Error | undefined;
  let deliveryResult: Awaited<ReturnType<typeof deliverConversationOutwardDeliveryThroughProviderAction>> | undefined;
  async function currentConnectionSubject(context: PluginInvocationContext) {
    const list = kit.registration('actions', CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionList);
    if (!list) throw new Error('Missing connection list registration');
    const subject = ConversationConnectionListResultV1Schema.parse(await list({}, context)).connections
      .find(connection => connection.connectionId === connectionId);
    if (!subject) throw new Error('Missing public connection subject');
    return subject;
  }
  function contextWithOrigin(context: PluginInvocationContext): PluginInvocationContext {
    const actions = context.services.actions;
    // The SDK synthetic host currently models only materializations. This is
    // the genuine host execution-origin envelope boundary: native targeted
    // dispatch still parses the declared role and invokes the real plugin.
    // Source currentness uses Protocol/Admin's exact shared equality rule.
    return { ...context, services: { ...context.services, actions: { ...actions,
      async executeAdmittedTargetedOperationWithExecutionOrigin(operation, input, options) {
        // A host invocation refusal is a genuine process boundary. All
        // Channels admission, persistence and presentation below it stay real.
        if (pollFailure !== undefined) throw pollFailure;
        if (kind === 'materialization') {
          return await actions.executeAdmittedTargetedOperationWithExecutionOrigin(operation, input, options);
        }
        const origin = currentOrigin();
        if (options?.expectedExecutionOrigin && !arePluginMachineExecutionOriginsEqual(options.expectedExecutionOrigin, origin)) {
          throw Object.assign(new Error('Source occurrence changed'), { code: 'plugin_action_execution_origin_mismatch' });
        }
        if (options?.expectedExecutionRouting && !arePluginMachineExecutionRoutingsEqual(options.expectedExecutionRouting, getPluginMachineExecutionRouting(origin))) {
          throw Object.assign(new Error('Source routing changed'), { code: 'plugin_action_execution_origin_mismatch' });
        }
        const execution = await actions.executeAdmittedTargetedOperationWithExecutionOrigin(operation, input,
          { signal: options?.signal });
        return { ...execution, executionOrigin: origin };
      },
    } } };
  }
  const driver = definePlugin({ id: PLUGIN_MANIFEST.id, version: '0.0.0', actions: {
    'journey/create': { title: 'Create through the activated Action', surfaces: ['plugin'], dangerLevel: 'safe',
      async run(input, context) {
        const handler = kit.registration('actions', 'connection/create-v1');
        if (!handler) throw new Error('Missing connection creation registration');
        return await handler(input, contextWithOrigin(context));
      } },
    'journey/poll': { title: 'Poll the retained connection', surfaces: ['plugin'], dangerLevel: 'safe',
      async run(_input, context) {
        await runConversationCheckpointedPollForInvocation({ connectionId, waitMs: 0 }, contextWithOrigin(context));
        return null;
      } },
    'journey/retest': { title: 'Test the retained connection', surfaces: ['plugin'], dangerLevel: 'safe',
      async run(_input, context) {
        const subject = await currentConnectionSubject(context);
        const handler = kit.registration('actions', CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionRetest);
        if (!handler) throw new Error('Missing retest registration');
        return await handler({ connectionId, expectedRevision: subject.revision, authorityEpoch: subject.authorityEpoch }, contextWithOrigin(context));
      } },
    'journey/resolve': { title: 'Resolve a retained provider endpoint', surfaces: ['plugin'], dangerLevel: 'safe',
      async run(_input, context) {
        const subject = await currentConnectionSubject(context);
        const handler = kit.registration('actions', CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve);
        if (!handler) throw new Error('Missing resolve registration');
        return await handler({ kind: 'endpoint', connectionId, expectedConnectionRevision: subject.revision, query: '456' }, contextWithOrigin(context));
      } },
    'journey/baseline': { title: 'Recover a retained connection baseline', surfaces: ['plugin'], dangerLevel: 'safe',
      async run(_input, originalContext) {
        const context = contextWithOrigin(originalContext);
        const before = await state.get(connectionId);
        if (!before) throw new Error('Missing retained baseline connection');
        await recordConversationCheckpointedPollHistoryGapForInvocation({ connectionId, expectedRevision: before.revision,
          authorityEpoch: 1, executionOrigin: currentOrigin(), fact: { reason: 'providerHistoryUnavailable' } }, context);
        const subject = await currentConnectionSubject(context);
        const handler = kit.registration('actions', CONVERSATION_MANAGEMENT_ACTION_IDS_V1.streamBaselineAccept);
        if (!handler) throw new Error('Missing baseline registration');
        return await handler({ connectionId, expectedRevision: subject.revision }, context);
      } },
    'journey/gap': { title: 'Report a provider history gap', surfaces: ['plugin'], dangerLevel: 'safe',
      async run(_input, originalContext) {
        const row = await state.get(connectionId);
        if (!row) throw new Error('Missing retained gap connection');
        await recordConversationCheckpointedPollHistoryGapForInvocation({ connectionId, expectedRevision: row.revision,
          authorityEpoch: 1, executionOrigin: currentOrigin(), fact: { reason: 'providerHistoryUnavailable' } }, contextWithOrigin(originalContext));
        return null;
      } },
    'journey/reconcile': { title: 'Read the retained connection as its current provider', surfaces: ['plugin'], dangerLevel: 'safe',
      async run(_input, context) {
        const handler = kit.registration('actions', 'provider/connections-list-v1');
        if (!handler) throw new Error('Missing provider reconciliation registration');
        const entry = kit.readTargetedContributionFixture(CHANNELS_PROVIDER_POINT_REF).contributions[0]!;
        const executionOrigin = currentOrigin();
        // Caller provenance is stamped at the external host boundary; none
        // of these authority fields comes from the reconciliation Action input.
        return await handler({}, { ...context, caller: { kind: 'plugin', pluginId,
          contribution: { id: 'telegram/poll-updates', qualifiedId: `${pluginId}/actions/telegram/poll-updates` },
          occurrenceId: entry.contributor.occurrenceId,
          sourceCustody: 'sourceRef' in executionOrigin ? executionOrigin.sourceRef.sourceCustody : entry.contributor.sourceCustody,
          executionOrigin,
          // The host carries this auxiliary ref even when source custody was selected.
          materialization: materializationRef(),
        } });
      } },
    'journey/transport-fact': { title: 'Report current provider readiness', surfaces: ['plugin'], dangerLevel: 'safe',
      async run(_input, context) {
        const handler = kit.registration('actions', 'provider/transport-fact-report-v1');
        if (!handler) throw new Error('Missing transport fact registration');
        const entry = kit.readTargetedContributionFixture(CHANNELS_PROVIDER_POINT_REF).contributions[0]!;
        const executionOrigin = currentOrigin();
        return await handler({ connectionId, authorityEpoch: 1,
          fact: { kind: 'providerReadiness', status: 'ready' } }, { ...context, caller: {
          kind: 'plugin', pluginId,
          contribution: { id: 'telegram/poll-updates', qualifiedId: `${pluginId}/actions/telegram/poll-updates` },
          occurrenceId: entry.contributor.occurrenceId,
          sourceCustody: 'sourceRef' in executionOrigin ? executionOrigin.sourceRef.sourceCustody : entry.contributor.sourceCustody,
          executionOrigin, materialization: materializationRef(),
        } });
      } },
    'journey/deliver': { title: 'Deliver through custody and the registered provider', surfaces: ['plugin'], dangerLevel: 'safe',
      async run(_input, originalContext) {
        deliverySequence += 1;
        const context = contextWithOrigin(originalContext);
        const store = createConversationOutwardDeliveryCollectionStore({ stateCollection: state,
          deliveriesCollection: deliveries as unknown as Parameters<typeof createConversationOutwardDeliveryCollectionStore>[0]['deliveriesCollection'],
          now: Date.now, signal: context.signal });
        deliveryResult = await deliverConversationOutwardDeliveryThroughProviderAction({ stateCollection: state,
          targetedContributions: context.services.targetedContributions, actions: context.services.actions,
          store, attemptId: `journey-attempt-${deliverySequence}`, now: Date.now, signal: context.signal,
          obligation: { connectionId, routeAuthority: { connectionAuthorityEpoch: 1 },
            source: { kind: 'controlResponse', controlId: `journey-control-${deliverySequence}`, controlKind: 'recovery' },
            endpoint: { kind: 'direct', audience: 'direct', id: '456' }, content: { text: 'Hello from the journey' },
            deliveryKey: `journey-delivery-${deliverySequence}`, mentionPolicy: 'suppress', linkPreviewPolicy: 'suppress' } });
        return null;
      } },
  } });
  try {
    kit = await createPluginTestkit({ manifest: { ...PLUGIN_MANIFEST, contributes: { ...PLUGIN_MANIFEST.contributes,
    actions: [...(PLUGIN_MANIFEST.contributes?.actions ?? []), ...(driver.manifest.contributes?.actions ?? [])] } },
    module: { async activate(api) {
      const dispose = await CHANNELS_PLUGIN.activate(omitCreateRegistration || omitPollRetryRegistration ? {
        ...api, actions: { ...api.actions, register(id, handler) {
          if (!(omitCreateRegistration && id === 'connection/create-v1')
            && !(omitPollRetryRegistration && id === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPollRetry)) {
            api.actions.register(id, handler);
          }
        } },
      } : api);
      await driver.activate(api);
      return dispose;
    } },
      targetedContributionContributors: [provider], services: { storage } });
  } catch (error) {
    await provider.dispose();
    throw error;
  }
  const invoke = (id: string, input: JsonValue) => kit.invokeAction(id, input, {
    surface: id.startsWith('journey/') ? 'plugin' : 'cli', services: channelsTargetedContributionServices(kit) });
  const snapshot = kit.readTargetedContributionFixture(CHANNELS_PROVIDER_POINT_REF);
  const contribution = snapshot.contributions[0]!;
  const create = () => invoke('journey/create', { providerSelection: {
    target: { pluginId: PLUGIN_MANIFEST.id, sourceCustody: snapshot.sourceCustody },
    point: { pointId: CHANNELS_PROVIDER_POINT_REF.id, protocol: CHANNELS_PROVIDER_POINT_REF.protocol },
    contributor: { pluginId, contributionId: contribution.contributor.contributionId, sourceCustody: contribution.contributor.sourceCustody },
  }, providerSetupInput: { credentialRef }, credentialRef, selectedTransport: 'checkpointedPull', maximumObservationAgeMs: 60_000 });
  return { state, deliveries, effects, providerActions, create, currentOrigin, invoke,
    failPoll(error: Error) { pollFailure = error; },
    clearPollFailure() { pollFailure = undefined; },
    setPollNetworkUnavailable(value: boolean) { pollNetworkUnavailable = value; },
    async connectionsResource() {
      return resourceText(await CONNECTIONS_RESOURCE_RUNTIME.read({
        signal: new AbortController().signal, context: { kind: 'global' }, accountStorage: storage.account,
      }));
    },
    deliveryResult: () => deliveryResult,
    setConnectionId(id: string) { connectionId = id; },
    replaceOrigin() { generation = 'b'; },
    async dispose() { await kit.dispose(); await provider.dispose(); } };
}

describe('Channels connection creation to registered provider journey', () => {
  it('honors an approved poll Retry when the same connection has moved from blocked to automatic backoff', async () => {
    const fixture = await journey('materialization');
    try {
      const created = await fixture.create();
      if (created === null || typeof created !== 'object' || !('connectionId' in created)
        || typeof created.connectionId !== 'string') throw new Error('Expected a created connection.');
      fixture.setConnectionId(created.connectionId);
      fixture.failPoll(new PluginError({ code: 'plugin_action_form_connected_account_options_unavailable',
        message: 'The selected Connected Account is no longer available for this Action form.' }));
      await fixture.invoke('journey/poll', {});
      const approved = ConversationConnectionListResultV1Schema.parse(JSON.parse(await fixture.connectionsResource())).connections[0]!;
      expect(approved.attention.pollFailure?.phase).toBe('blocked');
      fixture.clearPollFailure();
      const request = { connectionId: created.connectionId, expectedRevision: approved.revision, authorityEpoch: approved.authorityEpoch };
      await fixture.invoke(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPollRetry, request);
      fixture.setPollNetworkUnavailable(true);
      await fixture.invoke('journey/poll', {});
      const automatic = ConversationConnectionListResultV1Schema.parse(JSON.parse(await fixture.connectionsResource())).connections[0]!;
      expect(automatic.attention.pollFailure?.phase).toBe('retryDue');
      expect(automatic.revision).toBe(approved.revision);
      const retained = await fixture.state.get(created.connectionId);
      const beforeRejected = JSON.stringify([...fixture.state.rows.values()]);
      const effectsBeforeRetry = [...fixture.effects];
      for (const stale of [{ ...request, expectedRevision: request.expectedRevision + 1 },
        { ...request, authorityEpoch: request.authorityEpoch + 1 }]) {
        await expect(fixture.invoke(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPollRetry, stale))
          .rejects.toMatchObject({ code: 'channels_connection_poll_retry_conflict' });
      }
      expect(JSON.stringify([...fixture.state.rows.values()])).toBe(beforeRejected);
      expect(await fixture.state.get(created.connectionId)).toEqual(retained);
      fixture.setPollNetworkUnavailable(false);
      await expect(fixture.invoke(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPollRetry, request))
        .resolves.toMatchObject({ kind: 'retryScheduled', revision: approved.revision });
      expect(fixture.effects).toEqual(effectsBeforeRetry);
      await fixture.invoke('journey/poll', {});
      const recovered = ConversationConnectionListResultV1Schema.parse(JSON.parse(await fixture.connectionsResource())).connections[0]!;
      expect(recovered.attention.pollFailure).toBeNull();
      expect([...fixture.state.rows.values()].some(row => row.value['record-kind'] === 'checkpoint')).toBe(true);
      for (const row of fixture.state.rows.values()) expect(isValidPluginJsonSchemaValue(compiledState, row.value)).toBe(true);
    } finally { await fixture.dispose(); }
  });

  it.each(['bindingResolve', 'connectionRetest', 'connectionPollRetry'] as const)(
    'keeps the approved connection revision usable by %s after poll status bookkeeping', async consumer => {
      const fixture = await journey('materialization');
      try {
        const created = await fixture.create();
        if (created === null || typeof created !== 'object' || !('connectionId' in created)
          || typeof created.connectionId !== 'string') throw new Error('Expected a created connection.');
        const connectionId = created.connectionId;
        fixture.setConnectionId(connectionId);
        const original = ConversationConnectionListResultV1Schema.parse(JSON.parse(await fixture.connectionsResource())).connections[0];
        if (!original) throw new Error('Expected the public connection subject.');
        const before = await fixture.state.get(connectionId);
        fixture.failPoll(new PluginError({ code: 'plugin_action_caller_unavailable', message: 'The current integration caller is unavailable.' }));
        await fixture.invoke('journey/poll', {});
        fixture.clearPollFailure();
        expect((await fixture.state.get(connectionId))?.revision).toBeGreaterThan(before!.revision);
        const result = await fixture.invoke(CONVERSATION_MANAGEMENT_ACTION_IDS_V1[consumer], consumer === 'bindingResolve'
          ? { kind: 'endpoint', connectionId, expectedConnectionRevision: original.revision, query: '456' }
          : { connectionId, expectedRevision: original.revision, authorityEpoch: original.authorityEpoch });
        expect(result).toMatchObject(consumer === 'bindingResolve'
          ? { kind: 'endpointCandidates', candidates: [{ kind: 'direct', id: '456' }] }
          : consumer === 'connectionRetest' ? { kind: 'ready' } : { kind: 'retryScheduled' });
        if (consumer === 'connectionPollRetry') {
          await expect(fixture.invoke(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPollRetry, {
            connectionId, expectedRevision: original.revision, authorityEpoch: original.authorityEpoch,
          })).resolves.toMatchObject({ kind: 'retryScheduled' });
        }
        const current = ConversationConnectionListResultV1Schema.parse(JSON.parse(await fixture.connectionsResource())).connections[0];
        expect(current?.revision).toBe(original.revision);
        for (const row of fixture.state.rows.values()) expect(isValidPluginJsonSchemaValue(compiledState, row.value)).toBe(true);
      } finally { await fixture.dispose(); }
    },
  );

  it.each(['bindingResolve', 'connectionRetest'] as const)(
    'refuses an old %s connection subject after a real observation-age policy edit', async consumer => {
      const fixture = await journey('materialization');
      try {
        const created = await fixture.create();
        if (created === null || typeof created !== 'object' || !('connectionId' in created)
          || typeof created.connectionId !== 'string') throw new Error('Expected a created connection.');
        const connectionId = created.connectionId;
        fixture.setConnectionId(connectionId);
        const original = ConversationConnectionListResultV1Schema.parse(JSON.parse(await fixture.connectionsResource())).connections[0];
        if (!original) throw new Error('Expected the public connection subject.');
        await fixture.invoke(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionUpdate, {
          connectionId, expectedRevision: original.revision, enabled: original.enabled,
          maximumObservationAgeMs: original.maximumObservationAgeMs + 1,
        });
        const current = ConversationConnectionListResultV1Schema.parse(JSON.parse(await fixture.connectionsResource())).connections[0];
        expect(current?.authorityEpoch).toBe(original.authorityEpoch);
        expect(current?.revision).toBeGreaterThan(original.revision);
        const pending = fixture.invoke(CONVERSATION_MANAGEMENT_ACTION_IDS_V1[consumer], consumer === 'bindingResolve'
          ? { kind: 'endpoint', connectionId, expectedConnectionRevision: original.revision, query: '456' }
          : { connectionId, expectedRevision: original.revision, authorityEpoch: original.authorityEpoch });
        if (consumer === 'bindingResolve') await expect(pending).resolves.toMatchObject({ kind: 'stale' });
        else await expect(pending).rejects.toMatchObject({ code: 'channels_connection_retest_conflict' });
      } finally { await fixture.dispose(); }
    },
  );

  it('refuses a baseline approval whose original history gap was settled and replaced', async () => {
    const fixture = await journey('materialization');
    try {
      const created = await fixture.create();
      if (created === null || typeof created !== 'object' || !('connectionId' in created)
        || typeof created.connectionId !== 'string') throw new Error('Expected a created connection.');
      const connectionId = created.connectionId;
      fixture.setConnectionId(connectionId);
      await fixture.invoke('journey/gap', {});
      const original = ConversationConnectionListResultV1Schema.parse(JSON.parse(await fixture.connectionsResource())).connections[0];
      if (!original) throw new Error('Expected the original history-gap subject.');
      expect(original.attention.historyGap).not.toBeNull();
      await fixture.invoke(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.streamBaselineAccept, { connectionId, expectedRevision: original.revision });
      await fixture.invoke('journey/gap', {});
      const replacement = ConversationConnectionListResultV1Schema.parse(JSON.parse(await fixture.connectionsResource())).connections[0];
      expect(replacement?.attention.historyGap).not.toBeNull();
      expect(replacement?.revision).toBeGreaterThan(original.revision);
      await expect(fixture.invoke(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.streamBaselineAccept,
        { connectionId, expectedRevision: original.revision })).rejects.toMatchObject({ code: 'channels_stream_baseline_conflict' });
    } finally { await fixture.dispose(); }
  });

  it('carries a redacted poll refusal from real ingress through management into mounted attention', async () => {
    const fixture = await journey('materialization');
    let ui: PluginUiTestkit | undefined;
    const actionable = 'The integration caller is no longer current. Reload the integration, then retry polling.';
    try {
      const result = await fixture.create();
      if (result === null || typeof result !== 'object' || !('connectionId' in result)
        || typeof result.connectionId !== 'string') throw new Error('Expected a created connection.');
      const connectionId = result.connectionId;
      fixture.setConnectionId(connectionId);
      fixture.failPoll(new PluginError({ code: 'plugin_action_caller_unavailable',
        message: `${actionable} Authorization: Bearer poll-secret-canary; path=/private/poll-canary`,
        details: { privateDiagnostic: 'raw-diagnostic-canary' } }));
      await fixture.invoke('journey/poll', {});
      const retained = (await fixture.state.get(connectionId))?.value;
      const serialized = JSON.stringify(retained);
      expect(serialized).toContain(actionable);
      expect(serialized).not.toContain('poll-secret-canary');
      expect(serialized).not.toContain('/private/poll-canary');
      expect(serialized).not.toContain('raw-diagnostic-canary');
      expect(isValidPluginJsonSchemaValue(compiledState, retained)).toBe(true);
      const resource = await fixture.connectionsResource();
      const projected = ConversationConnectionListResultV1Schema.parse(JSON.parse(resource));
      expect(projected.connections[0]?.attention.pollFailure).toMatchObject({
        evidence: { kind: 'action', code: 'plugin_action_caller_unavailable', message: expect.stringContaining(actionable) },
      });
      const dataClient = {
        collection: (definition: { id: string }) => definition.id === CHANNEL_STATE_COLLECTION.id
          ? fixture.state : fixture.deliveries,
        openCollectionQuery: async () => { throw new Error('This journey reads through the Resource.'); },
        accountKv: createUnavailablePluginUiAccountKv(),
      } as unknown as PluginUiDataClient;
      const adapter = createPluginUiRnwSemanticSurfaceAdapter();
      ui = await createPluginUiTestkit({
        identity: { instanceId: 'poll-failure-journey', mountNonce: 'poll-failure-journey-mount' },
        authorPlugin: { id: PLUGIN_MANIFEST.id, version: '0.0.0' }, surface: renderSurface,
        surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination',
          destination: { pluginId: PLUGIN_MANIFEST.id, localId: 'channels-account' }, container: 'rightSidebarTab' } }),
        adapter: { async mount(input) {
          return await adapter.mount({ ...input, surface: context => cloneElement(
            input.surface(context) as ReactElement<{ dataClient?: PluginUiDataClient }>, { dataClient }) });
        } },
        handlers: {
          readResource: async ({ resource: requested }) => {
            const localId = typeof requested === 'string' ? requested : 'localId' in requested ? requested.localId : '';
            return { bytes: new TextEncoder().encode(
              localId === 'connections-v1' ? resource : JSON.stringify({ bindings: [] })),
              contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}` };
          },
        },
      });
      expect(document.querySelector(`[data-testid="channels-connection-${connectionId}"]`)?.getAttribute('aria-label')).toContain(actionable);
      await act(async () => { document.querySelector<HTMLElement>(`[data-testid="channels-connection-${connectionId}"]`)?.click(); });
      expect(document.querySelector('[data-testid="channels-poll-blocked-disclosure"]')?.textContent).toContain(actionable);
      expect(document.body.textContent).not.toContain('poll-secret-canary');
      expect(document.body.textContent).not.toContain('/private/poll-canary');
    } finally { await ui?.dispose(); await fixture.dispose(); }
  });
  it('refuses the journey when the actual connection creation registration is absent', async () => {
    await expect(journey('source', true)).rejects.toThrow("missing registration 'actions/connection/create-v1'");
  });
  it('refuses recovery when the actual poll Retry registration is absent', async () => {
    await expect(journey('materialization', false, true))
      .rejects.toThrow(`missing registration 'actions/${CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPollRetry}'`);
  });
  it.each(['source', 'bundled', 'materialization'] as const)('creates, checkpoints and delivers across a same-route %s update', async kind => {
    const fixture = await journey(kind);
    try {
      const result = await fixture.create();
      expect(result).toMatchObject({ kind: 'created', connectionId: expect.any(String) });
      const { connectionId } = result as { connectionId: string };
      fixture.setConnectionId(connectionId);
      expect((await fixture.state.get(connectionId))?.value.payload).toMatchObject({
        transportOrigin: { serverIdentityId: 'srv_plugin_testkit', machineId: 'journey-machine' }, authorityEpoch: 1,
      });
      expect.soft(await fixture.invoke('journey/reconcile', {})).toMatchObject({ [connectionId]: { connectionId } });
      expect(await fixture.invoke('journey/transport-fact', {})).toMatchObject({ kind: 'rejoined' });
      await fixture.invoke('journey/poll', {});
      await fixture.invoke('journey/poll', {});
      expect([...fixture.state.rows.values()].find(row => row.value['record-kind'] === 'checkpoint')?.value.payload)
        .toMatchObject({ opaqueToken: { v: 1, offset: expect.any(String) } });
      await fixture.invoke('journey/deliver', {});
      expect(fixture.deliveryResult()).toMatchObject({ kind: 'settled', custody: { state: 'delivered' } });
      expect(fixture.effects).toContain('sendMessage');
      expect([...fixture.deliveries.rows.values()]).toEqual(expect.arrayContaining([
        expect.objectContaining({ value: expect.objectContaining({ payload: expect.objectContaining({ state: 'delivered' }) }) }),
      ]));
      for (const row of fixture.state.rows.values()) expect(isValidPluginJsonSchemaValue(compiledState, row.value)).toBe(true);
      for (const row of fixture.deliveries.rows.values()) expect(isValidPluginJsonSchemaValue(compiledDeliveries, row.value)).toBe(true);
      const setupCount = () => fixture.providerActions.filter(id => id === 'telegram/prepare-bot').length;
      const setupsBeforeUpdate = setupCount();
      expect(setupsBeforeUpdate).toBe(1);
      fixture.replaceOrigin();
      expect(await fixture.invoke('journey/reconcile', {})).toMatchObject({ [connectionId]: { connectionId } });
      expect(setupCount()).toBe(setupsBeforeUpdate);
      expect(await fixture.invoke('journey/retest', {})).toMatchObject({ kind: 'ready', authorityEpoch: 1 });
      // Explicit Test refreshes the saved provider setup; an implementation
      // update and subsequent transport work must not initiate setup themselves.
      const setupsAfterExplicitTest = setupCount();
      expect(await fixture.invoke('journey/resolve', {})).toMatchObject({
        kind: 'endpointCandidates',
        candidates: [{ kind: 'direct', audience: 'direct', id: '456' }],
      });
      const effectsBeforeReplacement = fixture.effects.length;
      await fixture.invoke('journey/poll', {});
      expect(fixture.effects.length).toBeGreaterThan(effectsBeforeReplacement);
      await fixture.invoke('journey/deliver', {});
      expect(fixture.deliveryResult()).toMatchObject({ kind: 'settled', custody: { state: 'delivered' } });
      expect(await fixture.invoke('journey/baseline', {})).toMatchObject({ kind: 'updated', authorityEpoch: 1 });
      expect((await fixture.state.get(connectionId))?.value.payload).toMatchObject({ authorityEpoch: 1, pendingOldTransportStop: null });
      expect(setupCount()).toBe(setupsAfterExplicitTest);
    } finally { await fixture.dispose(); }
  });
});
