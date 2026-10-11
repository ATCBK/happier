import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1, ProviderConnectionIdSchema } from '@happier-dev/protocol';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { buildCustomProviderTemplate, createCustomProviderDraft } from '@/providers/authoring/state';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const confirmSpy = vi.hoisted(() => vi.fn());
const alertSpy = vi.hoisted(() => vi.fn());
const commitSelectionSpy = vi.hoisted(() => vi.fn());

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: confirmSpy, alert: alertSpy } }).module;
});

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
let serverId = '';
let otherServerId = '';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const confirmation = {
    kind: 'confirm-experimental',
    connectionId: ProviderConnectionIdSchema.parse('pc_experimental'),
    expectedConnectionRevision: 3,
    agentTargetKey: 'agent:happier.agent.codex/codex',
    modelId: 'experimental-model',
    compatibilityFingerprint: 'compatibility:v1:experimental',
    providerName: 'Gateway',
    modelName: 'Experimental model',
} as const;

// Warm the real Sync module after the transport leaves are installed, not inside a test hook's budget.
await loadSyncSingletonForTests();

async function admittedClient() {
    const { useProviderActionClient } = await import('@/providers/actions/useProviderActionClient');
    const client = await renderHook(() => useProviderActionClient(serverId));
    await waitForHomeGovernance(() => expect(client.getCurrent().ready).toBe(true));
    return client;
}

async function withdrawCredentials() {
    const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
    const profile = getServerProfileById(serverId)!;
    expect(await TokenStorage.removeCredentialsForServerUrl(profile.serverUrl, { serverId })).toBe(true);
}

function persistedConfirmation() {
    const row = account.readCatalogRow();
    if (row?.content?.t !== 'plain') throw new Error('Expected Plain Account confirmation row');
    return row.content.v.experimentalBindingConfirmations;
}

