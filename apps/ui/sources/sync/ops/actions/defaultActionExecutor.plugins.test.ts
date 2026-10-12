import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExternalActionMachineBootstrapV1Schema, ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { PluginAccountAvailabilityIntentReadResponseV1Schema } from '@happier-dev/protocol/plugins/availability';
import { PluginAccountSettingsMutationRequestV1Schema } from '@happier-dev/protocol/plugins/settings/accountSettingsV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createDeferred, renderHook } from '@/dev/testkit';

// Only HTTP, credentials and the disconnected socket boundary are replaced.
// Account capture, encryption, Action policy and root delivery remain real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { scopedHomeActionExecutor, resetScopedHomeActionExecutorsForTests } = await import('./scopedHomeActionExecutor');
const { scopedPluginSettingsAdapter } = await import('@/sync/domains/plugins/settings/scopedPluginSettingsRuntime');
const { useScopedPluginSettingsProjection } = await import('@/sync/domains/plugins/settings/scopedPluginSettingsProjection');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
beforeEach(async () => {
    resetScopedHomeActionExecutorsForTests();
    await homes.reset();
    await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Plugin Home', serverUrl: 'https://plugin-actions.test', serverIdentityId: 'srv_plugin_home', accountId: 'owner', currentAccount: true });
    homes.answer(serverId, '/v1/machines', { body: ['admitted', 'other'].map(id => ExternalActionMachineBootstrapV1Schema.parse({
        id, kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
        installationId: `${id}-installation`, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, runnerContentKeyBinding: null,
        access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
    })) });
    homes.answer(serverId, '/v1/actions/plugins.list', { select: body => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(body);
        return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'plugins.list', requestId: request.requestId,
            execution: { ok: true, result: { ok: true, kind: 'plugins_list', plugins: [{ id: 'daemon-owned' }] } },
        }) };
    } });
});
afterEach(async () => {
    await connection?.dispose();
    connection = null;
    await homes.reset();
});

