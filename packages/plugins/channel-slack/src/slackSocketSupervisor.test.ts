import { describe, expect, it, vi } from 'vitest';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { PluginWebSocketConnection } from '@happier-dev/plugin-sdk/http';
import { CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1, ConversationProviderConnectionReconciliationSnapshotV1Schema,
  ConversationProviderObservationIngestInputV1Schema, ConversationTransportFactReportInputV1Schema } from '@happier-dev/channels-protocol/v1';
import { createSlackSocketSupervisor } from './slackSocketSupervisor.js';
import { SLACK_SOCKET_BACKGROUND_SERVICE_ID, SLACK_SOCKET_WORKER_ATTEMPT_ACTION_ID } from './slackPluginConstants.js';

const credentialRef = { service: { pluginId: 'happier.channel.slack', localId: 'slack-bot' }, accountId: 'slack:T1:U1' };
const snapshot = ConversationProviderConnectionReconciliationSnapshotV1Schema.parse({ v: 1, connectionId: 'connection-1',
  providerConnectionKey: 'slack:team:T1:app:A1', providerConfigVersion: 1,
  providerConfig: { teamId: 'T1', appId: 'A1', botUserId: 'U1', botId: 'B1', label: 'Happier' }, credentialRef,
  authorityEpoch: 7, enabled: true, deletionState: 'none', requiresFullSharedMessageContent: false });

