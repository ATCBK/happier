declare const require: (id: string) => unknown;
import { workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';

// Match the real app entry: force canonical theme bootstrap before lazy consumers.
require('@/unistyles');
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { UnistylesRuntime } from 'react-native-unistyles';
import { AutomationDefinitionListResponseSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { WorkflowAcceptedSnapshotV1Schema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { WorkflowDefinitionV1Schema, type WorkflowResultContract } from '@happier-dev/protocol/workflows/workflowV1';
import { WorkflowProgressEnvelopeV1Schema, type WorkflowRunStateV1, type WorkflowRunInvocationIndexV1, type WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { WorkspaceProvider } from '@/components/appShell/workspace/WorkspaceProvider';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { AppShellMaterialFrame } from '@/components/navigation/shell/AppShellMaterialFrame';
import { GlassMaterialRuntime } from '@/components/ui/glass/GlassMaterialRuntime';
import { WorkflowRunScreen } from '@/components/workflows/screens/WorkflowRunScreen';
import { WorkflowsColumn } from '@/components/workflows/column/WorkflowsColumn';
import { InboxPage } from '@/app/(app)/inbox';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { createRootLayoutFeaturesResponse } from '../fixtures/featureFixtures';
import { configureSessionDraftRepository, writeNewSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { WorkflowRunStartRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ModalProvider } from '@/modal';
import { storage } from '@/sync/domains/state/storage';
import { upsertServerProfileOnly, setActiveServer, getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot, getAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { createWorkflowRunSummaryFixture, createWorkflowInvocationIndexFixture } from '../fixtures/workflowRunFixtures';
import { ApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { AutomationV3RunListResponseSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { createMachineFixture } from '../fixtures/machineFixtures';
import { installUrlMirror } from './workspaceHistoryBrowserBoundary';
import { WorkspaceBrowserPresentation } from './WorkspaceBrowserPresentation';
import { createWorkflowRunReleaseScene } from './workflowRunDesignScene';

const accountId = 'run-browser-account';
const runId = '11111111-1111-4111-8111-111111111111';
const rootId = '22222222-2222-4222-8222-222222222222';
const holdId = '33333333-3333-4333-8333-333333333333';
const runHref = `/workflows/runs/${runId}`;
const catalog = resolveCompactAppDestinations({ pages: [], builtins: { workflows: true, friends: false, inbox: true, externalSessions: false } });
const search = { open: () => {}, buildCommands: () => [] };

/** External opaque storage fixture. Production Action, codec, store, routing and modal owners stay real. */
export async function mount(phone: boolean, theme: 'light' | 'dark', initialState: WorkflowRunStateV1 = 'waiting_for_review', defaultWaitName = false, requiredAnswer = false, seams = false, columnProject = false,
    /** `release`: the design lab's multi-lane Run (DESIGN-13) through the same real owners. */
    scene: 'hold' | 'release' | 'release-failed' | 'release-review' | 'release-usage-limit' = 'hold') {
    const failedScene = scene === 'release-failed' || scene === 'release-usage-limit';
    const design = scene === 'hold' ? null : createWorkflowRunReleaseScene({ runId, rootId, holdId, failed: failedScene,
        ...(scene === 'release-usage-limit' ? { usageLimitResetAtMs: Date.parse('2026-10-20T12:00:00.000Z') } : {}), review: scene === 'release-review' });
    UnistylesRuntime.setAdaptiveThemes(false);
    UnistylesRuntime.setTheme(theme);
    // Plain text permits empty strings. Invalid-after-edit needs an authored required-field contract.
    const resultContract: WorkflowResultContract = requiredAnswer
        ? { kind: 'json', schema: { type: 'object', properties: { summary: { type: 'string', title: 'Summary', minLength: 1 } }, required: ['summary'] } }
        : { kind: 'text' };
    const definition = design?.definition ?? WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [{
        kind: 'wait', id: 'check', ...(defaultWaitName ? {} : { name: 'Check the release' }),
        document: { text: 'Check **the release notes** before continuing. Are the changes ready to share?', references: [], attachments: [] },
        result: resultContract,
    }] });
    let run = createWorkflowRunSummaryFixture({ id: runId, ownerAccountId: accountId, machineId: 'machine-a',
        state: initialState, origin: { kind: 'direct' }, revision: 7, attentionRequired: initialState === 'waiting_for_review' || (design !== null && !failedScene) });
    // Exact server projection: succeeded + pending custody + existing invocation
    // (workflowRunService.ts#deriveWorkflowRunAvailability), not UI-derived policy.
    const completedAvailability = {
        pause: false, resumeBoundary: false, restoreWorkspace: false, cancel: false, inspectExecution: true,
        disabledReasons: [
            { operation: 'pause', code: 'run_terminal' },
            { operation: 'resume_boundary', code: 'ineligible_state' },
            { operation: 'restore_workspace', code: 'ineligible_state' },
            { operation: 'cancel', code: 'run_terminal' },
        ],
    } satisfies WorkflowRunSummaryV1['availability'];
    // A settled design Run has nothing left to stop: its custody is settled, not pending.
    if (failedScene) run = { ...run, state: 'failed', availability: completedAvailability, workflowCustodyState: 'settled' };
    const acceptedSnapshot = WorkflowAcceptedSnapshotV1Schema.parse({ definition, authoredDefinition: definition,
        workDepth: 0, startedBy: 'user', metadata: { title: design?.title ?? 'Release review' }, frozenChildren: {},
        materializedLeaves: design?.materializedLeaves ?? [{ sourceKey: '$root', blockId: 'check', kind: 'wait', selection: {}, authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'session' } }],
        source: { kind: 'inline' }, inputs: {}, machineId: 'machine-a', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-a', directory: columnProject ? '/home/ubuntu/happier' : seams ? '/home/ubuntu' : '/repo',
            checkoutRootPath: columnProject ? '/home/ubuntu/happier' : seams ? '/home/ubuntu' : '/repo' } },
        origin: { kind: 'direct' }, authorization: { admittedPermissionCeiling: 'read-only', principal: { kind: 'host' } },
    });
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot }));
    const keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId, ownerAccountId: accountId, encryptionMode: 'plain', access: 'owner',
        dataEncryptionKey: null, callerDataEncryptionKey: null, visibleTeamId: null, recipients: [{ recipientAccountId: accountId,
            contentKey: { status: 'unavailable', reason: 'plain_account' }, contentPublicKeyFingerprint: null,
            encryptedDataKey: null, recipientContentPublicKeyFingerprint: null }],
        ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
    const sealProgress = (index: { id: string; sequence: string; parentRecordId: string | null; memberOrdinal: string; attempt: string }, progress: Parameters<typeof sealWorkflowProgressStoredEnvelopeV1>[0]['progress']) =>
        serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: index.id, sequence: index.sequence,
                parentRecordId: index.parentRecordId, memberOrdinal: index.memberOrdinal, attempt: index.attempt }, progress }));
    type BrowserRow = { index: WorkflowRunInvocationIndexV1; contentEnvelope: string | null; parentRevision: number };
    const rows = new Map<string, BrowserRow>(design !== null ? design.rows.map(row => [row.index.id, { index: row.index,
        contentEnvelope: row.progress === null ? null : sealProgress(row.index, row.progress), parentRevision: run.revision }] satisfies [string, BrowserRow])
        : [true, false].map(isRoot => {
        const index = createWorkflowInvocationIndexFixture({ id: isRoot ? rootId : holdId, runId, sequence: isRoot ? '0' : '1',
            parentRecordId: isRoot ? null : rootId, memberOrdinal: '0', attempt: '0', contentRevision: '7',
            lifecycle: isRoot ? 'running' : 'waiting_for_review' });
        const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1', invocationPath: { blockId: isRoot ? '$root' : 'check', scope: [] },
            blockKind: isRoot ? 'root' : 'wait', attempt: '0', logicalInvocationRecordId: index.id,
            ...(isRoot && seams ? { stepProgress: { completed: 0, total: 1 } } : {}),
            ...(isRoot ? {} : { resultContract }) });
        const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: index.id, sequence: index.sequence,
                parentRecordId: index.parentRecordId, memberOrdinal: index.memberOrdinal, attempt: index.attempt }, progress }));
        return [index.id, { index, contentEnvelope, parentRevision: run.revision }] satisfies [string, BrowserRow];
    }));
    const operations: string[] = [];
    let pendingStart: { runId: string; resolve: (reply: unknown) => void } | null = null;
    const admitted = new Map<string, { run: WorkflowRunSummaryV1; acceptedEnvelope: string }>();
    Object.assign(globalThis, { runBrowserMachineRpc: async (request: { method: string; payload: unknown }) => {
        operations.push(`rpc:${request.method}`);
        if (request.method !== getActionSpec('workflow.run.start').bindings?.rpcMethod) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        const targeted = TargetedActionRpcRequestV1Schema.safeParse(request.payload);
        const start = WorkflowRunStartRequestV1Schema.parse(targeted.success ? targeted.data.input : request.payload);
        return await new Promise<unknown>(resolve => { pendingStart = { runId: start.runId, resolve }; });
    } });
    const transportReads: Array<Readonly<{ operation: string; state: WorkflowRunStateV1; revision: number }>> = [];
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    setRuntimeFetch(async (url, init) => {
        const path = new URL(String(url)).pathname;
        operations.push(`http:${path}`);
        if (path === '/health' || path === '/v1/auth/ping') return json({});
        if (path === '/v1/features') return json({ features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {
            accountStoredContentCompatibility: { v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1' },
        } });
        if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v2/account/settings') return json({ content: null, version: 0 });
        if (path === '/v1/artifacts') return json({ artifacts: [] });
        if (path === '/v1/account/encryption/currentness') return json({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
            updatedAt: 0, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } });
        // The real Run notification owner reads Account-inline Automations.
        if (path === '/v3/automations' && (!init?.method || init.method === 'GET')) {
            return json(AutomationDefinitionListResponseSchema.parse({ automations: [], nextCursor: null }));
        }
        if (path === '/v3/automations/runs' && (!init?.method || init.method === 'GET')) {
            return json(AutomationV3RunListResponseSchema.parse({ runs: [], nextCursor: null }));
        }
        if (path !== '/v3/automations/runs/workflow-storage') return json({}, 404);
        const operation: Readonly<Record<string, unknown>> = JSON.parse(String(init?.body));
        operations.push(String(operation.operation));
        transportReads.push({ operation: String(operation.operation), state: run.state, revision: run.revision });
        if (operation.operation === 'get') {
            const other = admitted.get(String(operation.runId));
            if (operation.runId !== runId && !other) return json({ error: 'run_not_found' }, 404);
            return json({ run: other?.run ?? run, acceptedEnvelope: other?.acceptedEnvelope ?? acceptedEnvelope,
                checkpointEnvelope: null, resultEnvelope: null, keyCensus: { ...keyCensus, runId: String(operation.runId) } });
        }
        // Mirror listWorkflowRuns' opaque HTTP projection, including the census
        // for plain Accounts: the public Action opens the private sidecars itself.
        if (operation.operation === 'list') {
            const attention = operation.request !== null && typeof operation.request === 'object'
                && 'attention' in operation.request && operation.request.attention === 'required';
            const held = attention ? [...rows.values()].filter(row => row.index.lifecycle === 'waiting_for_review')
                .sort((a, b) => BigInt(a.index.sequence) < BigInt(b.index.sequence) ? -1 : 1)[0] : undefined;
            return json({ runs: [run], acceptedEnvelopesByRunId: { [runId]: acceptedEnvelope },
            keyCensusByRunId: { [runId]: keyCensus }, rootProgressByRunId: {
                [runId]: { index: rows.get(rootId)!.index, contentEnvelope: rows.get(rootId)!.contentEnvelope },
            }, ...(attention ? { heldProgressByRunId: { [runId]: held ? { index: held.index, contentEnvelope: held.contentEnvelope } : null } } : {}) });
        }
        if (operation.operation === 'run-key.census') return json(keyCensus);
        if (operation.operation === 'invocations.list') {
            if (operation.runId !== runId) return json({ invocations: [], parentRevision: admitted.get(String(operation.runId))?.run.revision ?? 1,
                ...(operation.progressEnvelopes === true ? { keyCensus: { ...keyCensus, runId: String(operation.runId) }, progressEnvelopesByInvocationId: {} } : {}) });
            const listed = [...rows.values()].filter(row => !Array.isArray(operation.lifecycles) || operation.lifecycles.includes(row.index.lifecycle));
            return json({ invocations: listed.map(row => row.index), parentRevision: run.revision,
                ...(operation.progressEnvelopes === true ? { keyCensus,
                    progressEnvelopesByInvocationId: Object.fromEntries(listed.flatMap(row => row.contentEnvelope === null ? [] : [[row.index.id, row.contentEnvelope]])) } : {}) });
        }
        if (operation.operation === 'invocations.get') {
            const row = rows.get(String(operation.invocationId));
            return json({ invocation: row ? { ...row, parentRevision: run.revision } : null });
        }
        if (operation.operation === 'invocations.current') return json({ invocation: { ...rows.get(holdId)!, parentRevision: run.revision }, parentRevision: run.revision });
        if (operation.operation === 'invocations.complete_review') {
            const row = rows.get(String(operation.invocationId));
            if (!row || row.index.contentRevision !== operation.expectedContentRevision) return json({ error: 'currentness_conflict' }, 409);
            run = { ...run, state: 'succeeded', revision: run.revision + 1, availability: completedAvailability };
            const completed = { ...row, contentEnvelope: String(operation.contentEnvelope),
                index: { ...row.index, contentRevision: String(BigInt(row.index.contentRevision) + 1n), lifecycle: 'completed' as const },
                parentRevision: run.revision };
            rows.set(row.index.id, completed);
            return json({ run, invocation: completed, disposition: 'completed' });
        }
        return json({ error: 'run_not_found' }, 404);
    });
    const home = await upsertServerProfileOnly({ serverUrl: location.origin, name: 'Browser Home' });
    const token = `e30.${btoa(JSON.stringify({ sub: accountId })).replaceAll('=', '')}.signature`;
    await setActiveServer({ serverId: home.id });
    await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    primeServerFeaturesSnapshot({ serverId: home.id, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse() } });
    storage.setState({ profileScope: { serverId: home.id, accountId }, isDataReady: true, isSessionDraftsReady: true,
        settings: { ...settingsDefaults, experiments: true, featureToggles: { automations: true } },
        machines: { 'machine-a': createMachineFixture({ id: 'machine-a', activeAt: Date.now(),
            ...(seams ? { metadata: { ...createMachineFixture().metadata!, homeDir: '/home/ubuntu' } } : {}),
            ...(design !== null ? { metadata: { ...createMachineFixture().metadata!, displayName: 'MacBook Pro' } } : {}) }) },
        workflowRunListWindows: {}, workflowRunsById: {}, workflowRunInvocationsByRunId: {} });
    if (seams) {
        const approval = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: Date.now(), updatedAtMs: Date.now(),
            createdBy: { surface: 'session_agent', sessionId: 'session-opaque-approval-fixture' },
            actionId: 'session.spawn_new', actionArgs: {}, summary: 'session.spawn_new — session-opaque-approval-fixture' });
        const header = buildApprovalRequestArtifactHeaderV1(approval, { legacyServerId: home.id });
        storage.getState().applyArtifacts([{ id: '44444444-4444-4444-8444-444444444444', header, title: header.title,
            body: JSON.stringify(approval), isDecrypted: true, storageMode: 'plain', headerVersion: 1, bodyVersion: 1,
            seq: 1, createdAt: approval.createdAtMs, updatedAt: approval.updatedAtMs }]);
        await prepareSessionDraftPersistenceStorage();
        configureSessionDraftRepository({ scope: { serverId: home.id, accountId }, syncEnabled: false });
        writeNewSessionDraft({ scope: { serverId: home.id, accountId }, draftId: '99999999-9999-4999-8999-999999999999',
            patch: { text: 'Unsent Session draft' }, materializationIntent: 'seeded' });
    }
    let navigation: WorkspaceNavigationContextValue;
    const root = createRoot(document.getElementById('root')!);
    function App() {
        return <WorkspaceProvider enabled={!phone} phone={phone} catalog={catalog}>{current => {
            navigation = current;
            const group = current.state.groups[current.state.focusedGroupId];
            const tab = current.state.tabs[group.activeTabId];
            const pathname = tab.target.kind === 'workflowRun' ? `/workflows/runs/${tab.target.params.runId}`
                : tab.target.params.workspacePathname ?? (tab.target.kind === 'inbox' ? '/inbox' : '/workflows/runs');
            const isRun = tab.target.kind === 'workflowRun';
            const seamBody = tab.target.kind === 'inbox' ? <InboxPage /> : isRun ? <WorkflowRunScreen /> : <WorkflowsColumn surface="page" />;
            return <AppShellMaterialFrame showChrome={!phone} dragEnabled={false} leftOffsetPx={0} sidebarWidth={0}
                titleStrip={null} rail={null} column={null} peek={null}>
                {seams ? <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname={pathname}
                    focused visible phone={phone} navigation={current.navigationForTab(tab.id)}>{seamBody}</DestinationInstanceHost>
                    : tab.target.kind === 'workflowRun' ? <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname={runHref}
                    focused visible phone={phone} navigation={current.navigationForTab(tab.id)}><WorkflowRunScreen /></DestinationInstanceHost>
                    : <button id="open-run" onClick={() => current.openHref(runHref)}>Open Run</button>}
            </AppShellMaterialFrame>;
        }}</WorkspaceProvider>;
    }
    installUrlMirror();
    root.render(<WorkspaceBrowserPresentation><SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
        insets: { top: 0, right: 0, bottom: 0, left: 0 } }}><InjectedAuthProvider credentials={null}><UniversalSearchRuntimeProvider value={search}>
        <GlassMaterialRuntime><NavigationContainer><ModalProvider><AppPaneProvider><App /></AppPaneProvider></ModalProvider></NavigationContainer></GlassMaterialRuntime></UniversalSearchRuntimeProvider></InjectedAuthProvider></SafeAreaProvider></WorkspaceBrowserPresentation>);
    return { reviewId: '55550004-5555-4555-8555-555555555555', ready: () => Boolean(navigation?.active)
        && document.documentElement.style.getPropertyValue('--happier-glass-floating-opacity') !== '', themeName: () => UnistylesRuntime.themeName,
        canvasColor: () => UnistylesRuntime.getTheme().colors.background.canvas,
        open: (href: string) => navigation.openHref(href), runHref, holdId,
        operations: () => [...operations],
        startRunId: () => pendingStart?.runId ?? null,
        settleStart: (refused = false, errorCode = 'run_access_denied') => {
            if (!pendingStart) throw new Error('No issued start to settle');
            const pending = pendingStart;
            pendingStart = null;
            if (refused) pending.resolve({ ok: false, errorCode, error: errorCode });
            else {
                const next = createWorkflowRunSummaryFixture({ id: pending.runId, ownerAccountId: accountId,
                    machineId: 'machine-a', state: 'queued', origin: { kind: 'direct' } });
                admitted.set(next.id, { run: next, acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
                    mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId: next.id }, acceptedSnapshot })) });
                pending.resolve({ admission: 'created', run: next });
            }
        },
        diagnostics: () => {
            const selected = getActiveServerSnapshot();
            const invocations = storage.getState().workflowRunInvocationsByRunId[workflowRunStoreKey(runId)];
            return { selected: { serverId: selected.serverId, serverUrl: selected.serverUrl, generation: selected.generation },
                applied: getAppliedActiveServerSnapshot(), backend: { state: run.state, revision: run.revision },
                stored: storage.getState().workflowRunsById[workflowRunStoreKey(runId)]?.summary ?? null, reads: [...transportReads],
                invocations: invocations ? { holdLifecycle: invocations.factsById[holdId]?.lifecycle ?? null,
                    historyRevision: invocations.history.parentRevision, attentionRevision: invocations.attention.parentRevision } : null };
        },
        storedRunState: () => storage.getState().workflowRunsById[workflowRunStoreKey(runId)]?.summary?.state ?? null,
        setRunState: (state: WorkflowRunStateV1) => { run = { ...run, state, revision: run.revision + 1 };
            publishHomeAccountChange(home.id, [`workflow-run:${runId}`]); },
        setCompletedLeaves: () => { const row = rows.get(holdId)!;
            run = { ...run, revision: run.revision + 1 };
            rows.set(holdId, { ...row, index: { ...row.index, lifecycle: 'completed',
                contentRevision: String(BigInt(row.index.contentRevision) + 1n) }, parentRevision: run.revision });
            publishHomeAccountChange(home.id, [`workflow-run:${runId}`]); },
        setCompleted: () => {
            run = { ...run, state: 'succeeded', attentionRequired: false, revision: run.revision + 1, availability: completedAvailability,
                ...(design !== null ? { workflowCustodyState: 'settled' as const } : {}) };
            // A settled Run has reached its last steps (the design scene stops before them while running).
            for (const row of design?.lateRows ?? []) rows.set(row.index.id, { index: row.index,
                contentEnvelope: row.progress === null ? null : sealProgress(row.index, row.progress), parentRevision: run.revision });
            for (const row of rows.values()) {
                rows.set(row.index.id, { ...row, index: { ...row.index, lifecycle: 'completed',
                    contentRevision: String(BigInt(row.index.contentRevision) + 1n) }, parentRevision: run.revision });
            }
            publishHomeAccountChange(home.id, [`workflow-run:${runId}`]);
        },
    };
}

Object.assign(globalThis, { runHarness: { mount } });