describe('useConfirmExperimentalProviderModel', () => {
    beforeEach(async () => {
        confirmSpy.mockReset();
        alertSpy.mockReset();
        rpc.reset();
        commitSelectionSpy.mockReset();
        const template = buildCustomProviderTemplate({ ...createCustomProviderDraft('openai-responses'),
            name: 'Experimental source', baseUrl: 'https://experimental-models.test/v1', requiresApiKey: false });
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: confirmation.connectionId, source: { kind: 'custom', template }, role: 'named',
                displayName: 'Experimental source', displayNameMode: 'custom', revision: 3, createdAt: 1, updatedAt: 1 }],
        });
        serverId = (await account.restore({ catalog, machines: [], waivedActions: ['providers.models.experimental.confirm'] })).serverId;
        otherServerId = await account.addHome({ name: 'Other Provider Home', serverUrl: 'https://provider-settings-other.test', accountId: 'account-a', active: false });
    });
    afterEach(async () => { expect(rpc.state.requests).toEqual([]); standardCleanup(); await account.reset(); rpc.reset(); });

    it('keeps authoring pending until the confirmed selection is committed', async () => {
        confirmSpy.mockResolvedValueOnce(true);
        const mutationResult = createDeferred<void>();
        account.interceptCatalogMutation(async (_input, next) => { await mutationResult.promise; return next(); });
        const refresh = vi.fn(async () => {});
        const commitSelection = vi.fn();
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            refresh,
        }));

        await admittedClient();
        let confirmationResult: Promise<boolean> | null = null;
        await act(async () => {
            confirmationResult = hook.getCurrent().confirm(confirmation, commitSelection);
            await Promise.resolve();
        });

        await waitForHomeGovernance(() => expect(account.catalogMutations).toHaveLength(1));
        expect(hook.getCurrent().pending).toBe(true);
        expect(commitSelection).not.toHaveBeenCalled();

        await act(async () => {
            mutationResult.resolve();
            await confirmationResult;
        });

        expect(commitSelection).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledOnce();
        expect(hook.getCurrent().pending).toBe(false);
        expect(account.readCatalogRow()?.revision).toBe(2);
        expect(persistedConfirmation()).toMatchObject([{ connectionId: confirmation.connectionId,
            agentTargetKey: confirmation.agentTargetKey, modelId: confirmation.modelId,
            compatibilityFingerprint: confirmation.compatibilityFingerprint }]);
    });

    it('does not mutate the old machine after the scope changes while confirmation is open', async () => {
        const modalResult = createDeferred<boolean>();
        confirmSpy.mockReturnValueOnce(modalResult.promise);
        const refresh = vi.fn(async () => {});
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(
            (props: { machineId: string; serverId: string }) => useConfirmExperimentalProviderModel({
                enabled: true,
                machineId: props.machineId,
                serverId: props.serverId,
                agentTargetKey: 'agent:happier.agent.codex/codex',
                refresh,
            }),
            { initialProps: { machineId: 'machine-a', serverId } },
        );

        let pending!: Promise<boolean>;
        act(() => {
            pending = hook.getCurrent().confirm(confirmation, commitSelectionSpy);
        });
        await hook.rerender({ machineId: 'machine-b', serverId: otherServerId });
        await act(async () => modalResult.resolve(true));

        await expect(pending).resolves.toBe(false);
        expect(account.catalogMutations).toEqual([]);
        expect(refresh).not.toHaveBeenCalled();
    });

    it('does not dispatch Account A confirmation after Account B mounts with identical routing ids', async () => {
        const modalResult = createDeferred<boolean>();
        confirmSpy.mockReturnValueOnce(modalResult.promise);
        const refresh = vi.fn(async () => {});
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            refresh,
        }));

        let pending!: Promise<boolean>;
        act(() => { pending = hook.getCurrent().confirm(confirmation, commitSelectionSpy); });
        await act(async () => {
            await account.restore({ accountId: 'account-b' });
            await hook.rerender();
        });
        await act(async () => modalResult.resolve(true));

        await expect(pending).resolves.toBe(false);
        expect(account.catalogMutations).toEqual([]);
        expect(refresh).not.toHaveBeenCalled();
        expect(commitSelectionSpy).not.toHaveBeenCalled();
        expect(hook.getCurrent().pending).toBe(false);
    });

    it('does not mutate after the exact Agent target scope changes while confirmation is open', async () => {
        const modalResult = createDeferred<boolean>();
        confirmSpy.mockReturnValueOnce(modalResult.promise);
        const refresh = vi.fn(async () => {});
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(
            (props: { agentTargetKey: string }) => useConfirmExperimentalProviderModel({
                enabled: true,
                machineId: 'machine-a',
                serverId,
                agentTargetKey: props.agentTargetKey,
                refresh,
            }),
            { initialProps: { agentTargetKey: 'agent:happier.agent.codex/codex' } },
        );

        let pending!: Promise<boolean>;
        act(() => {
            pending = hook.getCurrent().confirm(confirmation, commitSelectionSpy);
        });
        await hook.rerender({ agentTargetKey: 'agent:happier.agent.claude/claude' });
        await act(async () => modalResult.resolve(true));

        await expect(pending).resolves.toBe(false);
        expect(account.catalogMutations).toEqual([]);
        expect(refresh).not.toHaveBeenCalled();
    });

    it('does not mutate after the Providers feature is disabled while confirmation is open', async () => {
        const modalResult = createDeferred<boolean>();
        confirmSpy.mockReturnValueOnce(modalResult.promise);
        const refresh = vi.fn(async () => {});
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(
            (props: { enabled: boolean }) => useConfirmExperimentalProviderModel({
                enabled: props.enabled,
                machineId: 'machine-a',
                serverId,
                agentTargetKey: 'agent:happier.agent.codex/codex',
                refresh,
            }),
            { initialProps: { enabled: true } },
        );

        let pending!: Promise<boolean>;
        act(() => {
            pending = hook.getCurrent().confirm(confirmation, commitSelectionSpy);
        });
        await hook.rerender({ enabled: false });
        await act(async () => modalResult.resolve(true));

        await expect(pending).resolves.toBe(false);
        expect(account.catalogMutations).toEqual([]);
        expect(refresh).not.toHaveBeenCalled();
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().retry).toBeNull();
    });

    it('does not refresh or select the old scope after an in-flight mutation crosses a scope change', async () => {
        confirmSpy.mockResolvedValueOnce(true);
        const mutationResult = createDeferred<void>();
        account.interceptCatalogMutation(async (_input, next) => { await mutationResult.promise; return next(); });
        const refresh = vi.fn(async () => {});
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(
            (props: { machineId: string; serverId: string }) => useConfirmExperimentalProviderModel({
                enabled: true,
                machineId: props.machineId,
                serverId: props.serverId,
                agentTargetKey: 'agent:happier.agent.codex/codex',
                refresh,
            }),
            { initialProps: { machineId: 'machine-a', serverId } },
        );

        await admittedClient();
        let pending!: Promise<boolean>;
        act(() => {
            pending = hook.getCurrent().confirm(confirmation, commitSelectionSpy);
        });
        await waitForHomeGovernance(() => expect(account.catalogMutations).toHaveLength(1));
        await hook.rerender({ machineId: 'machine-b', serverId: otherServerId });
        await act(async () => mutationResult.resolve());

        await expect(pending).resolves.toBe(false);
        expect(refresh).not.toHaveBeenCalled();
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('exposes a typed Account CAS conflict for review without replaying confirmation', async () => {
        confirmSpy.mockResolvedValueOnce(true);
        const expectedError = createProviderErrorV1('provider_connection_changed', {
            connectionId: confirmation.connectionId,
            machineId: 'machine-a',
        });
        account.interceptCatalogMutation(() => ({ status: 409, body: { status: 'conflict', revision: 2 } }));
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            refresh: vi.fn(async () => {}),
        }));

        await admittedClient();
        await act(async () => {
            await expect(hook.getCurrent().confirm(confirmation, commitSelectionSpy)).resolves.toBe(false);
        });

        expect(hook.getCurrent().error).toEqual(expectedError);
        expect(hook.getCurrent().retry).toBeNull();
        expect(account.catalogMutations).toHaveLength(1);
        expect(account.readCatalogRow()?.revision).toBe(1);
        expect(persistedConfirmation()).toEqual([]);
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('reconciles a commit-then-reject outcome and never exposes the stored mutation for replay', async () => {
        confirmSpy.mockResolvedValueOnce(true);
        account.interceptCatalogMutation((_input, next) => { next(); return { dispatchThenFail: true }; });
        const refresh = vi.fn(async () => {});
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            refresh,
        }));

        await admittedClient();
        await act(async () => {
            await expect(hook.getCurrent().confirm(confirmation, commitSelectionSpy)).resolves.toBe(false);
        });
        expect(hook.getCurrent().error).toEqual(createProviderErrorV1('provider_rpc_mutation_outcome_unknown', {
            connectionId: confirmation.connectionId,
            machineId: 'machine-a',
        }));
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(account.catalogMutations).toHaveLength(1);
        expect(account.readCatalogRow()?.revision).toBe(2);
        expect(persistedConfirmation()).toMatchObject([{ connectionId: confirmation.connectionId,
            compatibilityFingerprint: confirmation.compatibilityFingerprint }]);
        expect(refresh).toHaveBeenCalledOnce();
        expect(commitSelectionSpy).not.toHaveBeenCalled();
        expect(hook.getCurrent().error?.action).toBe('review_current_state');
        expect(hook.getCurrent().retry).toBeNull();
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('does not repeat a successful confirmation mutation when only the presentation refresh fails', async () => {
        confirmSpy.mockResolvedValueOnce(true);
        const refresh = vi.fn(async () => { throw new Error('refresh failed'); });
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            refresh,
        }));

        await admittedClient();
        await act(async () => {
            await expect(hook.getCurrent().confirm(confirmation, commitSelectionSpy)).resolves.toBe(true);
        });

        expect(account.catalogMutations).toHaveLength(1);
        expect(refresh).toHaveBeenCalledOnce();
        expect(commitSelectionSpy).toHaveBeenCalledOnce();
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().retry).toBeNull();
    });

    it('refuses a captured retry after the machine/server scope changes', async () => {
        confirmSpy.mockResolvedValueOnce(true);
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(
            (props: { machineId: string; serverId: string }) => useConfirmExperimentalProviderModel({
                enabled: true,
                machineId: props.machineId,
                serverId: props.serverId,
                agentTargetKey: 'agent:happier.agent.codex/codex',
                refresh: vi.fn(async () => {}),
            }),
            { initialProps: { machineId: 'machine-a', serverId } },
        );
        const client = await admittedClient();
        await act(async () => { await withdrawCredentials(); });
        await waitForHomeGovernance(() => expect(client.getCurrent().ready).toBe(false));
        await act(async () => {
            await hook.getCurrent().confirm(confirmation, commitSelectionSpy);
        });
        const capturedRetry = hook.getCurrent().retry;
        expect(capturedRetry).toBeTypeOf('function');

        await hook.rerender({ machineId: 'machine-b', serverId: otherServerId });
        await act(async () => {
            await expect(capturedRetry?.()).resolves.toBe(false);
        });

        expect(account.catalogMutations).toEqual([]);
    });

    it('clears a previous failure when a new confirmation attempt is cancelled', async () => {
        confirmSpy.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            refresh: vi.fn(async () => {}),
        }));
        const client = await admittedClient();
        await act(async () => { await withdrawCredentials(); });
        await waitForHomeGovernance(() => expect(client.getCurrent().ready).toBe(false));
        await act(async () => { await hook.getCurrent().confirm(confirmation, commitSelectionSpy); });
        expect(hook.getCurrent().error).not.toBeNull();

        await act(async () => { await hook.getCurrent().confirm(confirmation, commitSelectionSpy); });

        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().retry).toBeNull();
        expect(account.catalogMutations).toEqual([]);
    });
});
