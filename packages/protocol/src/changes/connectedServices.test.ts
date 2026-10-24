import { describe, expect, it } from 'vitest';

import { buildQualifiedPluginContributionKey } from '../plugins/contributionKey.js';
import { buildConnectedServicesAccountChangeV1, readConnectedServicesAccountChangeV1 } from './index.js';

describe('Connected Services Account changes', () => {
  const ref = { pluginId: 'happier.service.openai', localId: 'api-key' };

  it('keeps the qualified service in its own coalescing entity and reads the producer output', () => {
    const change = buildConnectedServicesAccountChangeV1(ref);
    expect(change).toEqual({ kind: 'account', entityId: `connected-service:${buildQualifiedPluginContributionKey(ref)}`,
      hint: { connectedServices: true, connectedServiceRef: ref } });
    expect(readConnectedServicesAccountChangeV1(change)).toEqual({ scope: 'service', ref });
    expect(readConnectedServicesAccountChangeV1({ kind: change.kind, entityId: change.entityId }))
      .toEqual({ scope: 'service', ref });
    expect(buildConnectedServicesAccountChangeV1({ ...ref, localId: 'oauth' }).entityId).not.toBe(change.entityId);
    expect(buildConnectedServicesAccountChangeV1({ pluginId: 'happier', localId: 'mcp-sign-in' }).hint)
      .toEqual({ connectedServices: true, connectedServiceRef: { pluginId: 'happier', localId: 'mcp-sign-in' } });
  });

  it('retains broad conversion and predecessor self hints as full invalidations', () => {
    expect(readConnectedServicesAccountChangeV1(buildConnectedServicesAccountChangeV1())).toEqual({ scope: 'all' });
    expect(readConnectedServicesAccountChangeV1({ kind: 'account', entityId: 'connected-services' })).toEqual({ scope: 'all' });
    // 0.2 publisher at 2bf968563bf2015455c0cd54bcc74e91f67891b9 emits this coarse hint.
    expect(readConnectedServicesAccountChangeV1({ kind: 'account', entityId: 'self', hint: { connectedServices: true } }))
      .toEqual({ scope: 'all' });
    expect(readConnectedServicesAccountChangeV1({ kind: 'account', entityId: 'self', hint: { settingsVersion: 3 } }))
      .toBeNull();
  });

  it('rejects mismatched identities, malformed routing hints and unrelated entities', () => {
    const change = buildConnectedServicesAccountChangeV1(ref);
    for (const invalid of [
      { ...change, kind: 'session' },
      { ...change, entityId: `${change.entityId}/other` },
      { ...change, hint: { connectedServices: true } },
      { ...change, hint: { connectedServices: true, connectedServiceRef: { ...ref, extra: true } } },
      { ...change, hint: { ...change.hint, extra: true } },
      { kind: 'account', entityId: 'connected-services', hint: { connectedServices: 'true' } },
    ]) expect(readConnectedServicesAccountChangeV1(invalid)).toBeNull();
  });
});
