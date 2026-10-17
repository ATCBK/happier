import { describe, expect, it } from 'vitest';

import {
  buildChannelsConversationIndex,
  channelsStatusNeedsYou,
  connectionStatus,
  readChannelsPageLocation,
  parseBinding,
  type ChannelsConnection,
} from './conversationRows.js';

describe('readChannelsPageLocation', () => {
  it('reads the link journey, optionally on one named bot (a session tab\'s "+" picks the bot first)', () => {
    expect(readChannelsPageLocation('link')).toEqual({ step: 'link' });
    expect(readChannelsPageLocation('link/connection-1')).toEqual({ step: 'link', connectionId: 'connection-1' });
    expect(readChannelsPageLocation('binding-1/edit')).toEqual({ bindingId: 'binding-1', step: 'edit' });
    expect(readChannelsPageLocation('binding-1')).toEqual({ bindingId: 'binding-1' });
  });
});

const t = (_key: string, fallback: string): string => fallback;

it('preserves router and child relations from the binding Resource without treating routers as sessions or automations', () => {
  const row = { bindingId: 'router-1', revision: 1, connectionId: 'connection-1', endpoint: { audience: 'direct' },
    target: { kind: 'threadRouter', summary: 'threadRouter' }, inputMode: 'allAllowedMessages', deliveryMode: 'none', approval: { kind: 'notApplicable' }, enabled: true, deletionState: 'none' };
  expect(parseBinding(row)).toEqual(row);
  const child = { ...row, bindingId: 'child-1', parentBindingId: 'router-1', target: { kind: 'session', summary: 'session-1' }, deliveryMode: 'repliesOnly', approval: { kind: 'off' } };
  expect(parseBinding(child)).toEqual(child);
  expect(parseBinding({ ...row, deliveryMode: 'finalResult' })).toBeUndefined();
});

function connection(attention: Partial<ChannelsConnection['attention']> = {}): ChannelsConnection {
  return {
    connectionId: 'connection-1',
    revision: 1,
    authorityEpoch: 1,
    providerPluginId: 'happier.telegram',
    selectedMachineId: 'machine-1',
    selectedTransport: 'socket',
    enabled: true,
    deletionState: 'none',
    maximumObservationAgeMs: 120_000,
    attention: {
      historyGap: null,
      providerReadiness: null,
      ingressConflict: null,
      pollFailure: null,
      bestEffortBeforeDurableAdmission: false,
      oldTransportStopUnconfirmed: false,
      endpointRetargetOwed: false,
      acceptedPossibleLoss: false,
      outwardDelivery: { retryDue: false, notDelivered: false, partial: false, outcomeUnknown: false, archiveRecovery: false },
      ...attention,
    },
  };
}

const DELIVERY = connection().attention.outwardDelivery;

describe('connectionStatus', () => {
  it('says nothing for a healthy bot, asks for you in the attention tone, and keeps rose for failure', () => {
    expect(connectionStatus(connection(), t).tone).toBe('secondary');
    expect(connectionStatus(connection({ providerReadiness: { code: 'providerCredentialInvalid' } }), t).tone).toBe('attention');
    expect(connectionStatus(connection({ oldTransportStopUnconfirmed: true, endpointRetargetOwed: true }), t).tone).toBe('attention');
    expect(connectionStatus(connection({ outwardDelivery: { ...DELIVERY, notDelivered: true } }), t).tone).toBe('attention');
    expect(connectionStatus(connection({ outwardDelivery: { ...DELIVERY, outcomeUnknown: true } }), t).tone).toBe('danger');
    // A retry the system owns is a caution, not a request of the reader.
    expect(connectionStatus(connection({ outwardDelivery: { ...DELIVERY, retryDue: true } }), t).tone).toBe('warning');
  });

  it('treats needs-you, caution and failure as needing a look, and a quiet state as not', () => {
    expect(channelsStatusNeedsYou('attention')).toBe(true);
    expect(channelsStatusNeedsYou('warning')).toBe(true);
    expect(channelsStatusNeedsYou('danger')).toBe(true);
    expect(channelsStatusNeedsYou('secondary')).toBe(false);
    expect(channelsStatusNeedsYou('neutral')).toBe(false);
  });
});

it('lists a router once in the conversation index and leaves its threads to the router page', () => {
  const router = parseBinding({ bindingId: 'router-1', revision: 1, connectionId: 'connection-1', endpoint: { audience: 'direct', label: 'wilson@batiplus.ch' },
    target: { kind: 'threadRouter', summary: 'threadRouter' }, inputMode: 'allAllowedMessages', deliveryMode: 'none', approval: { kind: 'notApplicable' }, enabled: true, deletionState: 'none' });
  const thread = parseBinding({ bindingId: 'thread-1', parentBindingId: 'router-1', revision: 1, connectionId: 'connection-1', endpoint: { audience: 'shared', label: 'Devis' },
    target: { kind: 'session', summary: 'session-1' }, inputMode: 'allAllowedMessages', deliveryMode: 'repliesOnly', approval: { kind: 'off' }, enabled: true, deletionState: 'none' });
  const orphan = parseBinding({ bindingId: 'thread-2', parentBindingId: 'router-gone', revision: 1, connectionId: 'connection-1', endpoint: { audience: 'shared', label: 'Orphan' },
    target: { kind: 'session', summary: 'session-2' }, inputMode: 'allAllowedMessages', deliveryMode: 'repliesOnly', approval: { kind: 'off' }, enabled: true, deletionState: 'none' });
  if (router === undefined || thread === undefined || orphan === undefined) throw new Error('fixture rows must parse');
  const groups = buildChannelsConversationIndex({ bindings: [router, thread, orphan], connections: [], providerName: (id) => id, t });
  expect(groups.flatMap((group) => group.rows.map((row) => row.binding.bindingId)).sort()).toEqual(['router-1', 'thread-2']);
});

it('says a bot needs you once per group, in the same words whatever its cause', () => {
  const row = parseBinding({ bindingId: 'binding-1', revision: 1, connectionId: 'connection-1', endpoint: { audience: 'shared', label: 'Ops' },
    target: { kind: 'session', summary: 'session-1' }, inputMode: 'allAllowedMessages', deliveryMode: 'repliesOnly', approval: { kind: 'off' }, enabled: true, deletionState: 'none' });
  if (row === undefined) throw new Error('fixture row must parse');
  const labelFor = (attention: Partial<ChannelsConnection['attention']>) => buildChannelsConversationIndex({
    bindings: [row], connections: [connection(attention)], providerName: (id) => id, t,
  })[0]?.botAttention?.label;
  const polling = labelFor({ pollFailure: { phase: 'blocked', attemptCount: 1, retryNotBeforeMs: null, evidence: { kind: 'provider', reason: 'providerConflict' } } });
  const credential = labelFor({ providerReadiness: { code: 'providerCredentialInvalid' } });
  expect(polling).toBe('Bot needs you');
  expect(credential).toBe(polling);
  expect(labelFor({})).toBeUndefined();
});
