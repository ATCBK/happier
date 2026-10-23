import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';

import {
    applyPluginAccountAvailabilityProjectionRefresh,
    clearPluginAccountAvailabilityProjection,
    retirePluginAccountAvailabilityProjection,
    replacePluginAccountAvailabilityProjection,
    useActivePluginAccountAvailabilityReader,
    useActivePluginAccountUiProjectionInputs,
} from './projection';
import type { PluginAccountAvailabilitySnapshot } from './reader';
import { InvalidateSync } from '@/utils/sessions/sync';

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;
const snapshot: PluginAccountAvailabilitySnapshot = {
    availabilityCursor: 1,
    intentReads: [],
    materializations: [],
    snapshots: [],
};

describe('Plugin Account Availability React publication', () => {
    it('keeps semantic consumers quiet through twenty cursor/time publications without hiding raw currentness', async () => {
        expect(useActivePluginAccountUiProjectionInputs).toEqual(expect.any(Function));
        const materialization: PluginMachineMaterializationV1 = {
            serverIdentityId: 'srv_fixture', machineId: 'machine-a', materializationId: 'external-install',
            pluginId: 'example.external', version: '1.0.0', sourceClass: 'localPath', portableRelease: false,
            uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1,
        };
        const value = { ...snapshot, materializations: [materialization] };
        replacePluginAccountAvailabilityProjection({ scope, snapshot: value });
        let semanticRenders = 0;
        const semantic = await renderHook(() => {
            semanticRenders += 1;
            return useActivePluginAccountUiProjectionInputs();
        });
        const raw = await renderHook(() => useActivePluginAccountAvailabilityReader());
        const first = semantic.getCurrent();
        const originalReader = raw.getCurrent();
        const settledRenders = semanticRenders;
        for (let cursor = 2; cursor <= 21; cursor += 1) {
            await act(async () => {
                replacePluginAccountAvailabilityProjection({ scope, snapshot: { ...value,
                    availabilityCursor: cursor, materializations: [{ ...materialization, observedAt: cursor }],
                } });
            });
            expect(semantic.getCurrent()).toBe(first);
            expect(semanticRenders).toBe(settledRenders);
            expect(raw.getCurrent()).not.toBe(originalReader);
            expect(originalReader?.readMaterializations()).toMatchObject({ availabilityCursor: cursor,
                materializations: [{ observedAt: cursor }],
            });
        }
        await act(async () => {
            replacePluginAccountAvailabilityProjection({ scope, snapshot: { ...value,
                materializations: [{ ...materialization, enabled: false }],
            } });
        });
        expect(semantic.getCurrent()).not.toBe(first);
        expect(semantic.getCurrent()?.materializations[0]?.enabled).toBe(false);
        const disabled = semantic.getCurrent();
        await act(async () => { retirePluginAccountAvailabilityProjection([materialization.pluginId]); });
        expect(semantic.getCurrent()).not.toBe(disabled);
        const nextScope = { ...scope, accountId: 'account-b' };
        await act(async () => { storage.setState({ profileScope: nextScope }); });
        expect(semantic.getCurrent()).toBeNull();
        expect(raw.getCurrent()?.readMaterializations()).toMatchObject({ kind: 'unavailable', code: 'account_availability_scope_mismatch' });
        await act(async () => { replacePluginAccountAvailabilityProjection({ scope: nextScope, snapshot: value }); });
        expect(semantic.getCurrent()).not.toBeNull();
        expect(originalReader?.readMaterializations().kind).toBe('unavailable');
    });

    it('publishes materializations before surfacing an incomplete census with no named failures', async () => {
        const hook = await renderHook(() => useActivePluginAccountAvailabilityReader()?.readMaterializations());
        await act(async () => {
            expect(() => applyPluginAccountAvailabilityProjectionRefresh({ scope, snapshot,
                failedPluginIds: [], intentCensusIncomplete: true,
            })).toThrow();
        });
        expect(hook.getCurrent()).toMatchObject({ kind: 'available', availabilityCursor: 1 });
    });
    beforeEach(() => {
        clearPluginAccountAvailabilityProjection();
        storage.setState({ profileScope: scope });
    });

    afterEach(() => {
        standardCleanup();
        clearPluginAccountAvailabilityProjection();
        storage.setState(storage.getInitialState(), true);
    });

    it('renders the current snapshot immediately after replacement, another replacement, and clear', async () => {
        const hook = await renderHook(() => (
            useActivePluginAccountAvailabilityReader()?.readMaterializations()
        ));
        const unavailable = { kind: 'unavailable', code: 'account_availability_not_loaded' };
        expect(hook.getCurrent()).toEqual(unavailable);

        await act(async () => {
            replacePluginAccountAvailabilityProjection({ scope, snapshot });
        });
        expect(hook.getCurrent()).toMatchObject({ kind: 'available', availabilityCursor: 1 });

        await act(async () => {
            replacePluginAccountAvailabilityProjection({
                scope,
                snapshot: { ...snapshot, availabilityCursor: 2 },
            });
        });
        expect(hook.getCurrent()).toMatchObject({ kind: 'available', availabilityCursor: 2 });

        await act(async () => {
            clearPluginAccountAvailabilityProjection();
        });
        expect(hook.getCurrent()).toEqual(unavailable);
    });

    it('publishes named invalidation without withdrawing unrelated plugin facts', async () => {
        const materializations: PluginMachineMaterializationV1[] = ['happier.first', 'happier.second'].map((pluginId) => ({
            serverIdentityId: 'srv_fixture',
            machineId: 'machine-a',
            materializationId: pluginId,
            pluginId,
            version: '1.0.0',
            sourceClass: 'localPath',
            portableRelease: false,
            uiArtifacts: [],
            enabled: true,
            trustState: 'trusted',
            observedAt: 1,
        }));
        replacePluginAccountAvailabilityProjection({ scope, snapshot: { ...snapshot, materializations } });
        const hook = await renderHook(() => (
            useActivePluginAccountAvailabilityReader()?.readMaterializations()
        ));
        expect(hook.getCurrent()).toMatchObject({ kind: 'available', materializations });

        await act(async () => {
            retirePluginAccountAvailabilityProjection(['happier.first']);
        });
        expect(hook.getCurrent()).toMatchObject({
            kind: 'available', materializations,
        });
    });

    it('observes only its plugin facts while imperative reads remain current and lifecycle changes notify', async () => {
        const pluginId = 'example.scoped';
        const materialization: PluginMachineMaterializationV1 = {
            serverIdentityId: 'srv_fixture', machineId: 'machine-a', materializationId: 'scoped-install',
            pluginId, version: '1.0.0', sourceClass: 'localPath', portableRelease: false,
            uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1,
        };
        replacePluginAccountAvailabilityProjection({ scope, snapshot });
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useActivePluginAccountAvailabilityReader(pluginId);
        });
        const originalReader = hook.getCurrent();
        const settledRenders = renders;
        await act(async () => {
            replacePluginAccountAvailabilityProjection({ scope, snapshot: {
                ...snapshot, availabilityCursor: 2,
                materializations: [{ ...materialization, pluginId: 'example.other' }],
            } });
        });
        expect(renders).toBe(settledRenders);
        expect(hook.getCurrent()).toBe(originalReader);
        expect(originalReader?.readMaterializations()).toMatchObject({ kind: 'available', availabilityCursor: 2 });

        await act(async () => {
            replacePluginAccountAvailabilityProjection({ scope, snapshot: {
                ...snapshot, availabilityCursor: 3, materializations: [materialization],
            } });
        });
        expect(renders).toBeGreaterThan(settledRenders);
        expect(hook.getCurrent()?.readMaterializations()).toMatchObject({ kind: 'available', materializations: [materialization] });
        let previousRenders = renders;
        await act(async () => { retirePluginAccountAvailabilityProjection([pluginId]); });
        expect(renders).toBeGreaterThan(previousRenders);
        previousRenders = renders;
        await act(async () => { clearPluginAccountAvailabilityProjection(); });
        expect(renders).toBeGreaterThan(previousRenders);
        expect(originalReader?.readMaterializations()).toMatchObject({ kind: 'unavailable', code: 'account_availability_not_loaded' });
        await hook.unmount();
    });

    it('lets InvalidateSync retry a partial refresh after publishing its successful siblings', async () => {
        const attempts: Array<Readonly<{ failedPluginIds: readonly string[] }>> = [
            { failedPluginIds: ['happier.failed'] },
            { failedPluginIds: [] },
        ];
        const unit = new InvalidateSync(async () => {
            const attempt = attempts.shift();
            if (!attempt) throw new Error('Unexpected Availability retry.');
            applyPluginAccountAvailabilityProjectionRefresh({
                scope,
                snapshot: { ...snapshot, availabilityCursor: attempts.length === 1 ? 2 : 3 },
                failedPluginIds: attempt.failedPluginIds,
            });
        }, {
            backoff: { minDelayMs: 0, maxDelayMs: 0, maxFailureCount: 'infinite' },
        });

        unit.invalidateCoalesced();
        await expect(unit.awaitQueue({ timeoutMs: 1_000 })).resolves.toEqual({ status: 'completed' });
        expect(attempts).toEqual([]);
        unit.stop();
    });

    it.each([undefined, 'example.scoped'])('never renders the previous Account projection after the active Account changes (plugin %s)', async (pluginId) => {
        replacePluginAccountAvailabilityProjection({ scope, snapshot });
        const hook = await renderHook(() => {
            const reader = useActivePluginAccountAvailabilityReader(pluginId);
            return { reader, materializations: reader?.readMaterializations() };
        });
        const previousReader = hook.getCurrent().reader;
        expect(hook.getCurrent().materializations).toMatchObject({ kind: 'available', availabilityCursor: 1 });
        const nextScope = { ...scope, accountId: 'account-b' };

        await act(async () => { storage.setState({ profileScope: nextScope }); });
        expect(hook.getCurrent().materializations).toEqual({
            kind: 'unavailable', code: 'account_availability_scope_mismatch',
        });

        await act(async () => {
            replacePluginAccountAvailabilityProjection({
                scope: nextScope, snapshot: { ...snapshot, availabilityCursor: 2 },
            });
        });
        expect(hook.getCurrent().materializations).toMatchObject({ kind: 'available', availabilityCursor: 2 });
        expect(previousReader?.readMaterializations()).toEqual({
            kind: 'unavailable', code: 'account_availability_scope_mismatch',
        });
    });

    it('does not expose an Account projection during server rendering without an initial Account scope', () => {
        replacePluginAccountAvailabilityProjection({ scope, snapshot });
        function Probe() {
            const reader = useActivePluginAccountAvailabilityReader();
            return reader ? 'account-projection' : 'no-account';
        }

        // Zustand's server snapshot is its initial state, not the client-side
        // Account established above. Availability must retain that boundary.
        expect(renderToStaticMarkup(React.createElement(Probe))).toBe('no-account');
    });
});
