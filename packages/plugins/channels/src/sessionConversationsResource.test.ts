import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import { ComposerControlStateV1Schema } from '@happier-dev/plugin-sdk/ui';
import { PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 } from '@happier-dev/plugin-sdk/collections';
import { describe, expect, it, vi } from 'vitest';

import {
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import {
  createConversationOutwardDeliveryCollectionStore,
  type ConversationOutwardDeliveryObligation,
} from './outwardDelivery.js';
import {
  SESSION_CONVERSATIONS_ATTENTION_CONTROL_STATE_RESOURCE_RUNTIME,
  SESSION_CONVERSATIONS_CONTROL_STATE_RESOURCE_RUNTIME,
  SESSION_CONVERSATIONS_RESOURCE_RUNTIME,
} from './sessionConversationsResource.js';
import { SESSION_INFO_RESOURCE_RUNTIME } from './sessionInfoResource.js';
import { createConversationSessionProjectionFrontierRow } from './sessionProjection.js';
import { assertChannelsTestCollectionQueryLimit } from './testkit/collectionQueryBound.js';
import {
  createCurrentConversationConnectionFixture,
  type ConversationConnectionFixtureAuthority,
} from './testkit/currentConnectionFixture.js';
import { resourceText } from './testkit/resourceContract.js';
import type { ConversationDeliveryCustodyState } from './deliveryCustody.js';

class MemoryAccountCollection {
  readonly rows = new Map<string, Readonly<{
    rowId: string;
    revision: number;
    value: Record<string, unknown>;
  }>>();

  async get(rowId: string) {
    return this.rows.get(rowId) ?? null;
  }

  async put(value: Record<string, unknown>, input: Readonly<{
    expectedRevision: number | 'absent';
  }>) {
    const rowId = value.id;
    if (typeof rowId !== 'string') throw new Error('row id is required');
    const current = this.rows.get(rowId);
    if ((input.expectedRevision === 'absent' && current !== undefined)
      || (typeof input.expectedRevision === 'number'
        && (current === undefined || current.revision !== input.expectedRevision))) {
      throw new Error('conflict');
    }
    const row = { rowId, revision: (current?.revision ?? 0) + 1, value };
    this.rows.set(rowId, row);
    return row;
  }

  async query(request: Readonly<{
    index?: string;
    prefix?: readonly string[];
    cursor?: string;
    limit?: number;
  }>) {
    assertChannelsTestCollectionQueryLimit(request.limit);
    const matching = [...this.rows.values()]
      .filter((row) => {
        if (request.index === 'by-kind') {
          return row.value['record-kind'] === request.prefix?.[0];
        }
        if (request.index === 'by-owner-attention') {
          return row.value['connection-id'] === request.prefix?.[0]
            && row.value['binding-id'] === request.prefix?.[1];
        }
        if (request.index === 'by-connection-binding-v2') {
          return row.value['connection-id'] === request.prefix?.[0]
            && (row.value['binding-id'] ?? null) === (request.prefix?.[1] ?? null)
            && row.value['record-kind'] === request.prefix?.[2]
            && row.value.attention === request.prefix?.[3];
        }
        return true;
      })
      .sort((left, right) => left.rowId.localeCompare(right.rowId));
    const start = request.cursor === undefined
      ? 0
      : matching.findIndex((row) => row.rowId === request.cursor) + 1;
    const limit = request.limit ?? matching.length;
    const rows = matching.slice(Math.max(0, start), Math.max(0, start) + limit);
    const next = matching[Math.max(0, start) + limit];
    return {
      rows,
      ...(next === undefined ? {} : { nextCursor: rows.at(-1)?.rowId }),
      changeCursor: 1,
    };
  }
}

class WatchableMemoryAccountCollection extends MemoryAccountCollection {
  private readonly listeners = new Set<() => void>();

  override async put(value: Record<string, unknown>, input: Readonly<{
    expectedRevision: number | 'absent';
  }>) {
    const row = await super.put(value, input);
    for (const listener of [...this.listeners]) listener();
    return row;
  }

  watch(_request: unknown, next: () => void) {
    this.listeners.add(next);
    return {
      dispose: () => {
        this.listeners.delete(next);
      },
    };
  }
}

function sessionBindingRecord(bindingId: string, sessionId: string): Record<string, unknown> {
  return {
    id: bindingId,
    'record-kind': 'binding',
    v: 1,
    'connection-id': 'connection-1',
    'binding-id': bindingId,
    'created-at': 1,
    'updated-at': 1,
    payload: {
      endpoint: { kind: 'shared', audience: 'shared', id: 'endpoint-private' },
      target: {
        kind: 'session',
        sessionId,
        policy: {
          deliveryMode: 'mirrorSession',
          permissionCeiling: 'yolo',
          approvals: { kind: 'enabled', maximumScope: 'session', principalIds: ['principal-private'] },
          newSession: { kind: 'enabled', principalIds: ['principal-private'], recipe: { secret: 'recipe-private' } },
        },
      },
      allowedPrincipalIds: ['principal-private'],
      allowBotSenders: true,
      inputMode: 'addressedMessages',
      inboundDebounceMs: 4_000,
      linkPreviewPolicy: 'providerDefault',
      senderFeedback: 'eligibleRefusals',
      authorityEpoch: 7,
      enabled: true,
      deletionState: 'none',
    },
  };
}

function bindingDeliveryObligation(
  bindingId: string,
  controlId: string,
): ConversationOutwardDeliveryObligation {
  return {
    connectionId: 'connection-1',
    bindingId,
    routeAuthority: {
      connectionAuthorityEpoch: 4,
      bindingRevision: 1,
      bindingAuthorityEpoch: 7,
    },
    source: { kind: 'controlResponse', controlId, controlKind: 'recovery' },
    endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' },
    content: { text: `Private delivery body for ${controlId}.` },
    deliveryKey: `delivery:${controlId}`,
    mentionPolicy: 'suppress',
    linkPreviewPolicy: 'suppress',
  };
}

const CONNECTION_AUTHORITY = {
  providerPluginId: 'example.channel.provider',
  providerContributionSelection: {
    contributionId: 'session-conversations-test-provider',
  },
  providerSetupInput: { source: 'session-conversations-resource-test' },
  credentialRef: null,
  transportOrigin: {
    serverIdentityId: 'srv_account_one',
    materializationRef: {
      pluginId: 'example.channel.provider',
      machineId: 'machine-1',
      materializationId: 'materialization-1',
    },
  },
  providerConnectionKey: 'provider-connection-1',
  providerConfig: { account: 'private' },
  routingIdentityKey: 'a'.repeat(43),
  integrationPrincipal: { id: 'session-conversations-principal' },
  authorityEpoch: 4,
} as const satisfies ConversationConnectionFixtureAuthority;

function accountStorageFor(state: unknown, deliveries: unknown): PluginAccountStorageScope {
  return {
    collection(definition: Readonly<{ id: string }>) {
      return definition.id === CHANNEL_STATE_COLLECTION.id ? state : deliveries;
    },
  } as unknown as PluginAccountStorageScope;
}

function createWatchableCollection() {
  const listeners = new Set<() => void>();
  const dispose = vi.fn();
  return {
    watch: vi.fn((_request: unknown, next: () => void) => {
      listeners.add(next);
      return {
        dispose() {
          listeners.delete(next);
          dispose();
        },
      };
    }),
    emit() {
      for (const listener of [...listeners]) listener();
    },
    emitWatch(index: number) {
      [...listeners][index]?.();
    },
    dispose,
  };
}

async function seedBoundSession(): Promise<Readonly<{
  state: MemoryAccountCollection;
  deliveries: MemoryAccountCollection;
}>> {
  const state = new WatchableMemoryAccountCollection();
  const deliveries = new WatchableMemoryAccountCollection();
  await state.put(createCurrentConversationConnectionFixture({
    connectionId: 'connection-1',
    authority: CONNECTION_AUTHORITY,
    transport: { kind: 'checkpointedPull' },
    overlapSafety: 'safe',
    replayContinuity: 'checkpointed',
    outboundTextLimit: { maximum: 4_096, unit: 'unicodeCodePoints' },
  }), { expectedRevision: 'absent' });
  await state.put(sessionBindingRecord('binding-a', 'session-a'), { expectedRevision: 'absent' });
  await state.put(sessionBindingRecord('binding-b', 'session-b'), { expectedRevision: 'absent' });
  return { state, deliveries };
}

async function readControlStates(
  state: MemoryAccountCollection,
  deliveries: MemoryAccountCollection,
  sessionId: string,
): Promise<Readonly<{ chip: unknown; attention: unknown }>> {
  const options = {
    signal: new AbortController().signal,
    context: { kind: 'session' as const, sessionId },
    accountStorage: accountStorageFor(state, deliveries),
  };
  return {
    chip: ComposerControlStateV1Schema.parse(JSON.parse(resourceText(
      await SESSION_CONVERSATIONS_CONTROL_STATE_RESOURCE_RUNTIME.read(options),
    ))),
    attention: ComposerControlStateV1Schema.parse(JSON.parse(resourceText(
      await SESSION_CONVERSATIONS_ATTENTION_CONTROL_STATE_RESOURCE_RUNTIME.read(options),
    ))),
  };
}

describe('Channels Session conversations Composer control state', () => {
  it('hides both chips for a Session that no Channel binding targets', async () => {
    const { state, deliveries } = await seedBoundSession();

    expect(await readControlStates(state, deliveries, 'session-unbound')).toEqual({
      chip: { visible: false, count: 0 },
      attention: { visible: false, count: 0 },
    });
  });

  it('shows only the connected-conversation chip while this Session\'s deliveries are healthy', async () => {
    const { state, deliveries } = await seedBoundSession();

    expect(await readControlStates(state, deliveries, 'session-a')).toEqual({
      chip: { visible: true, count: 1 },
      attention: { visible: false, count: 1 },
    });
  });

  it('swaps to the attention chip only for the Session whose own delivery custody failed', async () => {
    const { state, deliveries } = await seedBoundSession();
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: new AbortController().signal,
      now: () => 100,
    });
    const created = await store.ensure(bindingDeliveryObligation('binding-b', 'session-b'));
    if (created.kind !== 'created') throw new Error('Expected a canonical custody row.');
    const failed = await store.compareAndSwap({
      custodyId: created.record.custodyId,
      expectedRevision: created.record.revision,
      custody: { state: 'partial', attemptCount: 1, providerMessageIds: ['provider-private'], failedChunk: 1 },
    });
    if (failed.kind !== 'updated') throw new Error('Expected a canonical custody state update.');

    // The failed delivery belongs to `session-b`; `session-a` must stay healthy.
    expect(await readControlStates(state, deliveries, 'session-b')).toEqual({
      chip: { visible: false, count: 1 },
      attention: { visible: true, count: 1 },
    });
    expect(await readControlStates(state, deliveries, 'session-a')).toEqual({
      chip: { visible: true, count: 1 },
      attention: { visible: false, count: 1 },
    });
  });

  it('publishes no external conversation content, principal, or foreign Session identity', async () => {
    const { state, deliveries } = await seedBoundSession();
    const serialized = await SESSION_CONVERSATIONS_CONTROL_STATE_RESOURCE_RUNTIME.read({
      signal: new AbortController().signal,
      context: { kind: 'session', sessionId: 'session-a' },
      accountStorage: accountStorageFor(state, deliveries),
    });

    expect(resourceText(serialized)).toBe('{"visible":true,"count":1}');
  });

  it('requires a host-stamped Session context and invalidates only through existing Collections', () => {
    const state = createWatchableCollection();
    const deliveries = createWatchableCollection();
    const accountStorage = accountStorageFor(state, deliveries);
    const invalidate = vi.fn();

    for (const runtime of [
      SESSION_CONVERSATIONS_CONTROL_STATE_RESOURCE_RUNTIME,
      SESSION_CONVERSATIONS_ATTENTION_CONTROL_STATE_RESOURCE_RUNTIME,
    ]) {
      expect(() => runtime.observe(invalidate, {
        signal: new AbortController().signal,
        context: { kind: 'global' },
        accountStorage,
      })).toThrow(expect.objectContaining({
        code: 'channels_session_conversations_resource_session_context_required',
      }));
    }

    const observation = SESSION_CONVERSATIONS_CONTROL_STATE_RESOURCE_RUNTIME.observe(invalidate, {
      signal: new AbortController().signal,
      context: { kind: 'session', sessionId: 'session-a' },
      accountStorage,
    });
    state.emit();
    deliveries.emit();
    expect(invalidate).toHaveBeenCalledTimes(4);
    expect(state.watch).toHaveBeenNthCalledWith(1, {
      index: 'by-kind',
      prefix: [CHANNEL_STATE_RECORD_KIND.binding],
      order: 'asc',
    }, expect.any(Function));
    expect(state.watch).toHaveBeenNthCalledWith(2, {
      index: 'by-kind',
      prefix: [CHANNEL_STATE_RECORD_KIND.connection],
      order: 'asc',
    }, expect.any(Function));
    expect(state.watch).toHaveBeenNthCalledWith(3, {
      index: 'by-kind',
      prefix: [CHANNEL_STATE_RECORD_KIND.projectionFrontier],
      order: 'asc',
    }, expect.any(Function));
    expect(deliveries.watch).toHaveBeenCalledWith({ kind: 'collection' }, expect.any(Function));

    observation.dispose();
    state.emit();
    deliveries.emit();
    expect(invalidate).toHaveBeenCalledTimes(4);
    expect(state.dispose).toHaveBeenCalledTimes(3);
    expect(deliveries.dispose).toHaveBeenCalledOnce();
  });

  it('refuses the Composer control state when Account storage was not admitted', async () => {
    await expect(SESSION_CONVERSATIONS_CONTROL_STATE_RESOURCE_RUNTIME.read({
      signal: new AbortController().signal,
      context: { kind: 'session', sessionId: 'session-a' },
    })).rejects.toMatchObject({
      code: 'channels_session_conversations_resource_account_storage_unavailable',
    });
  });
});

