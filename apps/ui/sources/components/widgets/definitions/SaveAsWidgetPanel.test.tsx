import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import * as uuidBoundary from '@/platform/randomUUID';
import { createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1, SessionOwnerMetadataV1Schema,
    SessionSystemRecordStoredSchema, tryWriteServerEnabledBitInPlace, decodePlainArtifactStoredContent, normalizeActionsSettingsV1 } from '@happier-dev/protocol';
import { readBuiltinWidgetDescriptorV1, WidgetInstanceActionOutputSchemasV1, type WidgetInputBindingsV1 } from '@happier-dev/protocol/widgets';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// This Home serves writes: deliver the Socket boundary's real connected event
// so scoped Actions retain the connection owner's admitted HTTP authority.
installDisconnectedServerSocketBoundary(socket => {
    socket.connect = vi.fn<typeof socket.connect>(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
});
await loadSyncSingletonForTests();
const { SaveAsWidgetPanel } = await import('./SaveAsWidgetPanel');
const { useWidgetDefinitionFlows } = await import('./useWidgetDefinitionFlows');
const { WidgetSetupStep } = await import('../add/WidgetSetupStep');
const { Switch } = await import('@/components/ui/forms/Switch');
const { t } = await import('@/text');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
let restoreUuid: (() => void) | null = null;

async function connectDefinitionHome(serverUrl: string) {
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl);
    if (!credentials) throw new Error('Expected signed-in test Home');
    await restoreConnectionToActiveServer(credentials);
    return { disconnect: disconnectActiveServerConnection, credentials };
}