function harness(input: Readonly<{ unreadable?: boolean; disconnect?: boolean; failFacts?: boolean }> = {}) {
  const supervisor = createSlackSocketSupervisor();
  const controller = new AbortController();
  const frames: unknown[] = [{ type: 'hello', connection_info: { app_id: 'A1' } }, {
    type: 'events_api', envelope_id: 'envelope-1', payload: { type: 'event_callback', team_id: 'T1', api_app_id: 'A1', event_id: 'Ev1',
      event: { type: 'message', channel: 'C1', user: 'U2', text: 'hello', ts: '1700000000.000001' } },
  }, ...(input.disconnect ? [{ type: 'disconnect', reason: 'refresh_requested' }] : [])];
  let close!: () => void;
  const closed = new Promise<Readonly<{ kind: 'local'; wasClean: true }>>(resolve => { close = () => resolve({ kind: 'local', wasClean: true }); });
  const socket: PluginWebSocketConnection = { url: 'wss://wss-primary.slack.com/link', protocol: '', closed,
    async send() {},
    async receive(options) {
      options?.signal?.throwIfAborted();
      const frame = frames.shift();
      if (frame) return { kind: 'text', text: JSON.stringify(frame) };
      const value = await closed;
      return { kind: 'closed', close: value };
    },
    close,
    dispose() { close(); },
  };
  const admissions: unknown[] = [];
  const facts: ReturnType<typeof ConversationTransportFactReportInputV1Schema.parse>[] = [];
  let reads = 0;
  let socketsOpened = 0;
  let listed = true;
  let background!: BackgroundServiceContext;
  const execute = vi.fn(async (action: string | Readonly<{ pluginId: string; localId: string }>, value: unknown, options?: Readonly<{ signal?: AbortSignal }>) => {
    if (typeof action === 'string') throw new Error('Unexpected host Action.');
    if (action.pluginId === 'happier.channel.slack' && action.localId === SLACK_SOCKET_WORKER_ATTEMPT_ACTION_ID) {
      await supervisor.runWorkerAttempt(ConversationProviderConnectionReconciliationSnapshotV1Schema.parse(value), {
        ...background, surface: 'plugin', signal: options?.signal ?? controller.signal,
        contribution: { id: SLACK_SOCKET_WORKER_ATTEMPT_ACTION_ID, qualifiedId: `happier.channel.slack/actions/${SLACK_SOCKET_WORKER_ATTEMPT_ACTION_ID}` },
        caller: { kind: 'plugin', pluginId: 'happier.channel.slack', occurrenceId: 'slack-generation-1',
          sourceCustody: { kind: 'managed', immutableGenerationId: 'slack-generation-1', installSource: 'npm' },
          contribution: background.contribution, originSurface: 'background',
          materialization: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'happier.channel.slack' } },
      });
      return;
    }
    if (action.pluginId !== 'happier.channels') throw new Error('Unexpected plugin Action.');
    if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) return listed ? { [snapshot.connectionId]: snapshot } : {};
    if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead) {
      reads += 1;
      return input.unreadable || !listed ? {} : { [snapshot.connectionId]: snapshot };
    }
    if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.observationIngest) { admissions.push(ConversationProviderObservationIngestInputV1Schema.parse(value)); return; }
    if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
      const report = ConversationTransportFactReportInputV1Schema.parse(value);
      if (input.failFacts && report.fact.kind === 'historyGap') throw new Error('Account is unavailable');
      facts.push(report);
      if (facts.at(-1)?.fact.kind === 'historyGap') listed = false; // The core owns whether history loss remains eligible.
      return { kind: 'recorded' };
    }
    throw new Error(`Unexpected Action ${action.localId}`);
  });
  // Host transport, credential materialization and logging are genuine external
  // boundaries. The worker, provider API, classifier and protocol stay real.
  const services = {
    actions: { execute },
    connectedAccounts: { async materialize() { return { kind: 'environment', env: { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test' } }; }, watch() { return { dispose() {} }; } },
    http: { async openWebSocket() { socketsOpened += 1; return socket; }, async request({ url }: Readonly<{ url: string }>) {
      const body = url.includes('auth.test') ? { ok: true, team_id: 'T1', user_id: 'U1', bot_id: 'B1' }
        : url.includes('bots.info') ? { ok: true, bot: { id: 'B1', user_id: 'U1', app_id: 'A1', name: 'Happier' } }
          : url.includes('conversations.info') ? { ok: true, channel: { id: 'C1', is_im: false, is_mpim: false, is_private: false, is_archived: false } }
            : { ok: true, url: 'wss://wss-primary.slack.com/link?ticket=fixture' };
      return { status: 200, finalUrl: url, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
    } },
    logger: { debug() {}, info() {}, warn() {}, error() {}, diagnostic() {} },
  } as unknown as PluginInvocationContext['services'];
  background = { plugin: { id: 'happier.channel.slack', version: '0.0.0' }, contribution: { id: SLACK_SOCKET_BACKGROUND_SERVICE_ID,
    qualifiedId: `happier.channel.slack/backgroundServices/${SLACK_SOCKET_BACKGROUND_SERVICE_ID}` },
    surface: 'background', invokedAtMs: 1700000000000, signal: controller.signal, services };
  const stopContext: PluginInvocationContext = { ...background, surface: 'plugin', caller: { kind: 'plugin', pluginId: 'happier.channels',
    occurrenceId: 'channels-generation-1', sourceCustody: { kind: 'managed', immutableGenerationId: 'channels-generation-1', installSource: 'npm' },
    contribution: { id: 'connection-stop-v1', qualifiedId: 'happier.channels/actions/connection-stop-v1' },
    materialization: { machineId: 'machine-1', materializationId: 'core-materialization', pluginId: 'happier.channels' } } };
  return { supervisor, background, stopContext, admissions, facts, controller, get reads() { return reads; }, get socketsOpened() { return socketsOpened; } };
}

describe('Slack socket supervisor through real target worker Action', () => {
  it('rereads authority, ingests, projects readiness and stops only the exact frozen old epoch', async () => {
    const h = harness();
    const running = h.supervisor.run(h.background);
    try {
      await vi.waitFor(() => expect(h.admissions).toHaveLength(1));
      expect(h.reads).toBeGreaterThan(0);
      await vi.waitFor(() => expect(h.facts).toContainEqual({ connectionId: 'connection-1', authorityEpoch: 7, fact: { kind: 'providerReadiness', status: 'ready' } }));
      const stopInput = { v: 1, connectionId: snapshot.connectionId, providerConnectionKey: snapshot.providerConnectionKey,
        providerConfigVersion: 1, providerConfig: snapshot.providerConfig, credentialRef, authorityEpoch: 8, reason: 'disable' };
      await expect(h.supervisor.stop({ ...stopInput, authorityEpoch: 9 }, h.stopContext)).resolves.toMatchObject({ kind: 'notReady' });
      await expect(h.supervisor.stop(stopInput, h.stopContext)).resolves.toEqual({ kind: 'stopped' });
    } finally { h.controller.abort(); await h.supervisor.dispose(); await running; }
  });

  it('never materializes or opens a worker from a list snapshot with an unreadable current authority', async () => {
    const h = harness({ unreadable: true });
    const running = h.supervisor.run(h.background);
    try {
      await vi.waitFor(() => expect(h.reads).toBeGreaterThan(0));
      expect(h.socketsOpened).toBe(0);
      expect(h.admissions).toEqual([]);
    } finally { h.controller.abort(); await h.supervisor.dispose(); await running; }
  });

  it('reports native refresh loss through core and honors its resulting eligibility on reconnect', async () => {
    const h = harness({ disconnect: true });
    const running = h.supervisor.run(h.background);
    try {
      await vi.waitFor(() => expect(h.facts).toContainEqual({ connectionId: 'connection-1', authorityEpoch: 7,
        fact: { kind: 'historyGap', reason: 'providerHistoryUnavailable' } }));
      expect(h.socketsOpened).toBe(1);
    } finally { h.controller.abort(); await h.supervisor.dispose(); await running; }
  });

  it('retains a failed history-gap report and does not reconnect around unavailable core custody', async () => {
    vi.useFakeTimers();
    const h = harness({ disconnect: true, failFacts: true });
    const running = h.supervisor.run(h.background);
    try {
      await vi.waitFor(() => expect(h.admissions).toHaveLength(1));
      await vi.waitFor(() => expect(h.reads).toBeGreaterThan(1));
      const reads = h.reads;
      // Cross the existing 30-second repair deadline: an initial worker retry
      // delay alone must not masquerade as retained gap-custody protection.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.reads).toBeGreaterThan(reads);
      expect(h.socketsOpened).toBe(1);
      expect(h.facts.some(report => report.fact.kind === 'historyGap')).toBe(false);
    } finally { h.controller.abort(); await h.supervisor.dispose(); await running; vi.useRealTimers(); }
  });
});
