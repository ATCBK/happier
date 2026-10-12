import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { normalizePluginUiDestinationBindingV1, PluginUiDestinationBindingV1Schema } from '@happier-dev/protocol/plugins/ui';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { readPluginUiExecutionOriginCandidates, unionPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { usePluginMachineExecutionOriginSelection } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import { useActivePluginAccountAvailabilityReleaseClassifier } from '@/sync/domains/plugins/availability/projection';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storageStore';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { createPluginExecutionOriginActionDeps } from './pluginExecutionOriginActionDeps';

// This owner imports the real mounted hook before test-time Home restoration;
// install the canonical cold Socket transport before those static consumers.
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

const { URL: NodeURL } = getVitestNodeBuiltin<typeof import('node:url')>('node:url');
afterEach(async () => { await standardCleanup(); });

async function invokeUiPreference<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    let result!: TResult;
    await act(async () => { result = await operation(); });
    return result;
}

describe('answering-client plugin origin preferences', () => {
    it('uses real source admission and Account CAS, preserving siblings and rejecting retired choices', async () => {
        installDisconnectedServerSocketBoundary();
        const pluginId = 'acme.origin';
        let version = 1;
        let raw: Record<string, unknown> = { unrelated: { preserved: true }, machineAdministrationSelectionsV1: {
            v: 1, pluginExecutionOriginsByPluginId: { 'other.plugin': { serverIdentityId: 'srv_origin',
                sourceRef: { pluginId: 'other.plugin', machineId: 'machine', sourceCustody: { kind: 'development', registeredRootId: 'other' } } } },
        } };
        let withdrawBeforeMutation = false;
        let hasSource = true;
        let writes = 0;
        const requestPaths: string[] = [];
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'origin-account', encryptionMode: 'plain' });
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://origin-actions.example.test',
            serverIdentityId: 'srv_origin', accountId: 'origin-account', credentials: { token: `e30.${Buffer.from(JSON.stringify({
                sub: 'origin-account', provenance: { v: 1, kind: 'account', authority: 'present_user' }, tokenEpoch: 0,
            })).toString('base64url')}.signature` }, request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                requestPaths.push(path);
                if (path === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: 'machine', accountId: 'origin-account' })]);
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                const artifactResponse = artifacts.handle(path, init);
                if (artifactResponse) return await artifactResponse;
                if (path !== '/v2/account/settings') return null;
                if (init?.method === 'POST') {
                    const request = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
                    if (request.expectedVersion !== version) return Response.json({ success: false, error: 'version-mismatch',
                        currentVersion: version, currentContent: { t: 'plain', v: raw } });
                    if (request.content?.t !== 'plain') throw new Error('Plain Account must write plain settings');
                    raw = request.content.v; version++; writes++;
                    return Response.json({ success: true, version });
                }
                if (withdrawBeforeMutation) hasSource = false;
                return Response.json({ content: { t: 'plain', v: raw }, version });
            } });
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Account lifetime missing');
        const scope = lifetime.scope;
        // Home restoration precedes its fake clock, preserving the real admission's time.
        // Freeze only Date so cold Action imports cannot age the admitted Machine fixture.
        const admittedAtMs = Date.now();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(admittedAtMs);
        const machine = createMachineFixture({ id: 'machine', active: true, activeAt: Date.now() });
        storage.setState({ profileScope: scope, settingsScope: scope, settingsVersion: version, isDataReady: true,
            machines: { machine }, machineListByServerId: { [connection.home.id]: [machine] },
            machineListStatusByServerId: { [connection.home.id]: 'idle' },
            settings: { ...storage.getState().settings, machineAdministrationSelectionsV1: { v: 1, pluginExecutionOriginsByPluginId: {} } } });
        const binding = normalizePluginUiDestinationBindingV1({ pluginId, destinationId: 'home', rendererId: 'home',
            container: 'appPage', target: { kind: 'app' } });
        if (!binding) throw new Error('Destination fixture missing');
        const model = normalizePluginUiProjection({ v: 2, generation: 1, agentsById: {}, actionsById: {}, toolsById: {},
            commandsById: {}, resourcesById: {}, settingsById: {}, diagnostics: [], installedPackagesById: {
                [pluginId]: { id: pluginId, displayName: 'Source', version: '1.0.0', enabled: true,
                    source: { kind: 'localPath', locator: 'root' }, occurrenceId: 'occurrence',
                    sourceCustody: { kind: 'development', registeredRootId: 'root' } },
            }, familiesById: { pluginUi: { family: 'pluginUi', entriesById: { home: {
                id: 'home', pluginId, occurrenceId: 'occurrence', contributionKind: 'surfacePlacement', descriptorId: 'home',
                binding: PluginUiDestinationBindingV1Schema.parse(binding), target: binding.target,
                renderer: { kind: 'hostedHtml', contributionId: 'home', source: artifactHtmlBundleFromBodyV1('<p>Source</p>'), requiredHostMethods: ['context'] },
                display: {}, headerActions: [], availability: { state: 'available', reason: 'available', diagnostics: [] },
            } } } } });
        const projection = unionPluginUiProjections([{ machineId: machine.id, serverId: connection.home.id,
            serverIdentityId: 'srv_origin', phase: 'current', interactionEnabled: true, projection: model }]).pluginUiProjection;
        if (!projection) throw new Error('Source projection was not admitted');
        const unpublish = publishCommittedAppShellPluginUiProjection(() => hasSource ? projection : null);
        const bridge = await loadVitestModuleForNodeRequire(new NodeURL('../../sync.ts', import.meta.url), () => import('@/sync/sync'));
        const account = await captureLazyActionAccountContext(connection.home.id);
        const owner = createPluginExecutionOriginActionDeps(account).pluginExecutionOriginAction;
        if (!owner) throw new Error('Action owner missing');
        const invoke = (actionId: Parameters<typeof owner>[0]['actionId'], input: unknown) => owner({ actionId, input, context: { surface: 'ui' } });
        const origin = { serverIdentityId: 'srv_origin', sourceRef: { machineId: machine.id, pluginId,
            sourceCustody: { kind: 'development' as const, registeredRootId: 'root' } } };
        try {
            expect(await invoke('plugins.execution_origin.list', { pluginId })).toMatchObject({ status: 'available',
                settingsVersion: 1, candidates: [{ origin, version: '1.0.0', selectable: true }] });
            expect(await invoke('plugins.execution_origin.set', { pluginId, origin, expectedSettingsVersion: version }), JSON.stringify({
                requestPaths, scope, currentScope: storage.getState().settingsScope, lifetimeCurrent: lifetime.isCurrent(),
                machines: storage.getState().machines, machineListStatusByServerId: storage.getState().machineListStatusByServerId, hasSource,
            }))
                .toEqual({ status: 'applied', settingsVersion: 2 });
            expect(raw).toMatchObject({ unrelated: { preserved: true }, machineAdministrationSelectionsV1: {
                pluginExecutionOriginsByPluginId: { [pluginId]: origin, 'other.plugin': { sourceRef: { pluginId: 'other.plugin' } } },
            } });
            expect(await invoke('plugins.execution_origin.clear', { pluginId, expectedSettingsVersion: version }))
                .toEqual({ status: 'applied', settingsVersion: 3 });
            expect(raw).toMatchObject({ machineAdministrationSelectionsV1: { pluginExecutionOriginsByPluginId: { 'other.plugin': {} } } });
            expect(Object.hasOwn((raw.machineAdministrationSelectionsV1 as { pluginExecutionOriginsByPluginId: object }).pluginExecutionOriginsByPluginId, pluginId)).toBe(false);
            withdrawBeforeMutation = true;
            expect(await invoke('plugins.execution_origin.set', { pluginId, origin, expectedSettingsVersion: version })).toEqual({ status: 'unavailable' });
            expect(writes).toBe(2);
            withdrawBeforeMutation = false;
            hasSource = true;
            const hook = await renderHook(() => usePluginMachineExecutionOriginSelection({ pluginId,
                classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(),
                ...readPluginUiExecutionOriginCandidates({ pluginId, projection }),
                readSourceCandidates: () => readPluginUiExecutionOriginCandidates({ pluginId, projection: hasSource ? projection : null }).sourceCandidates,
            }));
            expect(await invokeUiPreference(() => hook.getCurrent().selectOrigin(origin))).toMatchObject({ status: 'applied', settingsVersion: 4 });
            expect(raw).toMatchObject({ unrelated: { preserved: true }, machineAdministrationSelectionsV1: {
                pluginExecutionOriginsByPluginId: { [pluginId]: origin, 'other.plugin': { sourceRef: { pluginId: 'other.plugin' } } },
            } });
            await hook.rerender();
            expect(await invokeUiPreference(() => hook.getCurrent().clearOrigin())).toMatchObject({ status: 'applied', settingsVersion: 5 });
            expect(raw).toMatchObject({ unrelated: { preserved: true }, machineAdministrationSelectionsV1: {
                pluginExecutionOriginsByPluginId: { 'other.plugin': { sourceRef: { pluginId: 'other.plugin' } } },
            } });
            expect(Object.hasOwn((raw.machineAdministrationSelectionsV1 as { pluginExecutionOriginsByPluginId: object }).pluginExecutionOriginsByPluginId, pluginId)).toBe(false);
            await hook.rerender();
            // Another settings writer advances storage after this picker captured its version.
            version++;
            expect(await invokeUiPreference(() => hook.getCurrent().selectOrigin(origin))).toEqual({ status: 'conflict', currentSettingsVersion: version });
            expect(writes).toBe(4);
            const installPolicy = (actions: Record<string, { disabledSurfaces?: readonly ['ui']; approvalRequiredSurfaces?: readonly ['ui'] }>) => {
                raw = { ...raw, actionsSettingsV1: { v: 1, actions } };
                version++;
                storage.getState().applySettingsForScope(scope, settingsParse(raw), version);
            };
            await act(async () => { installPolicy({ 'plugins.execution_origin.set': { disabledSurfaces: ['ui'] },
                'plugins.execution_origin.clear': { disabledSurfaces: ['ui'] } }); });
            await hook.rerender();
            expect(await invokeUiPreference(() => hook.getCurrent().selectOrigin(origin))).toMatchObject({ status: 'unavailable' });
            expect(await invokeUiPreference(() => hook.getCurrent().clearOrigin())).toMatchObject({ status: 'unavailable' });
            expect(writes).toBe(4);
            await act(async () => { installPolicy({ 'plugins.execution_origin.set': { approvalRequiredSurfaces: ['ui'] } }); });
            await hook.rerender();
            const pending = await invokeUiPreference(() => hook.getCurrent().selectOrigin(origin));
            expect(pending).toMatchObject({ status: 'approvalPending' });
            expect(writes).toBe(4);
            const created = artifacts.list().map(row => ({ id: row.id,
                request: ApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(row.id) ?? 'null')) }))
                .find(({ request }) => request.actionId === 'plugins.execution_origin.set');
            expect(created?.request).toMatchObject({ status: 'open', actionArgs: { pluginId, origin, expectedSettingsVersion: version } });
            if (!created) throw new Error('Preference approval missing');
            const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
            expect(await invokeUiPreference(() => createDefaultActionExecutor().execute('approval.request.decide', {
                artifactId: created.id, decision: 'approve',
            }, { surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId })))
                .toMatchObject({ ok: true, result: { status: 'executed' } });
            expect(writes).toBe(5);
            expect(raw).toMatchObject({ machineAdministrationSelectionsV1: { pluginExecutionOriginsByPluginId: { [pluginId]: origin } } });
            const capturedUiSelection = hook.getCurrent().selectOrigin;
            await hook.unmount();
            retireActiveServerAccountScopeLifetime();
            expect(captureActiveServerAccountScopeLifetime()?.scope).toEqual(scope);
            const approvalsBeforeStaleCallback = artifacts.list().length;
            expect(await capturedUiSelection(origin)).toEqual({ status: 'unavailable' });
            expect(artifacts.list()).toHaveLength(approvalsBeforeStaleCallback);
            await expect(invoke('plugins.execution_origin.clear', { pluginId, expectedSettingsVersion: version })).rejects.toMatchObject({ code: 'action_account_scope_changed' });
            expect(writes).toBe(5);
        } finally { account.dispose(); bridge.dispose(); unpublish(); await connection.dispose(); }
    });
});