describe('Channels Session conversations Resource', () => {
  it('selects the latest custody across every page of the retained binding index', async () => {
    const { state, deliveries } = await seedBoundSession();
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: new AbortController().signal,
      now: () => 100,
    });
    const created = await store.ensure(bindingDeliveryObligation('binding-a', 'paged'));
    if (created.kind !== 'created') throw new Error('Expected canonical custody.');
    const template = deliveries.rows.get(created.record.custodyId);
    if (template === undefined) throw new Error('Expected retained collection row.');
    for (let index = 0; index <= PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1; index += 1) {
      const rowId = `z${index.toString().padStart(42, '0')}`;
      deliveries.rows.set(rowId, {
        rowId,
        revision: 1,
        value: { ...template.value, id: rowId, 'updated-at': 200 + index },
      });
    }
    const result = JSON.parse(resourceText(await SESSION_CONVERSATIONS_RESOURCE_RUNTIME.read({
      signal: new AbortController().signal,
      context: { kind: 'session', sessionId: 'session-a' },
      accountStorage: accountStorageFor(state, deliveries),
    }))) as Readonly<{ lastDeliveries?: unknown }>;
    expect(result.lastDeliveries).toEqual([{
      bindingId: 'binding-a', atMs: 200 + PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1, outcome: 'pending',
    }]);
  });

  it('refuses a last-delivery claim when the retained custody timestamp is unreadable', async () => {
    const { state, deliveries } = await seedBoundSession();
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: new AbortController().signal,
      now: () => 100,
    });
    const created = await store.ensure(bindingDeliveryObligation('binding-a', 'corrupt'));
    if (created.kind !== 'created') throw new Error('Expected canonical custody.');
    const row = deliveries.rows.get(created.record.custodyId);
    if (row === undefined) throw new Error('Expected retained collection row.');
    deliveries.rows.set(row.rowId, { ...row, value: { ...row.value, 'updated-at': 'unreadable' } });
    await expect(SESSION_CONVERSATIONS_RESOURCE_RUNTIME.read({
      signal: new AbortController().signal,
      context: { kind: 'session', sessionId: 'session-a' },
      accountStorage: accountStorageFor(state, deliveries),
    })).rejects.toMatchObject({ code: 'channels_session_conversations_resource_delivery_row_invalid' });
  });

  it('rereads the mounted list after canonical delivery custody settles', async () => {
    const { state, deliveries } = await seedBoundSession();
    let now = 100;
    const options = {
      signal: new AbortController().signal,
      context: { kind: 'session' as const, sessionId: 'session-a' },
      accountStorage: accountStorageFor(state, deliveries),
    };
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: options.signal,
      now: () => now,
    });
    const created = await store.ensure(bindingDeliveryObligation('binding-a', 'mounted'));
    if (created.kind !== 'created') throw new Error('Expected canonical custody.');
    let refreshed: Promise<unknown> | undefined;
    const observation = SESSION_CONVERSATIONS_RESOURCE_RUNTIME.observe(() => {
      refreshed = Promise.resolve(SESSION_CONVERSATIONS_RESOURCE_RUNTIME.read(options)).then((result) => (
        (JSON.parse(resourceText(result)) as Readonly<{ lastDeliveries?: unknown }>).lastDeliveries
      ));
    }, options);
    now = 200;
    await store.compareAndSwap({
      custodyId: created.record.custodyId,
      expectedRevision: created.record.revision,
      custody: { state: 'delivered', attemptCount: 1, providerMessageIds: ['provider-private'] },
    });
    expect(refreshed).toBeDefined();
    await expect(refreshed).resolves.toEqual([{ bindingId: 'binding-a', atMs: 200, outcome: 'delivered' }]);
    observation.dispose();
  });

  it.each([
    ['ready', 'pending'],
    ['retryDue', 'pending'],
    ['attempting', 'pending'],
    ['delivered', 'delivered'],
    ['notDelivered', 'notDelivered'],
    ['suppressed', 'notDelivered'],
    ['connectionDeleted', 'notDelivered'],
    ['partial', 'unknown'],
    ['outcomeUnknown', 'unknown'],
    ['resolvedAccepted', 'unknown'],
    ['resolvedDiscarded', 'unknown'],
  ] as const satisfies readonly (readonly [ConversationDeliveryCustodyState, string])[])(
    'projects the latest retained %s custody as %s without leaking delivery content',
    async (custodyState, outcome) => {
      const { state, deliveries } = await seedBoundSession();
      let now = 100;
      const store = createConversationOutwardDeliveryCollectionStore({
        stateCollection: state as never,
        deliveriesCollection: deliveries as never,
        signal: new AbortController().signal,
        now: () => now,
      });
      const older = await store.ensure(bindingDeliveryObligation('binding-a', 'older'));
      now = 200;
      await store.ensure(bindingDeliveryObligation('binding-a', 'newer-created'));
      await store.ensure(bindingDeliveryObligation('binding-b', 'foreign-session'));
      if (older.kind !== 'created') throw new Error('Expected canonical custody.');
      now = 300;
      const changed = await store.compareAndSwap({
        custodyId: older.record.custodyId,
        expectedRevision: older.record.revision,
        custody: {
          state: custodyState,
          attemptCount: custodyState === 'ready' ? 0 : 1,
          providerMessageIds: [],
          ...(custodyState === 'attempting' ? { attemptId: 'attempt-private', startedAt: 250 } : {}),
          ...(custodyState === 'partial' ? { failedChunk: 1 } : {}),
        },
      });
      if (changed.kind !== 'updated') throw new Error('Expected canonical custody update.');
      const serialized = resourceText(await SESSION_CONVERSATIONS_RESOURCE_RUNTIME.read({
        signal: new AbortController().signal,
        context: { kind: 'session', sessionId: 'session-a' },
        accountStorage: accountStorageFor(state, deliveries),
      }));
      const projection = JSON.parse(serialized) as Readonly<{ lastDeliveries?: unknown }>;
      expect(projection.lastDeliveries).toEqual([{ bindingId: 'binding-a', atMs: 300, outcome }]);
      expect(serialized).not.toContain('Private delivery body');
      expect(serialized).not.toContain('attempt-private');
      expect(serialized).not.toContain('binding-b');
    },
  );
  it('projects the current Session conversation counts through the shared declarative grammar', async () => {
    const { state, deliveries } = await seedBoundSession();

    const serialized = await SESSION_INFO_RESOURCE_RUNTIME.read({
      signal: new AbortController().signal,
      context: { kind: 'session', sessionId: 'session-a' },
      accountStorage: accountStorageFor(state, deliveries),
    });

    expect(JSON.parse(resourceText(serialized))).toEqual({
      version: 1,
      root: {
        kind: 'group',
        title: { key: 'plugins.channels.session.title', fallback: 'External conversations' },
        description: { key: 'plugins.channels.session.emptyDescription', fallback: 'Conversations bound to this Session will appear here.' },
        children: [
          { kind: 'status', label: { key: 'plugins.channels.session.title', fallback: 'External conversations' }, value: '1' },
          { kind: 'status', label: { key: 'plugins.channels.session.composerChipAttention', fallback: 'External delivery needs attention' }, value: '0' },
        ],
      },
    });
  });

  it('publishes only the bindings whose canonical target is exactly this Session', async () => {
    const { state, deliveries } = await seedBoundSession();

    const serialized = await SESSION_CONVERSATIONS_RESOURCE_RUNTIME.read({
      signal: new AbortController().signal,
      context: { kind: 'session', sessionId: 'session-a' },
      accountStorage: accountStorageFor(state, deliveries),
    });

    expect(JSON.parse(resourceText(serialized))).toEqual({
      bindings: [{
        bindingId: 'binding-a',
        revision: 1,
        connectionId: 'connection-1',
        endpoint: { audience: 'shared' },
        target: { kind: 'session', summary: 'session-a' },
        inputMode: 'addressedMessages',
        deliveryMode: 'mirrorSession',
        approval: { kind: 'enabled', maximumScope: 'session' },
        enabled: true,
        deletionState: 'none',
      }],
      attention: [],
    });
    expect(resourceText(serialized)).not.toContain('session-b');
    expect(resourceText(serialized)).not.toContain('principal-private');
    expect(resourceText(serialized)).not.toContain('recipe-private');
  });

  it('names the exact conversation and reason when its connection lost provider authority', async () => {
    // Delivery custody is healthy here. The owner still has to act, and the
    // Session surfaces must say which conversation and why — otherwise the
    // Composer chip is either silent or a dead end.
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    await state.put(createCurrentConversationConnectionFixture({
      connectionId: 'connection-1',
      authority: CONNECTION_AUTHORITY,
      providerReadiness: { code: 'providerCredentialInvalid' },
    }), { expectedRevision: 'absent' });
    await state.put(sessionBindingRecord('binding-a', 'session-a'), { expectedRevision: 'absent' });

    const serialized = await SESSION_CONVERSATIONS_RESOURCE_RUNTIME.read({
      signal: new AbortController().signal,
      context: { kind: 'session', sessionId: 'session-a' },
      accountStorage: accountStorageFor(state, deliveries),
    });
    expect((JSON.parse(resourceText(serialized)) as Readonly<{ attention: unknown }>).attention).toEqual([
      { bindingId: 'binding-a', reason: 'providerCredentialInvalid' },
    ]);

    const states = await readControlStates(state, deliveries, 'session-a');
    expect(states.attention).toEqual({ visible: true, count: 1 });
    expect(states.chip).toEqual({ visible: false, count: 1 });
  });

  it('reports a paused binding as attention rather than a healthy conversation', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    await state.put(createCurrentConversationConnectionFixture({
      connectionId: 'connection-1',
      authority: CONNECTION_AUTHORITY,
    }), { expectedRevision: 'absent' });
    const paused = sessionBindingRecord('binding-a', 'session-a');
    await state.put({
      ...paused,
      payload: { ...(paused.payload as Record<string, unknown>), enabled: false },
    }, { expectedRevision: 'absent' });

    const serialized = await SESSION_CONVERSATIONS_RESOURCE_RUNTIME.read({
      signal: new AbortController().signal,
      context: { kind: 'session', sessionId: 'session-a' },
      accountStorage: accountStorageFor(state, deliveries),
    });
    expect((JSON.parse(resourceText(serialized)) as Readonly<{ attention: unknown }>).attention).toEqual([
      { bindingId: 'binding-a', reason: 'bindingDisabled' },
    ]);
    const states = await readControlStates(state, deliveries, 'session-a');
    expect(states.attention).toEqual({ visible: true, count: 1 });
  });

  it('projects one paused transcript frontier with the exact recovery revisions', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    await state.put(createCurrentConversationConnectionFixture({
      connectionId: 'connection-1',
      authority: CONNECTION_AUTHORITY,
    }), { expectedRevision: 'absent' });
    await state.put(sessionBindingRecord('binding-a', 'session-a'), { expectedRevision: 'absent' });
    await state.put(createConversationSessionProjectionFrontierRow({
      bindingId: 'binding-a',
      targetSessionId: 'session-a',
      transcriptCursor: { kind: 'historyGap', reason: 'cursorRejected', reportedAt: 100 },
      lastScannedSeq: 7,
      revision: 3,
      now: 100,
    }), { expectedRevision: 'absent' });

    const serialized = await SESSION_CONVERSATIONS_RESOURCE_RUNTIME.read({
      signal: new AbortController().signal,
      context: { kind: 'session', sessionId: 'session-a' },
      accountStorage: accountStorageFor(state, deliveries),
    });
    expect((JSON.parse(resourceText(serialized)) as Readonly<{ attention: unknown }>).attention).toEqual([
      {
        bindingId: 'binding-a',
        reason: 'transcriptHistoryGap',
        bindingRevision: 1,
        frontierRevision: 1,
      },
    ]);
  });

  it('matches a Session identity longer than the display summary bound instead of its truncation', async () => {
    // `target.summary` is a 28-code-point display projection. Two Sessions that
    // share the first 27 code points collapse onto the same summary, so a
    // summary-matched projection would publish the wrong Session's conversation.
    const longSessionId = `session-${'x'.repeat(40)}`;
    const siblingSessionId = `${longSessionId}-sibling`;
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    await state.put(sessionBindingRecord('binding-long', longSessionId), { expectedRevision: 'absent' });
    await state.put(sessionBindingRecord('binding-sibling', siblingSessionId), { expectedRevision: 'absent' });

    const serialized = await SESSION_CONVERSATIONS_RESOURCE_RUNTIME.read({
      signal: new AbortController().signal,
      context: { kind: 'session', sessionId: longSessionId },
      accountStorage: accountStorageFor(state, deliveries),
    });
    const parsed = JSON.parse(resourceText(serialized)) as Readonly<{
      bindings: readonly Readonly<{ bindingId: string }>[];
    }>;

    expect(parsed.bindings.map(({ bindingId }) => bindingId)).toEqual(['binding-long']);
  });

  it('invalidates the Session list when binding, connection, or delivery custody changes', () => {
    const state = createWatchableCollection();
    const deliveries = createWatchableCollection();
    const invalidate = vi.fn();

    const observation = SESSION_CONVERSATIONS_RESOURCE_RUNTIME.observe(invalidate, {
      signal: new AbortController().signal,
      context: { kind: 'session', sessionId: 'session-a' },
      accountStorage: accountStorageFor(state, deliveries),
    });

    expect(deliveries.watch).toHaveBeenCalledWith({ kind: 'collection' }, expect.any(Function));
    expect(state.watch).toHaveBeenNthCalledWith(1, {
      index: 'by-kind',
      prefix: [CHANNEL_STATE_RECORD_KIND.binding],
      order: 'asc',
    }, expect.any(Function));
    expect(state.watch).toHaveBeenNthCalledWith(2, {
      index: 'by-kind',
      prefix: [CHANNEL_STATE_RECORD_KIND.connection],
      order: 'asc',
    }, expect.any(Function));
    expect(state.watch).toHaveBeenNthCalledWith(3, {
      index: 'by-kind',
      prefix: [CHANNEL_STATE_RECORD_KIND.projectionFrontier],
      order: 'asc',
    }, expect.any(Function));
    state.emitWatch(0);
    expect(invalidate).toHaveBeenCalledTimes(1);
    state.emitWatch(1);
    expect(invalidate).toHaveBeenCalledTimes(2);
    deliveries.emit();
    expect(invalidate).toHaveBeenCalledTimes(3);
    observation.dispose();
    expect(state.dispose).toHaveBeenCalledTimes(3);
    expect(deliveries.dispose).toHaveBeenCalledOnce();
    deliveries.emit();
    expect(invalidate).toHaveBeenCalledTimes(3);
  });

  it('rereads the mounted Session projection after a connection-only state change', async () => {
    const state = new WatchableMemoryAccountCollection();
    const deliveries = new WatchableMemoryAccountCollection();
    const connection = await state.put(createCurrentConversationConnectionFixture({
      connectionId: 'connection-1',
      authority: CONNECTION_AUTHORITY,
      transport: { kind: 'checkpointedPull' },
      overlapSafety: 'safe',
      replayContinuity: 'checkpointed',
      outboundTextLimit: { maximum: 4_096, unit: 'unicodeCodePoints' },
    }), { expectedRevision: 'absent' });
    await state.put(sessionBindingRecord('binding-a', 'session-a'), { expectedRevision: 'absent' });
    const options = {
      signal: new AbortController().signal,
      context: { kind: 'session' as const, sessionId: 'session-a' },
      accountStorage: accountStorageFor(state, deliveries),
    };
    let refreshed: Promise<Readonly<{ attention: readonly unknown[] }>> | undefined;
    const observation = SESSION_CONVERSATIONS_RESOURCE_RUNTIME.observe(() => {
      refreshed = Promise.resolve(SESSION_CONVERSATIONS_RESOURCE_RUNTIME.read(options)).then((result) => (
        JSON.parse(resourceText(result)) as Readonly<{ attention: readonly unknown[] }>
      ));
    }, options);

    const currentValue = connection.value;
    await state.put({
      ...currentValue,
      'updated-at': 2,
      payload: {
        ...(currentValue.payload as Record<string, unknown>),
        enabled: false,
      },
    }, { expectedRevision: connection.revision });

    if (refreshed === undefined) {
      throw new Error('Expected the connection watch to refresh the mounted Session projection.');
    }
    await expect(refreshed).resolves.toEqual({
      bindings: expect.any(Array),
      attention: [{ bindingId: 'binding-a', reason: 'connectionDisabled' }],
    });
    observation.dispose();
  });
});