describe('plugin-management Actions in the UI host', () => {
    it.each(['approval', 'encryption', 'unchanged', 'terminal-retirement'] as const)('keeps the actual UI Settings approval waiter on its captured field intent (change=%s)', async changeAt => {
        const changeIntent = changeAt !== 'unchanged';
        const home = homes.findByServerUrl('https://plugin-actions.test');
        if (!home?.token) throw new Error('Expected authenticated Home');
        if (changeAt === 'terminal-retirement') {
            // Same structural credential-store boundary vector as the UI
            // approval-origin suite; real credential authority stays active.
            home.token = `e30.${btoa(JSON.stringify({ sub: 'owner', session: 'terminal-test', provenance: {
                v: 2, kind: 'terminal', authority: 'account_automation',
                evidence: [{ kind: 'home_method', methodId: 'key_challenge' }],
            } }))}.signature`;
        }
        connection = await restoreServerAccountForTest({ serverUrl: home.serverUrl, serverIdentityId: 'srv_plugin_home', accountId: 'owner',
            credentials: { token: home.token }, request: homes.request });
        serverId = connection.home.id;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime?.isCurrent()) throw new Error('Expected real current Account lifetime');
        await homes.requireUiApproval(serverId, 'plugins.settings.set');
        homes.answer(serverId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, actions: { 'plugins.settings.set': { approvalRequiredSurfaces: ['ui'] } } },
        } } } });
        const pluginId = 'acme.settings';
        const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
            hostingCapability: { enabled: false },
            intent: { pluginId, desiredVersion: '1.0.0', enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: 'intent-1' },
            release: { ref: { pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                normalizedManifest: { schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Settings',
                    engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: { settings: [{ id: 'preferences', title: 'Preferences',
                        scope: 'account', target: { kind: 'plugin' }, fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' } }] }] } },
                collectionContracts: [], uiSlots: [], packageAssetArchive: { archiveDigestSha256: `sha256:${'c'.repeat(64)}`, resources: [] } },
            packageAssets: [], uiArtifacts: [],
        });
        replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: { availabilityCursor: 1,
            intentReads: [{ pluginId, response }], materializations: [], snapshots: [], inventoryComplete: true } });
        let revision = 7;
        let values: Readonly<Record<string, unknown>> = { enabled: false };
        let observeEffectReads = false;
        let effectReads = 0;
        let holdNextModeRead = false;
        let modeReadPending = false;
        const releaseModeRead = createDeferred<void>();
        const path = `/v1/account/plugin-settings/${pluginId}`;
        homes.answer(serverId, `GET ${path}`, { select: () => {
            // The second effect read is the incumbent read-before-CAS merge.
            // Its next mode fetch is a genuine awaited boundary before POST.
            if (observeEffectReads && ++effectReads === 2) holdNextModeRead = true;
            return { body: { status: 'present', revision, content: { t: 'plain', v: { v: 1, values } } } };
        } });
        homes.answer(serverId, `POST ${path}`, { select: input => {
            const mutation = PluginAccountSettingsMutationRequestV1Schema.parse(input);
            if (mutation.expectedRevision !== revision) return { body: { status: 'conflict', revision } };
            if (mutation.content?.t !== 'plain') throw new Error('Expected Plain Account Settings');
            values = mutation.content.v.values;
            return { body: { status: 'updated', revision: ++revision } };
        } });
        const target = { kind: 'account' as const, serverIdentityId: 'srv_plugin_home' };
        const fields = [{ key: 'enabled', redacted: false }];
        const projection = await renderHook(({ sourceLifetimeIdentity }: { sourceLifetimeIdentity: string }) =>
            useScopedPluginSettingsProjection({ pluginId, target, scope: { kind: 'account' }, fields,
                enabled: true, adapter: scopedPluginSettingsAdapter, accountLifetime: lifetime,
                perActiveServerIdentityId: null, sourceLifetimeIdentity }),
        { initialProps: { sourceLifetimeIdentity: 'declaration-a' } });
        await waitForHomeGovernance(() => expect(projection.getCurrent().state.revision).toEqual({ kind: 'account', value: 7 }));
        let returned = false;
        const pending = projection.getCurrent().commit({ fieldId: 'enabled', mutation: { kind: 'set', value: true } })
            .then(result => { returned = true; return result; });
        const observed = await waitForHomeGovernance(async () => {
            if (returned) return { kind: 'returned' as const, outcome: await pending };
            const artifact = homes.artifacts(serverId).list().find(row => ApprovalRequestSchema.safeParse(
                JSON.parse(homes.artifacts(serverId).readPlainBody(row.id) ?? 'null')).success);
            expect(artifact).toBeDefined();
            return { kind: 'approval' as const, artifactId: artifact!.id };
        });
        if (observed.kind === 'returned') {
            // Distinguish a real eligible storage bypass from a fixture or
            // declaration refusal before blaming missing approval ingress.
            expect(['ready', 'applied']).toContain(observed.outcome?.status);
            expect(values).toEqual({ enabled: true });
            expect(homes.requestsFor(path).some(request =>
                PluginAccountSettingsMutationRequestV1Schema.safeParse(request.input).success)).toBe(true);
        }
        expect(observed.kind).toBe('approval');
        if (observed.kind !== 'approval') throw new Error('Settings bypassed the real UI approval owner');
        expect(values).toEqual({ enabled: false });
        expect(JSON.parse(homes.artifacts(serverId).readPlainBody(observed.artifactId) ?? 'null')).toMatchObject({
            approval: { flow: 'blocking' }, executionOriginV1: {
                authority: changeAt === 'terminal-retirement' ? 'account_automation' : 'present_user',
                surface: 'ui', caller: { kind: 'host' } },
        });
        if (changeAt === 'terminal-retirement') {
            expect(await createDefaultActionExecutor().execute('approval.request.decide',
                { artifactId: observed.artifactId, decision: 'approve' }, { serverId }))
                .toMatchObject({ ok: false, errorCode: 'present_user_required' });
            await connection?.dispose();
            connection = null;
            expect(await pending).toMatchObject({ status: 'unavailable' });
            expect(values).toEqual({ enabled: false });
            expect(revision).toBe(7);
            await projection.unmount();
            return;
        }
        if (changeAt === 'approval') await projection.rerender({ sourceLifetimeIdentity: 'declaration-b' });
        if (changeAt === 'encryption') {
            observeEffectReads = true;
            homes.answer(serverId, '/v1/account/encryption', { select: () => {
                if (!holdNextModeRead) return { body: { mode: 'plain', updatedAt: 1 } };
                holdNextModeRead = false;
                modeReadPending = true;
                return { body: { mode: 'plain', updatedAt: 1 }, respondAfter: releaseModeRead.promise };
            } });
        }
        const decision = createDefaultActionExecutor().execute('approval.request.decide', { artifactId: observed.artifactId, decision: 'approve' }, { serverId });
        if (changeAt === 'encryption') {
            await waitForHomeGovernance(() => expect(modeReadPending).toBe(true));
            await projection.rerender({ sourceLifetimeIdentity: 'declaration-b' });
            releaseModeRead.resolve();
        }
        expect(await decision)
            .toMatchObject({ ok: true });
        expect(await pending).toMatchObject({ status: changeIntent ? 'unavailable' : 'applied' });
        expect(values).toEqual({ enabled: !changeIntent });
        expect(revision).toBe(changeIntent ? 7 : 8);
        await projection.unmount();
    });
    const caller = { kind: 'plugin' as const, pluginId: 'happier.inspector', contributionLocalId: 'inspector', occurrenceId: 'occurrence-1',
        sourceCustody: { kind: 'development' as const, registeredRootId: 'inspector-root' },
        materialization: { machineId: 'admitted', materializationId: 'inspector-installation', pluginId: 'happier.inspector' } };
    it('executes plugins.list through root delivery against only the mount-admitted Machine', async () => {
        // Mounted Hosts use this scoped front door, not an unscoped executor.
        const result = await scopedHomeActionExecutor({ serverId, accountId: 'owner' })('plugins.list', {}, {
            serverId, expectedAccountId: 'owner', surface: 'plugin', actionCaller: caller,
            executionRunTargetMachineId: 'admitted', defaultSessionMachineId: 'other', actionRequestId: 'inspector-list',
        });
        expect(result).toEqual({ ok: true, result: { ok: true, kind: 'plugins_list', plugins: [{ id: 'daemon-owned' }] } });
        expect(homes.requestsFor('/v1/actions/plugins.list').map(record => record.input)).toEqual([
            { v: 1, requestId: 'inspector-list', target: { kind: 'machine', machineId: 'admitted' }, input: {},
                pluginInvocation: { kind: 'mountedPluginSurface', mountedBinding: {
                    pluginId: caller.pluginId, contributionLocalId: caller.contributionLocalId, occurrenceId: caller.occurrenceId,
                    sourceCustody: caller.sourceCustody, materializationRef: caller.materialization,
                } } },
        ]);
    });
    it('delegates Channels conversation targets through the same exact-Machine provenance carrier', async () => {
        const channelsCaller = { ...caller, pluginId: 'happier.channels', contributionLocalId: 'channels-app',
            materialization: { ...caller.materialization, pluginId: 'happier.channels' } };
        homes.answer(serverId, '/v1/actions/automation.conversation.targets.list', { select: body => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(body);
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'automation.conversation.targets.list',
                requestId: request.requestId, execution: { ok: true, result: { items: [], nextCursor: null } } }) };
        } });
        expect(await createDefaultActionExecutor().execute('automation.conversation.targets.list', {}, {
            serverId, expectedAccountId: 'owner', surface: 'plugin', actionCaller: channelsCaller,
            executionRunTargetMachineId: 'admitted', defaultSessionMachineId: 'other', actionRequestId: 'channels-targets',
        })).toEqual({ ok: true, result: { items: [], nextCursor: null } });
        expect(homes.requestsFor('/v1/actions/automation.conversation.targets.list').map(record => record.input)).toEqual([
            { v: 1, requestId: 'channels-targets', target: { kind: 'machine', machineId: 'admitted' }, input: {},
                pluginInvocation: { kind: 'mountedPluginSurface', mountedBinding: {
                    pluginId: channelsCaller.pluginId, contributionLocalId: channelsCaller.contributionLocalId,
                    occurrenceId: channelsCaller.occurrenceId, sourceCustody: channelsCaller.sourceCustody,
                    materializationRef: channelsCaller.materialization,
                } } },
        ]);
    });
    it('does not borrow a default Machine when the plugin mount has no admitted target', async () => {
        expect(await createDefaultActionExecutor().execute('plugins.list', {}, {
            serverId, expectedAccountId: 'owner', surface: 'plugin', actionCaller: caller, defaultSessionMachineId: 'other',
        })).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        expect(homes.requestsFor('/v1/actions/plugins.list')).toHaveLength(0);
    });
    it('returns the daemon stale-occurrence refusal unchanged to the mounted UI', async () => {
        homes.answer(serverId, '/v1/actions/plugins.list', { select: body => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(body);
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'plugins.list', requestId: request.requestId,
                execution: { ok: false, errorCode: 'plugin_mounted_caller_unavailable', error: 'plugin_mounted_caller_unavailable' },
            }) };
        } });
        expect(await createDefaultActionExecutor().execute('plugins.list', {}, {
            serverId, expectedAccountId: 'owner', surface: 'plugin', actionCaller: caller,
            executionRunTargetMachineId: 'admitted', actionRequestId: 'stale-inspector-list',
        })).toMatchObject({ ok: false, errorCode: 'plugin_mounted_caller_unavailable' });
    });
    it('retains plugin caller policy and approval custody before root delivery', async () => {
        const executor = createDefaultActionExecutor();
        const context = { serverId, expectedAccountId: 'owner', surface: 'plugin' as const,
            executionRunTargetMachineId: 'admitted', actionRequestId: 'inspector-reload' };
        expect(await executor.execute('plugins.reload', { pluginId: 'other.plugin' }, {
            ...context, actionCaller: caller,
        })).toMatchObject({ ok: false, errorCode: 'plugin_action_caller_forbidden' });
        const outcome = await executor.execute('plugins.reload', { pluginId: 'other.plugin' }, {
            ...context, actionCaller: { ...caller, contributionLocalId: 'inspector-app' },
        });
        if (!outcome.ok) throw new Error(JSON.stringify(outcome));
        const approval = ActionApprovalRequestCreatedResultSchema.parse(outcome.result);
        expect(JSON.parse(homes.artifacts(serverId).readPlainBody(approval.artifactId)!)).toMatchObject({
            actionId: 'plugins.reload', status: 'open',
            createdBy: { pluginId: caller.pluginId, contributionLocalId: 'inspector-app' },
        });
        expect(homes.requestsFor('/v1/actions/plugins.reload')).toHaveLength(0);
    });
});
