import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { applyAcknowledgedMcpServerCatalog, getMcpServerCatalogSnapshot, subscribeMcpServerCatalogSnapshots } from './mcpServerCatalogSnapshot';
import { applyAcknowledgedProviderCatalog, getProviderCatalogSnapshot, subscribeProviderCatalogSnapshots } from './providerCatalogSnapshot';
import { applyAcknowledgedAcpCatalog, applyAcpCatalogSnapshot, beginAcpCatalogLoad, getAcpCatalogSnapshot, subscribeAcpCatalogSnapshots } from './acpCatalogSnapshot';
import { applyAcknowledgedConnectedAccountCatalog, getConnectedAccountCatalogValue, subscribeConnectedAccountCatalogSnapshots } from './connectedAccountCatalogSnapshot';
import { applyAcknowledgedNotificationChannelCatalog, getNotificationChannelCatalogValue, subscribeNotificationChannelCatalogSnapshots } from './notificationChannelCatalogSnapshot';
import { applyAcknowledgedConnectedMetadata, getConnectedMetadataCatalog, subscribeConnectedMetadataCatalog } from './connectedMetadataCatalogSnapshot';
import { applyAcknowledgedRemoteHostCatalog, getRemoteHostCatalogSnapshot, subscribeRemoteHostCatalogSnapshots } from './remoteHostCatalogSnapshot';

describe('acknowledged catalog display evidence', () => {
    const scope = { serverId: 'acknowledged-owner', accountId: 'account' };
    const cases = [
        { domain: 'mcp', subscribe: subscribeMcpServerCatalogSnapshots, publish: (revision: number, current: boolean) => applyAcknowledgedMcpServerCatalog(scope,
            { v: 1, servers: [], bindings: [] }, revision, current), read: () => getMcpServerCatalogSnapshot(scope) },
        { domain: 'providers', subscribe: subscribeProviderCatalogSnapshots, publish: (revision: number, current: boolean) => applyAcknowledgedProviderCatalog(scope,
            DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, revision, current, null), read: () => getProviderCatalogSnapshot(scope) },
        { domain: 'acp', subscribe: subscribeAcpCatalogSnapshots, publish: (revision: number, current: boolean) => applyAcknowledgedAcpCatalog(scope,
            { v: 1, definitions: [] }, revision, current), read: () => getAcpCatalogSnapshot(scope) },
        { domain: 'configurations', subscribe: subscribeConnectedAccountCatalogSnapshots, publish: (revision: number, current: boolean) => applyAcknowledgedConnectedAccountCatalog(scope,
            { key: 'configurations', value: { v: 1, entries: [] } }, revision, current), read: () => getConnectedAccountCatalogValue(scope, 'configurations') },
        { domain: 'purposes', subscribe: subscribeConnectedAccountCatalogSnapshots, publish: (revision: number, current: boolean) => applyAcknowledgedConnectedAccountCatalog(scope,
            { key: 'purposes', value: { v: 1, bindings: [] } }, revision, current), read: () => getConnectedAccountCatalogValue(scope, 'purposes') },
        { domain: 'notifications', subscribe: subscribeNotificationChannelCatalogSnapshots, publish: (revision: number, current: boolean) => applyAcknowledgedNotificationChannelCatalog(scope,
            [], revision, current), read: () => getNotificationChannelCatalogValue(scope) },
        { domain: 'acknowledgements', subscribe: subscribeConnectedMetadataCatalog, publish: (revision: number, current: boolean) => applyAcknowledgedConnectedMetadata(scope,
            { kind: 'acknowledgements', record: { v: 1, entries: [] } }, revision, current), read: () => getConnectedMetadataCatalog(scope),
            staleEvidence: { acknowledgementsStale: true } },
        { domain: 'presentation', subscribe: subscribeConnectedMetadataCatalog, publish: (revision: number, current: boolean) => applyAcknowledgedConnectedMetadata(scope,
            { kind: 'presentation', record: { v: 1, entries: [] } }, revision, current), read: () => getConnectedMetadataCatalog(scope),
            // The shared connected-metadata snapshot keeps one staleness flag per acknowledged kind.
            staleEvidence: { presentationStale: true } },
        { domain: 'remote hosts', subscribe: subscribeRemoteHostCatalogSnapshots, publish: (revision: number, current: boolean) => applyAcknowledgedRemoteHostCatalog(scope,
            [], revision, current), read: () => getRemoteHostCatalogSnapshot(scope) },
    ];
    it.each(cases)('keeps $domain evidence stale and suppresses equal, older or retired receipts', ({ publish, read, subscribe, staleEvidence }) => {
        publish(5, true);
        const acknowledged = read();
        const notify = vi.fn();
        const unsubscribe = subscribe(notify);
        onTestFinished(unsubscribe);
        expect(acknowledged).toMatchObject(staleEvidence ?? { stale: true });
        publish(4, true);
        expect(read()).toBe(acknowledged);
        publish(6, false);
        expect(read()).toBe(acknowledged);
        publish(5, true);
        expect(read()).toBe(acknowledged);
        expect(notify).not.toHaveBeenCalled();
        publish(6, true);
        expect(read()).not.toBe(acknowledged);
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('retains partial ACP revision evidence through refresh and failure before admitting receipts', () => {
        const account = { serverId: 'partial-acp-owner', accountId: 'account' };
        const partial = { status: 'partial' as const, reason: 'incomplete-inventory' as const,
            record: { v: 1 as const, definitions: [] }, diagnostics: [], revision: 10 };
        applyAcpCatalogSnapshot(account, partial, true);
        expect(getAcpCatalogSnapshot(account)?.revision).toBe(10);
        beginAcpCatalogLoad(account);
        applyAcpCatalogSnapshot(account, { status: 'unavailable', reason: 'unreachable' }, true);
        const retained = getAcpCatalogSnapshot(account);
        applyAcknowledgedAcpCatalog(account, { v: 1, definitions: [] }, 6, true);
        expect(getAcpCatalogSnapshot(account)).toBe(retained);
        applyAcknowledgedAcpCatalog(account, { v: 1, definitions: [] }, 11, false);
        expect(getAcpCatalogSnapshot(account)).toBe(retained);
        applyAcknowledgedAcpCatalog(account, { v: 1, definitions: [] }, 11, true);
        expect(getAcpCatalogSnapshot(account)).toMatchObject({ revision: 11, stale: true });
        expect(getAcpCatalogSnapshot({ ...account, accountId: 'foreign' })).toBeNull();
    });
});
