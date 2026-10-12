import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol';
import { DaemonProviderConnectionMutationRequestV1Schema } from '@happier-dev/protocol/rpc';
import type { z } from 'zod';

import {
    createProviderConnectionViewFixture,
    createProviderSettingsAccountHarness,
    installProviderConnectionsCatalogHttpBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { buildCustomProviderTemplate, createCustomProviderDraft } from '@/providers/authoring/state';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { PROVIDER_CONNECTION_ACTION_ID_BY_OPERATION_V1 } from '@happier-dev/protocol/providers/providerActionsV1';

const machineRpcWithServerScope = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope }));

const account = createProviderSettingsAccountHarness();
const navigation = createExpoRouterMock();
vi.doMock('expo-router', () => navigation.module);
let serverId = '';
let otherServerId = '';
await loadSyncSingletonForTests();
const { useProviderConnectionMutation } = await import('./useProviderConnectionMutation');

/**
 * Machine target resolvers are stable unless a test changes the selected
 * machine. Account Actions keep their Account scope through that change.
 */
const resolveTargetOnServerA = () => ({ machineId: 'machine-a', serverId });
const resolveTargetOnServerB = () => ({ machineId: 'machine-a', serverId: otherServerId });
const resolveNoTarget = () => null;

function connectionCatalog() {
    return ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
        connections: ['pc_a', 'pc_prior', 'pc_first', 'pc_second', 'pc_other'].map(id => ({
            v: 1, id, source: { kind: 'custom', template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-responses'), name: 'Test source',
                baseUrl: 'https://models.example.test/v1', requiresApiKey: false,
            }) }, role: 'named', displayName: 'Test source', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1,
        })),
    });
}
function writableCatalog(reply?: Parameters<typeof installProviderConnectionsCatalogHttpBoundary>[0]['reply'], targetServerId = serverId) {
    return installProviderConnectionsCatalogHttpBoundary({ home: account.home, serverId: targetServerId, catalog: connectionCatalog(), reply });
}

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => { resolve = next; });
    return { promise, resolve };
}

type ProviderConnectionMutationRequestInput = z.input<typeof DaemonProviderConnectionMutationRequestV1Schema>;
type PendingPresentation = Readonly<{
    isPending: (key: string) => boolean;
}>;

function isKeyPending(result: PendingPresentation, key: string): boolean {
    return result.isPending(key);
}