describe('Save as widget placement', () => {
    beforeEach(async () => {
        await harness.reset();
        // Restoring a mounted Home also probes readiness through the raw fetch
        // boundary, below the scoped HTTP leaves installed by this harness.
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(harness.request);
    });
    afterEach(async () => {
        standardCleanup(); restoreUuid?.(); restoreUuid = null;
        const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        resetRuntimeFetch();
    });

    it.each(['placed', 'savePending', 'placementPending', 'placementRefused', 'builtinPlaced'] as const)(
        'promotes Session Add-to before setup placement and preserves %s outcomes', async outcome => {
        const accountId = 'owner';
        const sessionId = 'source';
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://session-add.example',
            publicServerUrl: 'https://session-add.example', serverIdentityId: 'srv_session_add', accountId });
        const { storage } = await import('@/sync/domains/state/storage');
        const { SessionSurfaceItemV1Schema } = await import('@happier-dev/protocol/sessions/board');
        const { WidgetDefinitionV1Schema } = await import('@happier-dev/protocol/widgets');
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
        const { View, Pressable } = await import('react-native');
        const { t } = await import('@/text');
        const account = { serverId, accountId };
        storage.setState({ profileScope: account, settingsScope: account });
        const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: 'srv_session_add' } } });
        if (!tryWriteServerEnabledBitInPlace(features, 'sessions.board', true)) throw new Error('Missing Board feature');
        harness.answer(serverId, '/v1/features', { body: features });
        harness.answer(serverId, '/v1/features/authenticated', { body: features });
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        const fixture = createSessionFixture({ id: sessionId, serverId, encryptionMode: 'plain' });
        storage.getState().applySessions([fixture]);
        const metadata = { path: '/work/project', machineId: 'machine' };
        harness.answer(serverId, `/v2/sessions/${sessionId}?accessProjectionVersion=1`, { body: { session: {
            id: sessionId, createdAt: 1, updatedAt: 1, seq: 1, active: false, activeAt: 1,
            encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 1, metadataVersion: 1,
            metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata, agentState: null })),
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(SessionOwnerMetadataV1Schema.parse({ v: 1, workspace: metadata })),
            agentStateVersion: 1, agentState: null, share: null, responsibleAccountId: null, responsibleAccount: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: fixture.access!.capabilities },
        } } });
        harness.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0,
        } });
        harness.answer(serverId, '/v1/auth/ping', { body: { success: true } });
        const { disconnect, credentials } = await connectDefinitionHome('https://session-add.example');
        const nativeDefinition = { kind: 'builtin', id: 'usage_daily' } as const;
        const native = readBuiltinWidgetDescriptorV1(nativeDefinition)!;
        const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'session-definition', name: 'Copied checks',
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [] },
            inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } },
            body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Original checks' } } },
            ...(outcome === 'placementPending' ? { networkOverride: { network: 'none' } } : {}),
            ...(outcome === 'builtinPlaced' ? { name: 'Copied daily usage', body: nativeDefinition,
                sizeDeclaration: native.sizeDeclaration, inputs: native.inputs, inputSchema: native.inputSchema } : {}) });
        const bindings: WidgetInputBindingsV1 = outcome === 'builtinPlaced' ? {
            period: { kind: 'value', value: { relative: 'today' } }, metric: { kind: 'value', value: 'tokens' },
            costBasis: { kind: 'value', value: 'auto' }, session: { kind: 'value', value: sessionId },
            agents: { kind: 'value', value: [] }, machines: { kind: 'value', value: [] },
            sources: { kind: 'value', value: [] }, projects: { kind: 'value', value: [] },
        } : {};
        const instance = { v: 1 as const, id: 'source-item', definition: outcome === 'builtinPlaced'
            ? nativeDefinition : { kind: 'inline' as const, definition }, bindings };
        const item = SessionSurfaceItemV1Schema.parse({ v: 1, title: definition.name, frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'widget', instance } });
        const record = SessionSystemRecordStoredSchema.parse({ id: 'source-item',
            address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'source-item' }, content: { t: 'plain', v: item },
            revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' });
        harness.answer(serverId, `/v2/sessions/${sessionId}/system-records/record?owner=host&namespace=surface&kind=layout.v1&localId=layout`, { body: { record: null } });
        harness.answer(serverId, `/v2/sessions/${sessionId}/system-records/record?owner=host&namespace=surface&kind=item.v1&localId=source-item`, { body: { record } });
        if (outcome === 'savePending') await harness.requireUiApproval(serverId, 'widgets.definition.saveFromSession');
        if (outcome === 'placementPending') await harness.requireUiApproval(serverId, 'widgets.item.add');
        const settings = { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({
            ...storage.getState().settings.actionsSettingsV1,
            approvalWaivedSurfaces: outcome === 'savePending' ? { 'widgets.item.add': ['ui'] }
                : outcome === 'placementPending' ? { 'widgets.definition.saveFromSession': ['ui'] }
                : { 'widgets.definition.saveFromSession': ['ui'], 'widgets.item.add': ['ui'] },
            ...(outcome === 'placementRefused' ? { actions: { 'widgets.item.add': { enabled: false } } } : {}),
        }) };
        const settingsScope = storage.getState().settingsScope;
        if (settingsScope?.accountId !== accountId) throw new Error('Expected the restored owner Account settings scope');
        storage.getState().applySettingsForScope(settingsScope, settings, 2);
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 2 } });
        function Card() {
            const flows = useWidgetDefinitionFlows({ instance, scope: { ...account, owner: { kind: 'sessionBoard', sessionId } },
                sessionItem: { itemId: instance.id, title: definition.name, savable: true, canEdit: true, converted: [], sourceLabel: definition.name },
                anchorRef: React.useRef(null), testID: 'sessionAdd' });
            return <View><Pressable testID="openAdd" onPress={flows.addTo} />{flows.panel}</View>;
        }
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><Card /></InjectedAuthProvider>);
        try {
            await screen.pressByTestIdAsync('openAdd');
            await screen.pressByTestIdAsync('sessionAdd.addTo.destination.home');
            const setup = screen.tree.root.findByType(WidgetSetupStep).props.setup;
            let result: Awaited<ReturnType<typeof setup.submit>>;
            await act(async () => { result = await setup.submit(setup.initial); });
            const saved = harness.artifacts(serverId).list().filter(row => Reflect.get(decodePlainArtifactStoredContent(row.header) as object, 'kind') === 'widget-definition.v1');
            if (outcome === 'savePending') {
                expect(saved).toHaveLength(0);
                expect(result!).toEqual({ ok: true, approvalPending: true });
                const approvals = harness.artifacts(serverId).list().map(row => harness.artifacts(serverId).readPlainBody(row.id)).filter(Boolean).map(body => JSON.parse(body!));
                expect(approvals).toEqual(expect.arrayContaining([expect.objectContaining({ actionId: 'widgets.definition.saveFromSession' })]));
                expect(approvals.some(row => row.actionId === 'widgets.item.add')).toBe(false);
                return;
            }
            expect(saved).toHaveLength(1);
            expect(JSON.parse(harness.artifacts(serverId).readPlainBody(saved[0]!.id)!)).toMatchObject({
                body: definition.body, provenance: { source: { kind: 'session', serverId, sessionId, itemId: instance.id } },
            });
            if (outcome === 'placementRefused') {
                expect(result!).toEqual({ ok: false, message: t('widgetDefinition.savedButNotPlaced') });
                await act(async () => { await setup.submit(setup.initial); });
                expect(harness.artifacts(serverId).list().filter(row => Reflect.get(decodePlainArtifactStoredContent(row.header) as object, 'kind') === 'widget-definition.v1')).toHaveLength(1);
            } else if (outcome === 'placementPending') {
                expect(result!).toEqual({ ok: true, approvalPending: true });
                const approvals = harness.artifacts(serverId).list().map(row => harness.artifacts(serverId).readPlainBody(row.id)).filter(Boolean).map(body => JSON.parse(body!));
                expect(approvals).toEqual(expect.arrayContaining([expect.objectContaining({ actionId: 'widgets.item.add', actionArgs: expect.objectContaining({
                    instance: expect.objectContaining({ definition: { kind: 'artifact', artifactId: saved[0]!.id }, networkOverride: { network: 'none' } }),
                }) })]));
                const pendingResult = result!;
                if (!pendingResult.ok) throw new Error('Expected pending placement');
                await act(async () => { screen.tree.root.findByType(WidgetSetupStep).props.onDone(pendingResult); });
                expect(readPresentationNotice()?.message).toContain(t('widgetDefinition.savedButNotPlaced'));
            } else {
                const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                expect(result!).toEqual({ ok: true });
                const listed = await createDefaultActionExecutor().execute('widgets.item.list', { surface: { ...account, owner: { kind: 'home' } } },
                    { serverId, surface: 'ui', authority: 'present_user' });
                expect(listed.ok).toBe(true);
                if (!listed.ok) throw new Error('Expected the placed Home widgets to be readable');
                const home = WidgetInstanceActionOutputSchemasV1['widgets.item.list'].parse(listed.result);
                const copies = home.instances.filter(({ instance: placed }) => placed.definition.kind === 'artifact'
                    && placed.definition.artifactId === saved[0]!.id);
                expect(copies).toHaveLength(1);
                expect(copies[0]!.instance.bindings).toEqual(bindings);
            }
        } finally { await screen.unmount(); await disconnect(); retirePresentationNotice(); }
    });

    it('retains the promoted copy and visibly waits when Home placement requires approval', async () => {
        const accountId = 'owner';
        const sessionId = 'source';
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://copy-placement.example',
            publicServerUrl: 'https://copy-placement.example', serverIdentityId: 'srv_copy_placement', accountId });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ profileScope: { serverId, accountId }, settingsScope: { serverId, accountId } });
        const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: 'srv_copy_placement' } } });
        if (!tryWriteServerEnabledBitInPlace(features, 'sessions.board', true)) throw new Error('Missing Board feature');
        harness.answer(serverId, '/v1/features', { body: features });
        harness.answer(serverId, '/v1/features/authenticated', { body: features });
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        const fixture = createSessionFixture({ id: sessionId });
        const metadata = { path: '/work/project', machineId: 'machine' };
        harness.answer(serverId, `/v2/sessions/${sessionId}?accessProjectionVersion=1`, { body: { session: {
            id: sessionId, createdAt: 1, updatedAt: 1, seq: 1, active: false, activeAt: 1,
            encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 1, metadataVersion: 1,
            metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata, agentState: null })),
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(SessionOwnerMetadataV1Schema.parse({ v: 1, workspace: metadata })),
            agentStateVersion: 1, agentState: null, share: null, responsibleAccountId: null, responsibleAccount: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: fixture.access!.capabilities },
        } } });
        harness.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0,
        } });
        harness.answer(serverId, '/v1/auth/ping', { body: { success: true } });
        const { disconnect, credentials } = await connectDefinitionHome('https://copy-placement.example');
        const item = { v: 1, title: 'Copy', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Original' } } } };
        const record = SessionSystemRecordStoredSchema.parse({ id: 'source-item',
            address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'source-item' }, content: { t: 'plain', v: item },
            revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' });
        harness.answer(serverId, `/v2/sessions/${sessionId}/system-records/record?owner=host&namespace=surface&kind=layout.v1&localId=layout`, { body: { record: null } });
        harness.answer(serverId, `/v2/sessions/${sessionId}/system-records/record?owner=host&namespace=surface&kind=item.v1&localId=source-item`, { body: { record } });
        await harness.requireUiApproval(serverId, 'widgets.item.add');
        // Promotion is acknowledged under the person's saved waiver; placement still requires approval.
        const settings = { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({
            ...storage.getState().settings.actionsSettingsV1,
            approvalWaivedSurfaces: { 'widgets.definition.saveFromSession': ['ui'] },
        }) };
        const settingsScope = storage.getState().settingsScope;
        if (settingsScope?.accountId !== accountId) throw new Error('Expected the restored owner Account settings scope');
        storage.getState().applySettingsForScope(settingsScope, settings, 2);
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 2 } });
        let done = 0;
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><SaveAsWidgetPanel account={{ serverId, accountId }} session={{ serverId, sessionId }}
            itemId="source-item" defaultName="Copy" converted={[]} onCancel={() => {}} onDone={() => { done += 1; }} testID="promote" /></InjectedAuthProvider>);
        try {
            const destination = screen.findByTestId('promote.destination.home')!;
            const changeDestination = destination.findByType(Switch).props.onValueChange;
            if (typeof changeDestination !== 'function') throw new Error('Home destination must expose its toggle');
            await act(async () => { changeDestination(true); });
            const uuid = vi.spyOn(uuidBoundary, 'randomUUID').mockImplementationOnce(() => { throw new Error('UUID unavailable'); });
            restoreUuid = () => uuid.mockRestore();
            await screen.pressByTestIdAsync('promote.primary');
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('widgetDefinition.saveFailed')));
            expect(harness.artifacts(serverId).list()).toHaveLength(0);
            uuid.mockRestore();
            await screen.pressByTestIdAsync('promote.primary');
            await vi.waitFor(() => expect(screen.getTextContent(), JSON.stringify(harness.requests.map(request => ({ path: request.path, input: request.input })))).toContain(t('widgetAdd.areaApprovalPending')));
            expect(done).toBe(0);
            const saved = harness.artifacts(serverId).list().filter(row => Reflect.get(decodePlainArtifactStoredContent(row.header) as object, 'kind') === 'widget-definition.v1');
            expect(saved).toHaveLength(1);
            await screen.pressByTestIdAsync('promote.primary');
            expect(harness.artifacts(serverId).list().filter(row => Reflect.get(decodePlainArtifactStoredContent(row.header) as object, 'kind') === 'widget-definition.v1')).toHaveLength(1);
        } finally { await screen.unmount(); await disconnect(); }
    });
});
