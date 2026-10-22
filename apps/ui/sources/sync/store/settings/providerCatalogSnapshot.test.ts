import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDER_SETTINGS_V1 } from '@happier-dev/protocol/providers/settings/v1';
import { splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { applyProviderCatalogSnapshot, beginProviderCatalogLoad, getProviderCatalogSnapshot,
    beginProviderModelProjectionRead, getProviderModelProjectionSnapshot,
    resetProviderCatalogSnapshotsForTests, subscribeProviderCatalogSnapshots, subscribeProviderModelProjectionSnapshot } from './providerCatalogSnapshot';

afterEach(resetProviderCatalogSnapshotsForTests);
describe('scoped Provider row publication', () => {
    it('notifies only the affected model query and never the Account catalog or a sibling scope', () => {
        const scope = { serverId: 'home', accountId: 'account' };
        const catalogChanged = vi.fn();
        const queryChanged = vi.fn();
        const siblingChanged = vi.fn();
        const releases = [subscribeProviderCatalogSnapshots(catalogChanged),
            subscribeProviderModelProjectionSnapshot(scope, 'credential-a', 'models', queryChanged),
            subscribeProviderModelProjectionSnapshot(scope, 'credential-a', 'other-models', siblingChanged),
            subscribeProviderModelProjectionSnapshot({ ...scope, serverId: 'other' }, 'credential-a', 'models', siblingChanged)];
        try {
            const projection = DaemonProviderModelProjectionResponseV1Schema.parse({ status: 'success',
                agentTargetKey: 'agent:happier.agent.codex/codex', groups: [] });
            if (projection.status !== 'success') throw new Error('Expected successful fixture');
            beginProviderModelProjectionRead(scope, 'credential-a', 'models')(projection);
            expect(queryChanged).toHaveBeenCalledTimes(1);
            expect(catalogChanged).not.toHaveBeenCalled();
            expect(siblingChanged).not.toHaveBeenCalled();
        } finally { for (const release of releases) release(); }
    });

    it('withdraws model display data with Account-mode refusal and cannot republish the retired read', () => {
        const scope = { serverId: 'home', accountId: 'account' };
        const projection = DaemonProviderModelProjectionResponseV1Schema.parse({ status: 'success',
            agentTargetKey: 'agent:happier.agent.codex/codex', groups: [] });
        if (projection.status !== 'success') throw new Error('Expected successful fixture');
        const publish = beginProviderModelProjectionRead(scope, 'credential-a', 'models');
        publish(projection);
        expect(getProviderModelProjectionSnapshot(scope, 'credential-a', 'models')).toBe(projection);
        applyProviderCatalogSnapshot(scope, { status: 'unavailable', reason: 'account-mode-mismatch' }, true);
        expect(getProviderModelProjectionSnapshot(scope, 'credential-a', 'models')).toBeNull();
        publish(projection);
        expect(getProviderModelProjectionSnapshot(scope, 'credential-a', 'models')).toBeNull();
    });

    it('keeps the latest successful model revalidation and isolates credential/query scopes', () => {
        const scope = { serverId: 'home', accountId: 'account' };
        const projection = (agentTargetKey: string) => {
            const result = DaemonProviderModelProjectionResponseV1Schema.parse({ status: 'success', agentTargetKey, groups: [] });
            if (result.status !== 'success') throw new Error('Expected successful fixture');
            return result;
        };
        const publishEarlier = beginProviderModelProjectionRead(scope, 'credential-a', 'models');
        const publishLater = beginProviderModelProjectionRead(scope, 'credential-a', 'models');
        const latest = projection('agent:happier.agent.codex/codex');
        publishLater(latest);
        publishEarlier(projection('agent:happier.agent.claude/claude'));
        expect(getProviderModelProjectionSnapshot(scope, 'credential-a', 'models')).toBe(latest);
        expect(getProviderModelProjectionSnapshot(scope, 'credential-b', 'models')).toBeNull();
        expect(getProviderModelProjectionSnapshot(scope, 'credential-a', 'different-query')).toBeNull();
        expect(getProviderModelProjectionSnapshot({ ...scope, accountId: 'other' }, 'credential-a', 'models')).toBeNull();
    });

    it('retains display contents while refresh withdraws effect authority without notifying on an unchanged catalog', () => {
        const scope = { serverId: 'home', accountId: 'account' };
        const catalog = splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog;
        const ready = { status: 'ready' as const, revision: 4, catalog };
        applyProviderCatalogSnapshot(scope, ready, true);
        const initial = getProviderCatalogSnapshot(scope)!;
        let notifications = 0;
        const dispose = subscribeProviderCatalogSnapshots(() => { notifications += 1; });
        applyProviderCatalogSnapshot(scope, { ...ready, catalog: { ...catalog } }, true);
        expect(getProviderCatalogSnapshot(scope)).toBe(initial);
        expect(notifications).toBe(0);
        beginProviderCatalogLoad(scope);
        expect(getProviderCatalogSnapshot(scope)).toMatchObject({ status: 'loading', stale: true });
        expect(getProviderCatalogSnapshot(scope)?.data).toBe(initial.data);
        applyProviderCatalogSnapshot(scope, ready, false);
        expect(getProviderCatalogSnapshot(scope)?.status).toBe('loading');
        applyProviderCatalogSnapshot(scope, { status: 'unavailable', reason: 'unreachable' }, true);
        expect(getProviderCatalogSnapshot(scope)?.data).toBe(initial.data);
        applyProviderCatalogSnapshot(scope, { status: 'unavailable', reason: 'account-mode-mismatch' }, true);
        expect(getProviderCatalogSnapshot(scope)).toMatchObject({ data: null, stale: true });
        dispose();
    });
    it('keeps sibling Home publications isolated and never republishes a retired Account', () => {
        const scope = { serverId: 'home', accountId: 'account' };
        const catalog = splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog;
        applyProviderCatalogSnapshot(scope, { status: 'ready', revision: 'absent', catalog }, true);
        const initial = getProviderCatalogSnapshot(scope);
        applyProviderCatalogSnapshot({ serverId: 'other', accountId: 'account' }, { status: 'ready', revision: 1, catalog }, true);
        expect(getProviderCatalogSnapshot(scope)).toBe(initial);
        applyProviderCatalogSnapshot(scope, { status: 'unavailable', reason: 'scope-retired' }, true);
        expect(getProviderCatalogSnapshot(scope)).toBe(initial);
    });
});