describe('useProviderConnectionMutation', () => {
    afterEach(async () => { standardCleanup(); await account.reset(); });
    beforeEach(async () => {
        machineRpcWithServerScope.mockReset();
        const waivedActions = Object.values(PROVIDER_CONNECTION_ACTION_ID_BY_OPERATION_V1);
        const settings = { actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: Object.fromEntries(waivedActions.map(id => [id, ['ui']])) } };
        serverId = (await account.restore({ settings, catalog: connectionCatalog() })).serverId;
        const { storage } = await import('@/sync/domains/state/storage');
        await waitForHomeGovernance(() => expect(storage.getState().settings.actionsSettingsV1
            .approvalWaivedSurfaces['providers.connections.delete']).toContain('ui'));
        otherServerId = await account.addHome({ name: 'Other Provider Home', serverUrl: 'https://provider-settings-other.test', accountId: 'account-a', active: false });
        account.home.answer(otherServerId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: settings } } });
    });

    it('writes Account configuration without a selected machine', async () => {
        const catalog = writableCatalog();
        const refresh = vi.fn(async () => undefined);
        const hook = await renderHook(() => useProviderConnectionMutation({ serverId, resolveTarget: resolveNoTarget, refresh }));
        await act(async () => {
            expect(await hook.getCurrent().run({ action: 'delete', connectionId: 'pc_a' }))
                .toMatchObject({ status: 'success', action: 'delete', deletedConnectionId: 'pc_a' });
        });
        expect(catalog.catalog.connections.some(connection => connection.id === 'pc_a')).toBe(false);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledOnce();
    });

    it('keeps an Account write pending and delivers its ACK when only the selected machine changes', async () => {
        const deferred = createDeferred<void>();
        const catalog = writableCatalog(mutation => ({ respondAfter: deferred.promise,
            body: { status: 'updated', revision: Number(mutation.expectedRevision) + 1, cursor: Number(mutation.expectedRevision) + 1 } }));
        const refresh = vi.fn(async () => undefined);
        const hook = await renderHook(({ resolveTarget }: { resolveTarget: typeof resolveTargetOnServerA }) =>
            useProviderConnectionMutation({ serverId, resolveTarget, refresh }),
            { initialProps: { resolveTarget: resolveTargetOnServerA } });
        let operation!: Promise<unknown>;
        await act(async () => { operation = hook.getCurrent().run({ action: 'delete', connectionId: 'pc_a' }); });
        await waitForHomeGovernance(() => expect(catalog.writes).toBe(1));
        await hook.rerender({ resolveTarget: () => ({ machineId: 'machine-b', serverId }) });
        const wasPending = hook.getCurrent().isPending('delete:pc_a');
        let result: unknown;
        await act(async () => { deferred.resolve(); result = await operation; });
        expect(wasPending).toBe(true);
        expect(result).toMatchObject({ status: 'success', deletedConnectionId: 'pc_a' });
        expect(refresh).toHaveBeenCalledWith('account');
        expect(hook.getCurrent().isPending('delete:pc_a')).toBe(false);
    });

    it('settles an acknowledged Account write while presentation refresh is pending', async () => {
        const catalog = writableCatalog();
        const revalidation = createDeferred<void>();
        const refresh = vi.fn(() => revalidation.promise);
        const hook = await renderHook(() => useProviderConnectionMutation({ serverId, resolveTarget: resolveNoTarget, refresh }));
        let settled = false;
        let operation!: Promise<unknown>;
        await act(async () => {
            operation = hook.getCurrent().run({ action: 'delete', connectionId: 'pc_a' }).then(result => {
                settled = true;
                return result;
            });
        });
        try {
            await waitForHomeGovernance(() => expect(refresh).toHaveBeenCalled());
            expect(catalog.catalog.connections.some(connection => connection.id === 'pc_a')).toBe(false);
            await act(async () => { await Promise.resolve(); });
            expect(settled).toBe(true);
            expect(hook.getCurrent().isPending('delete:pc_a')).toBe(false);
        } finally {
            await act(async () => { revalidation.resolve(); await operation; });
        }
    });

    it('retires a machine result when only the selected machine changes on the same Account', async () => {
        const deferred = createDeferred<unknown>();
        machineRpcWithServerScope.mockImplementationOnce(() => deferred.promise);
        const refresh = vi.fn(async () => undefined);
        const hook = await renderHook(({ resolveTarget }: { resolveTarget: typeof resolveTargetOnServerA }) =>
            useProviderConnectionMutation({ serverId, resolveTarget, refresh }),
            { initialProps: { resolveTarget: resolveTargetOnServerA } });
        let operation!: Promise<unknown>;
        await act(async () => { operation = hook.getCurrent().run({ action: 'setEnabled', scope: 'machine',
            enabled: true, connectionId: 'pc_a', machineId: 'machine-a' }); });
        await waitForHomeGovernance(() => expect(machineRpcWithServerScope).toHaveBeenCalledOnce());
        await hook.rerender({ resolveTarget: () => ({ machineId: 'machine-b', serverId }) });
        const pending = hook.getCurrent().isPending('setEnabled:pc_a');
        let result: unknown;
        await act(async () => {
            deferred.resolve({ status: 'error', error: createProviderErrorV1('provider_endpoint_unreachable') });
            result = await operation;
        });
        expect(pending).toBe(false);
        expect(result).toBeNull();
        expect(hook.getCurrent().error).toBeNull();
        expect(refresh).not.toHaveBeenCalled();
    });

    it('reconciles after a commit-then-reject transport failure without exposing a replay', async () => {
        const events: string[] = [];
        const catalog = writableCatalog(() => {
            events.push('commit');
            return { dispatchThenFail: true };
        });
        const refresh = vi.fn(async () => { events.push('refresh'); });
        const hook = await renderHook(() => useProviderConnectionMutation({
            resolveTarget: resolveTargetOnServerA,
            refresh,
        }));

        await act(async () => {
            await hook.getCurrent().run({
                action: 'delete',
                machineId: 'machine-a',
                connectionId: 'pc_a',
            });
        });

        expect(hook.getCurrent()).toMatchObject({
            error: createProviderErrorV1('provider_rpc_mutation_outcome_unknown', {
                connectionId: 'pc_a',
                machineId: 'machine-a',
            }),
        });
        expect(hook.getCurrent().isPending('delete:pc_a')).toBe(false);
        expect(hook.getCurrent()).not.toHaveProperty('errorCode');
        expect(events).toEqual(['commit', 'refresh']);
        expect(catalog.writes).toBe(1);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledOnce();
    });

    it('coalesces an identical pending mutation before it can dispatch twice', async () => {
        const deferred = createDeferred<void>();
        const catalog = writableCatalog(mutation => ({ respondAfter: deferred.promise,
            body: { status: 'updated', revision: Number(mutation.expectedRevision) + 1, cursor: Number(mutation.expectedRevision) + 1 } }));
        const refresh = vi.fn(async () => undefined);
        const hook = await renderHook(() => useProviderConnectionMutation({
            resolveTarget: resolveTargetOnServerA,
            refresh,
        }));
        const request = {
            action: 'delete' as const,
            machineId: 'machine-a',
            connectionId: 'pc_a',
        };
        const duplicateRequest = {
            action: 'delete' as const,
            machineId: 'machine-a',
            connectionId: 'pc_a',
        };

        let first!: Promise<unknown>;
        let duplicate!: Promise<unknown>;
        await act(async () => {
            first = hook.getCurrent().run(request, 'delete');
            duplicate = hook.getCurrent().run(duplicateRequest, 'delete');
            await Promise.resolve();
        });

        await waitForHomeGovernance(() => expect(catalog.writes).toBe(1));
        await act(async () => {
            deferred.resolve();
            await Promise.all([first, duplicate]);
        });

        expect(refresh).toHaveBeenCalledOnce();
    });

    it('keeps a captured mutation callback stable across re-renders of one target scope', async () => {
        // Unrelated re-renders must not restart the write path: the callback a
        // modal captured stays the current one, its request coalesces with an
        // identical concurrent one, including when the target acquires an
        // alias for the same Home.
        const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
        await setServerProfileIdentityForUrl('https://provider-settings-account.test', 'srv_provider_settings');
        const deferred = createDeferred<void>();
        const catalog = writableCatalog(mutation => ({ respondAfter: deferred.promise,
            body: { status: 'updated', revision: Number(mutation.expectedRevision) + 1, cursor: Number(mutation.expectedRevision) + 1 } }));
        const selected = { current: { machineId: 'machine-a', serverId } };
        const resolveTarget = () => selected.current;
        const refresh = vi.fn(async () => undefined);
        const hook = await renderHook(
            ({ unrelated }: Readonly<{ unrelated: number }>) => {
                void unrelated;
                return useProviderConnectionMutation({ resolveTarget, refresh });
            },
            { initialProps: { unrelated: 0 } },
        );
        const capturedUnderA = hook.getCurrent().run;

        selected.current = { machineId: 'machine-a', serverId: 'srv_provider_settings' };
        await hook.rerender({ unrelated: 1 });
        const currentRun = hook.getCurrent().run;

        const request = {
            action: 'delete' as const,
            machineId: 'machine-a',
            connectionId: 'pc_a',
        };
        let fromCapturedCallback!: Promise<unknown>;
        let fromCurrentCallback!: Promise<unknown>;
        await act(async () => {
            fromCapturedCallback = capturedUnderA(request, 'delete');
            fromCurrentCallback = hook.getCurrent().run({ ...request }, 'delete');
            await Promise.resolve();
        });

        await act(async () => {
            deferred.resolve();
            await Promise.all([fromCapturedCallback, fromCurrentCallback]);
        });

        expect(fromCurrentCallback).toBe(fromCapturedCallback);
        expect(catalog.writes).toBe(1);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
        expect(currentRun).toBe(capturedUnderA);
        expect(refresh).toHaveBeenCalledOnce();
    });

    it('refuses a modal-delayed write once the selection has moved to another machine', async () => {
        // The user confirmed a destructive action for machine-a, then switched
        // targets while the confirmation was open. Issuing the captured request
        // now would either delete on the wrong machine or combine the old
        // machine id with the new server's routing.
        const selected = { current: { machineId: 'machine-a', serverId } };
        const resolveTarget = () => selected.current;
        const refresh = vi.fn(async () => undefined);
        const hook = await renderHook(() => useProviderConnectionMutation({ resolveTarget, refresh }));

        selected.current = { machineId: 'machine-b', serverId: otherServerId };
        await act(async () => {
            await hook.getCurrent().run({
                action: 'setEnabled', scope: 'machine', enabled: false,
                machineId: 'machine-a',
                connectionId: 'pc_a',
            });
        });

        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(hook.getCurrent().error).toEqual(createProviderErrorV1('provider_authorization_changed', {
            machineId: 'machine-a',
            connectionId: 'pc_a',
        }));
    });

    it('refuses a modal-delayed write once the selection has moved to the same machine id on another server profile', async () => {
        // A machine id is unique only inside one server identity. The user
        // confirmed a destructive action while srv_a/machine-a was the target;
        // the selection then moved to a DIFFERENT Account's machine that
        // happens to carry the same id. The captured request names machine-a,
        // so a machine-id-only check still matches — and the write would be
        // issued against the other server's daemon.
        const live = {
            current: { serverIdentityId: 'srv_a', machineId: 'machine-a', serverId },
        };
        // Mirrors the Provider target owner's `resolveCurrentTarget`: it
        // re-resolves the live selection and returns null once that selection
        // moved away from the target the calling render was built for.
        const resolverForRenderedTarget = (
            expected: Readonly<{ serverIdentityId: string; machineId: string }>,
        ) => () => (
            live.current.serverIdentityId === expected.serverIdentityId
                && live.current.machineId === expected.machineId
                ? { machineId: live.current.machineId, serverId: live.current.serverId }
                : null
        );
        const resolveOnIdentityA = resolverForRenderedTarget({
            serverIdentityId: 'srv_a', machineId: 'machine-a',
        });
        const resolveOnIdentityB = resolverForRenderedTarget({
            serverIdentityId: 'srv_b', machineId: 'machine-a',
        });
        const refresh = vi.fn(async () => undefined);
        const hook = await renderHook(
            ({ resolveTarget }: Readonly<{
                resolveTarget: () => Readonly<{ machineId: string; serverId: string }> | null;
            }>) => useProviderConnectionMutation({ resolveTarget, refresh }),
            { initialProps: { resolveTarget: resolveOnIdentityA } },
        );
        const capturedWhileTargetingIdentityA = hook.getCurrent().run;

        live.current = { serverIdentityId: 'srv_b', machineId: 'machine-a', serverId: otherServerId };
        await hook.rerender({ resolveTarget: resolveOnIdentityB });

        await act(async () => {
            await capturedWhileTargetingIdentityA({
                action: 'setEnabled', scope: 'machine', enabled: false,
                machineId: 'machine-a',
                connectionId: 'pc_a',
            }, 'delete');
        });

        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(hook.getCurrent().error).toEqual(createProviderErrorV1('provider_authorization_changed', {
            machineId: 'machine-a',
            connectionId: 'pc_a',
        }));
    });

    it('issues a write through the server the target resolves to at effect time', async () => {
        // The device-local routing id of the selected server identity can be
        // replaced while a modal is open. The write must follow the freshly
        // resolved routing id, not the one captured at render.
        const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
        await setServerProfileIdentityForUrl('https://provider-settings-account.test', 'srv_provider_settings');
        const selected = { current: { machineId: 'machine-a', serverId } };
        const resolveTarget = () => selected.current;
        const refresh = vi.fn(async () => undefined);
        machineRpcWithServerScope.mockResolvedValueOnce({
            status: 'success', action: 'setEnabled', connection: createProviderConnectionViewFixture(),
        });
        const hook = await renderHook(() => useProviderConnectionMutation({ resolveTarget, refresh }));

        selected.current = { machineId: 'machine-a', serverId: 'srv_provider_settings' };
        await act(async () => {
            await hook.getCurrent().run({
                action: 'setEnabled', scope: 'machine', enabled: false,
                machineId: 'machine-a',
                connectionId: 'pc_a',
            });
        });

        expect(machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            serverId: 'srv_provider_settings',
        }));
        expect(hook.getCurrent().error).toBeNull();
    });

    it('refuses a write when the selected machine is no longer reachable', async () => {
        const resolveTarget = () => null;
        const refresh = vi.fn(async () => undefined);
        const hook = await renderHook(() => useProviderConnectionMutation({ resolveTarget, refresh }));

        await act(async () => {
            await hook.getCurrent().run({
                action: 'setEnabled', scope: 'machine', enabled: false,
                machineId: 'machine-a',
                connectionId: 'pc_a',
            });
        });

        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
        expect(hook.getCurrent().error?.code).toBe('provider_authorization_changed');
    });

    it('coalesces canonically equal requests but not material differences', async () => {
        const receipt = createDeferred<void>();
        const catalog = writableCatalog(mutation => ({ respondAfter: receipt.promise,
            body: { status: 'updated', revision: Number(mutation.expectedRevision) + 1, cursor: Number(mutation.expectedRevision) + 1 } }));
        const refresh = vi.fn(async () => undefined);
        const hook = await renderHook(() => useProviderConnectionMutation({
            resolveTarget: resolveTargetOnServerA,
            refresh,
        }));
        const firstRequest = {
            action: 'createCustom',
            machineId: 'machine-a',
            connectionId: 'pc_custom',
            template: {
                v: 1,
                name: ' Custom ',
                endpointTemplates: [{
                    id: 'anthropic',
                    protocol: 'anthropic',
                    baseUrl: 'https://gateway.example/anthropic',
                    capabilities: {
                        streaming: 'unknown',
                        toolRoundTrips: 'unknown',
                        statefulResponses: 'unknown',
                        reasoningControls: 'unknown',
                    },
                }],
                catalog: { source: 'manual', manualModelPolicy: 'allowed' },
            },
            savedSecretId: null,
            enable: false,
        } satisfies ProviderConnectionMutationRequestInput;
        const equivalentRequest = {
            enable: false,
            savedSecretId: null,
            template: {
                catalog: { manualModelPolicy: 'allowed', source: 'manual' },
                endpointTemplates: [{
                    capabilities: {
                        reasoningControls: 'unknown',
                        statefulResponses: 'unknown',
                        toolRoundTrips: 'unknown',
                        streaming: 'unknown',
                    },
                    baseUrl: 'https://gateway.example/anthropic',
                    protocol: 'anthropic',
                    id: 'anthropic',
                }],
                name: 'Custom',
                v: 1,
            },
            connectionId: 'pc_custom',
            machineId: 'machine-a',
            action: 'createCustom',
            manualModels: [],
        } satisfies ProviderConnectionMutationRequestInput;
        const materiallyDifferentRequest = {
            ...equivalentRequest,
            connectionId: 'pc_custom_enabled',
            enable: true,
        } satisfies ProviderConnectionMutationRequestInput;

        let first!: Promise<unknown>;
        let equivalent!: Promise<unknown>;
        let materiallyDifferent!: Promise<unknown>;
        await act(async () => {
            first = hook.getCurrent().run(firstRequest, 'save');
            equivalent = hook.getCurrent().run(equivalentRequest, 'save');
            await Promise.resolve();
        });

        await waitForHomeGovernance(() => expect(catalog.writes).toBe(1));
        // Keep the first receipt pending but let the next real read observe its
        // committed CAS revision; concurrent stale snapshots may legitimately conflict.
        await act(async () => {
            materiallyDifferent = hook.getCurrent().run(materiallyDifferentRequest, 'save');
        });
        await waitForHomeGovernance(() => expect(catalog.writes).toBe(2));
        let outcomes!: unknown[];
        await act(async () => {
            receipt.resolve();
            outcomes = await Promise.all([first, equivalent, materiallyDifferent]);
        });

        expect(equivalent).toBe(first);
        expect(materiallyDifferent).not.toBe(first);
        expect(outcomes).toMatchObject([
            { status: 'success', action: 'createCustom', created: true },
            { status: 'success', action: 'createCustom', created: true },
            { status: 'success', action: 'createCustom', created: true },
        ]);
        expect(catalog.catalog.connections.find(connection => connection.id === 'pc_custom')?.source)
            .toMatchObject({ kind: 'custom', template: { name: 'Custom' } });
        expect(catalog.catalog.connections.filter(connection => connection.id.startsWith('pc_custom')))
            .toHaveLength(2);
        expect(catalog.writes).toBe(2);
        expect(catalog.catalog.accountGrants.map(grant => grant.connectionId)).toEqual(['pc_custom_enabled']);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('keeps every current-scope UI key pending until its own requests settle', async () => {
        const priorScope = createDeferred<void>();
        const currentSharedFirst = createDeferred<void>();
        const currentSharedSecond = createDeferred<void>();
        const currentOther = createDeferred<void>();
        const priorCatalog = writableCatalog(mutation => ({ respondAfter: priorScope.promise,
            body: { status: 'updated', revision: Number(mutation.expectedRevision) + 1, cursor: Number(mutation.expectedRevision) + 1 } }));
        const currentReceipts = [currentSharedFirst.promise, currentOther.promise, currentSharedSecond.promise];
        let currentWrite = 0;
        const currentCatalog = writableCatalog(mutation => ({ respondAfter: currentReceipts[currentWrite++],
            body: { status: 'updated', revision: Number(mutation.expectedRevision) + 1, cursor: Number(mutation.expectedRevision) + 1 } }), otherServerId);
        const refreshA = vi.fn(async () => undefined);
        const refreshB = vi.fn(async () => undefined);
        const hook = await renderHook(
            ({ resolveTarget, refresh }: Readonly<{
                resolveTarget: () => Readonly<{ machineId: string; serverId: string }> | null;
                refresh: () => Promise<void>;
            }>) => useProviderConnectionMutation({ resolveTarget, refresh }),
            { initialProps: { resolveTarget: resolveTargetOnServerA, refresh: refreshA } },
        );
        let fromPriorScope!: Promise<unknown>;
        await act(async () => {
            fromPriorScope = hook.getCurrent().run({
                action: 'delete', machineId: 'machine-a', connectionId: 'pc_prior',
            }, 'shared');
            await Promise.resolve();
        });
        await waitForHomeGovernance(() => expect(priorCatalog.writes).toBe(1));

        await hook.rerender({ resolveTarget: resolveTargetOnServerB, refresh: refreshB });
        let firstCurrentShared!: Promise<unknown>;
        let secondCurrentShared!: Promise<unknown>;
        let currentOtherRequest!: Promise<unknown>;
        await act(async () => {
            firstCurrentShared = hook.getCurrent().run({
                action: 'delete', machineId: 'machine-a', connectionId: 'pc_first',
            }, 'shared');
            await Promise.resolve();
        });
        await waitForHomeGovernance(() => expect(currentCatalog.writes).toBe(1));
        await act(async () => {
            currentOtherRequest = hook.getCurrent().run({
                action: 'delete', machineId: 'machine-a', connectionId: 'pc_other',
            }, 'other');
            await Promise.resolve();
        });
        await waitForHomeGovernance(() => expect(currentCatalog.writes).toBe(2));
        await act(async () => {
            secondCurrentShared = hook.getCurrent().run({
                action: 'delete', machineId: 'machine-a', connectionId: 'pc_second',
            }, 'shared');
            await Promise.resolve();
        });
        await waitForHomeGovernance(() => expect(currentCatalog.writes).toBe(3));

        const observedPending = [[
            isKeyPending(hook.getCurrent(), 'shared'),
            isKeyPending(hook.getCurrent(), 'other'),
        ]];

        await act(async () => {
            priorScope.resolve();
            await fromPriorScope;
        });
        observedPending.push([
            isKeyPending(hook.getCurrent(), 'shared'),
            isKeyPending(hook.getCurrent(), 'other'),
        ]);

        await act(async () => {
            currentSharedFirst.resolve();
            await firstCurrentShared;
        });
        observedPending.push([
            isKeyPending(hook.getCurrent(), 'shared'),
            isKeyPending(hook.getCurrent(), 'other'),
        ]);

        await act(async () => {
            currentOther.resolve();
            await currentOtherRequest;
        });
        observedPending.push([
            isKeyPending(hook.getCurrent(), 'shared'),
            isKeyPending(hook.getCurrent(), 'other'),
        ]);

        await act(async () => {
            currentSharedSecond.resolve();
            await secondCurrentShared;
        });
        observedPending.push([
            isKeyPending(hook.getCurrent(), 'shared'),
            isKeyPending(hook.getCurrent(), 'other'),
        ]);

        expect(observedPending).toEqual([
            [true, true],
            [true, true],
            [true, true],
            [true, false],
            [false, false],
        ]);
        expect(hook.getCurrent()).not.toHaveProperty('pendingKey');
        expect(hook.getCurrent()).toHaveProperty('isPending');
    });

    it('reconciles a committed create with a malformed response before offering current-state review', async () => {
        const events: string[] = [];
        const catalog = writableCatalog(() => {
            events.push('commit');
            return { body: { status: 'updated' } };
        });
        const refresh = vi.fn(async () => { events.push('refresh'); });
        const hook = await renderHook(() => useProviderConnectionMutation({
            resolveTarget: resolveTargetOnServerA,
            refresh,
        }));

        await act(async () => {
            await hook.getCurrent().run({
                action: 'createContribution',
                machineId: 'machine-a',
                connectionId: 'pc_created',
                contributionKey: 'happier.provider.deepseek/deepseek',
                displayName: null,
                savedSecretId: null,
                enable: false,
            });
        });

        expect(events).toEqual(['commit', 'refresh']);
        expect(catalog.writes).toBe(1);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledOnce();
        expect(hook.getCurrent().error).toEqual(createProviderErrorV1('provider_rpc_mutation_outcome_unknown', {
            connectionId: 'pc_created',
            machineId: 'machine-a',
        }));
    });

    it('preserves acknowledged create, update, and delete results when only their follow-up read fails', async () => {
        const catalog = writableCatalog();
        const refresh = vi.fn(async () => { throw new Error('catalog refresh unavailable'); });
        const hook = await renderHook(() => useProviderConnectionMutation({
            resolveTarget: resolveTargetOnServerA,
            refresh,
        }));
        const cases = [
            {
                request: {
                    action: 'createContribution' as const,
                    machineId: 'machine-a', connectionId: 'pc_created',
                    contributionKey: 'happier.provider.deepseek/deepseek', displayName: 'Created source',
                    savedSecretId: null, enable: false,
                },
            },
            {
                request: {
                    action: 'update' as const,
                    machineId: 'machine-a', connectionId: 'pc_created', expectedRevision: 0,
                    displayName: 'Updated', displayNameMode: 'custom' as const,
                },
            },
            {
                request: { action: 'delete' as const, machineId: 'machine-a', connectionId: 'pc_created' },
            },
        ];

        for (const testCase of cases) {
            let result: unknown;
            await act(async () => {
                result = await hook.getCurrent().run(testCase.request);
            });
            expect(result).toMatchObject({ status: 'success', action: testCase.request.action });
            expect(hook.getCurrent().error).toEqual(createProviderErrorV1('agent_error', {
                connectionId: 'pc_created',
                machineId: 'machine-a',
            }));
            expect(hook.getCurrent().retry).toBeTypeOf('function');
            const writesBeforeRetry = catalog.writes;
            await act(async () => {
                await expect(hook.getCurrent().retry?.()).rejects.toThrow('catalog refresh unavailable');
            });
            expect(catalog.writes).toBe(writesBeforeRetry);
        }

        expect(catalog.writes).toBe(3);
        expect(catalog.catalog.connections.some(connection => connection.id === 'pc_created')).toBe(false);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledTimes(6);
    });

    it('does not refresh or publish a mutation result after the server/query scope changes', async () => {
        const deferred = createDeferred<void>();
        const catalog = writableCatalog(mutation => ({ respondAfter: deferred.promise,
            body: { status: 'updated', revision: Number(mutation.expectedRevision) + 1, cursor: Number(mutation.expectedRevision) + 1 } }));
        const refreshA = vi.fn(async () => undefined);
        const refreshB = vi.fn(async () => undefined);
        const hook = await renderHook(
            ({ resolveTarget, refresh }: Readonly<{
                resolveTarget: () => Readonly<{ machineId: string; serverId: string }> | null;
                refresh: () => Promise<void>;
            }>) => useProviderConnectionMutation({ resolveTarget, refresh }),
            { initialProps: { resolveTarget: resolveTargetOnServerA, refresh: refreshA } },
        );

        let resultPromise!: Promise<unknown>;
        await act(async () => {
            resultPromise = hook.getCurrent().run({
                action: 'delete',
                machineId: 'machine-a',
                connectionId: 'pc_a',
            });
        });
        await waitForHomeGovernance(() => expect(catalog.writes).toBe(1));
        await hook.rerender({ resolveTarget: resolveTargetOnServerB, refresh: refreshB });
        await act(async () => {
            deferred.resolve();
            await resultPromise;
        });

        expect(refreshA).not.toHaveBeenCalled();
        expect(refreshB).not.toHaveBeenCalled();
        expect(hook.getCurrent()).toMatchObject({ error: null });
        expect(hook.getCurrent().isPending('delete:pc_a')).toBe(false);
    });
});
