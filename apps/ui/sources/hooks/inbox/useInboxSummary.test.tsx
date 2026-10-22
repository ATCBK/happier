import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installVitestRnShim } from '@/dev/vitestRnShim';
import { createAutomationRunFixture, createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createDeferred } from '@/dev/testkit';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { storage } from '@/sync/domains/state/storageStore';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { deleteServerFeaturesSnapshot, getServerFeaturesSnapshot, primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { removeServerProfile } from '@/sync/domains/server/serverProfiles';

import { InboxSummaryProvider, useSharedInboxSummary, type InboxSummary } from './useInboxSummary';
import { useWorkflowAttentionSource } from './useWorkflowAttentionSource';
import { createUsageNoticeArtifactFixture, createAccountNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { InboxModelProvider, useInboxModel, type InboxModel } from './useInboxModel';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { readAccountNoticeArtifactV1, readUsageNoticeArtifactV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { withArtifactExcerptV1 } from '@happier-dev/protocol/artifacts/artifactExcerptV1';
import { DestinationInstanceHost, type DestinationNavigation } from '@/components/appShell/workspace/DestinationInstanceHost';
import { InboxContent, type InboxView } from '@/components/inbox/InboxContent';
import { Text } from '@/components/ui/text/Text';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The rail badge counts 03's workflow attention window (ORC R-10, FIN 03 §6.4): the server's
 * `attention: 'required'` predicate, held in the canonical `attention` window the Workflows
 * column reads. Only HTTP, Socket.IO and the device credential store are replaced;
 * the Action parser, store, loader, applied Home lifetime and Account wake are real.
 */
const listRuns = vi.fn<(input: { operation: string; request: { attention?: string; projection?: 'membership'; limit?: number } }) => Promise<unknown>>();
const listAutomationRuns = vi.fn<() => Promise<unknown>>();
let workflowsEnabled = true;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
const initialState = storage.getInitialState();
let artifactRead = createUsageNoticeArtifactFixture();
let artifactWrites: Array<Record<string, unknown>> = [];
let refuseArtifactRead = false;
const noticeAlert = vi.hoisted(() => vi.fn());
let disposeActionLoader: (() => void) | undefined;

installDisconnectedServerSocketBoundary();
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true, spies: { alert: noticeAlert } }).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
}));
vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));
vi.mock('@/platform/digest', () => import('@/platform/digest.node'));
vi.mock('@/platform/hmacSha512', () => import('@/platform/hmacSha512.node'));
vi.mock('@/platform/randomUUID', () => import('@/platform/randomUUID.node'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-updates', async () => (await import('@/dev/testkit/mocks/expoUpdates')).createExpoUpdatesMock());
vi.mock('react-native-typography', async () => (await import('@/dev/testkit/mocks/reactNativeTypography')).createReactNativeTypographyMock());
vi.mock('@shopify/react-native-skia', async () => (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock());
vi.mock('expo-image', () => ({ Image: 'Image' }));

function features() {
    return createRootLayoutFeaturesResponse({ features: {
        workflows: { enabled: workflowsEnabled }, automations: { enabled: true }, social: { friends: { enabled: false } },
    } });
}

function page(runIds: readonly string[]) {
    return {
        runs: runIds.map((id) => createWorkflowRunSummaryFixture({ id, state: 'interrupted' })),
        acceptedEnvelopesByRunId: {},
        keyCensusByRunId: {},
        nextCursor: undefined,
    };
}

let latest: InboxSummary | null = null;
let attention: ReturnType<typeof useWorkflowAttentionSource> | null = null;
function Probe(): null {
    latest = useSharedInboxSummary();
    attention = useWorkflowAttentionSource();
    return null;
}

function DirectInboxRows(props: Readonly<{ view: InboxView; observe: (model: InboxModel) => void }>) {
    const inbox = useInboxModel();
    props.observe(inbox);
    const [route, setRoute] = React.useState('/inbox');
    const navigation = React.useMemo<DestinationNavigation>(() => ({
        push: href => setRoute(String(href)), replace: href => setRoute(String(href)), back: () => setRoute('/inbox'),
    }), []);
    return <DestinationInstanceHost tabId="notice-open" ref={{ kind: 'inbox', params: {} }} pathname={route} focused visible navigation={navigation}>
        {route === '/inbox' ? <InboxContent model={inbox} view={props.view} /> : <Text testID="notice-destination">{route}</Text>}
    </DestinationInstanceHost>;
}

async function renderSummary() {
    const screen = await renderScreen(<InboxSummaryProvider><Probe /></InboxSummaryProvider>);
    await act(async () => {});
    return screen;
}

describe('useInboxSummary workflow source', () => {
    beforeAll(async () => {
        vi.stubGlobal('__DEV__', true);
        vi.stubGlobal('self', globalThis);
        installVitestRnShim();
        await loadSyncSingletonForTests();
        disposeActionLoader = await installRealActionExecutorModuleLoader();
    });
    afterAll(() => disposeActionLoader?.());
    beforeEach(async () => {
        latest = null;
        attention = null;
        listRuns.mockReset();
        listAutomationRuns.mockReset().mockResolvedValue({ runs: [], nextCursor: null });
        workflowsEnabled = true;
        artifactRead = createUsageNoticeArtifactFixture();
        artifactWrites = [];
        refuseArtifactRead = false;
        noticeAlert.mockClear();
        storage.setState(initialState, true);
        connection = await restoreServerAccountForTest({ serverUrl: 'https://inbox-summary.example.test', accountId: 'account-a', request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features());
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            // The real restoration owner may finish hydration after the probe mounts.
            // Its remote baseline must agree with the feature policy this Home offers.
            if (path === '/v2/account/settings') return Response.json({
                content: { t: 'plain', v: { experiments: true, featureToggles: { automations: true } } }, version: 1,
            });
            if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
            if (path === '/health') return Response.json({ status: 'ok' });
            if (path === '/v3/automations/runs') return Response.json(await listAutomationRuns());
            if (path === '/v3/automations/runs/workflow-storage') {
                const input = JSON.parse(String(init?.body));
                const result = await listRuns(input);
                return Response.json(input.request?.projection === 'membership' && result && typeof result === 'object'
                    ? { ...result, projection: 'membership' } : result);
            }
            if (path === `/v1/artifacts/${artifactRead.id}`) {
                if (refuseArtifactRead) return Response.json({ error: 'artifact_access_forbidden' }, { status: 403 });
                if (init?.method === 'POST') {
                    artifactWrites.push(JSON.parse(String(init.body)));
                    return Response.json({ success: true, headerVersion: 4, bodyVersion: 3 });
                }
                return Response.json({ id: artifactRead.id, ownerAccountId: artifactRead.ownerAccountId,
                    access: artifactRead.access, publicAudience: artifactRead.publicAudience, encryptionMode: 'plain',
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    header: encodePlainArtifactStoredContent(artifactRead.rawHeader),
                    body: encodePlainArtifactStoredContent({ body: artifactRead.body }),
                    headerVersion: artifactRead.headerVersion, bodyVersion: artifactRead.bodyVersion,
                    seq: 1, createdAt: 1000, updatedAt: 2000 });
            }
            return new Response('{}', { status: 404 });
        } });
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: features() } });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.setState({
            profileScope: { serverId: connection.home.id, accountId: 'account-a' },
            settings: { ...storage.getState().settings, experiments: true,
                featureToggles: { ...storage.getState().settings.featureToggles, automations: true } },
            friends: {},
            sessions: {},
            sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {},
            artifacts: {},
            isDataReady: true,
            workflowRunsById: {},
            workflowRunListWindows: {},
        });
    });
    afterEach(async () => {
        standardCleanup();
        (await import('@/components/workflows/library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
        await connection?.dispose();
        deleteServerFeaturesSnapshot();
        if (connection) await removeServerProfile(connection.home.id);
        connection = null;
        storage.setState(initialState, true);
    });

    it("counts compact server attention membership in the badge's canonical window", async () => {
        listRuns.mockResolvedValueOnce(page(['run-held', 'run-interrupted']));

        await renderSummary();

        expect(listRuns, JSON.stringify(attention)).toHaveBeenCalledTimes(1);
        expect(listRuns.mock.calls[0]?.[0].request.attention).toBe('required');
        const request = listRuns.mock.calls[0]![0];
        expect(Buffer.byteLength(JSON.stringify(request))).toBe(106);
        expect(request.request.projection).toBe('membership');
        expect(latest).toEqual({ count: 2, hasContent: true });
        expect(storage.getState().workflowRunListWindows.attention?.runIds).toEqual(['run-held', 'run-interrupted']);
    });

    it('promotes the shell window only while Inbox rows are open, then removes cleared membership on the next wake', async () => {
        const run = createWorkflowRunSummaryFixture({ id: 'release-review', ownerAccountId: 'account-a', state: 'interrupted',
            origin: { kind: 'direct' } });
        const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition: createWorkflowDefinitionFixture({
            blocks: [{ kind: 'wait', id: 'wait', document: { text: 'Continue', references: [], attachments: [] } }],
        }),
            admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
            context: { source: { kind: 'inline' }, inputs: {}, machineId: run.machineId, executionTarget: { kind: 'session' },
                workspaceTarget: { project: { machineId: run.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
                origin: { kind: 'direct' }, metadata: { title: 'Release review' }, authorization: { principal: { kind: 'host' } } } });
        if (!materialized.ok) throw new Error(`fixture_materialization_failed:${materialized.error.code}`);
        const envelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-a', runId: run.id }, acceptedSnapshot: materialized.snapshot }));
        const census = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: 'account-a', access: 'owner',
            encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
            ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
        const pending = createDeferred<void>();
        listRuns.mockImplementation(async input => input.request.projection === 'membership'
            ? { runs: [run], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} }
            : (await pending.promise, { runs: [run], acceptedEnvelopesByRunId: { [run.id]: envelope }, keyCensusByRunId: { [run.id]: census } }));
        let setOpen: (open: boolean) => void = () => {};
        let inbox: InboxModel | null = null;
        function ModelProbe() { inbox = useInboxModel(); return null; }
        function Journey() {
            const [open, update] = React.useState(false); setOpen = update;
            return <InboxSummaryProvider><Probe />{open ? <InboxModelProvider><ModelProbe /></InboxModelProvider> : null}</InboxSummaryProvider>;
        }
        await renderScreen(<Journey />);
        await waitForHomeGovernance(() => expect(latest?.count).toBe(1));
        expect(listRuns).toHaveBeenCalledTimes(1);
        expect(storage.getState().workflowRunsById).toEqual({});
        await act(async () => setOpen(true));
        await waitForHomeGovernance(() => expect(listRuns).toHaveBeenCalledTimes(2));
        expect(inbox!.workflowAttention.phase).toBe('loading');
        expect(inbox!.workGroups).toEqual([]);
        await act(async () => pending.resolve());
        await waitForHomeGovernance(() => expect(inbox!.workflowAttention.phase).toBe('loaded'));
        expect(JSON.stringify(inbox!.workGroups)).toContain('Release review');
        await act(async () => setOpen(false));
        listRuns.mockResolvedValue(page([]));
        await act(async () => publishHomeAccountChange(connection!.home.id, [`workflow-run:${run.id}`]));
        await waitForHomeGovernance(() => expect(latest?.count).toBe(0));
        expect(listRuns.mock.calls.map(([input]) => ({ projection: input.request.projection ?? 'full',
            bytes: Buffer.byteLength(JSON.stringify(input)) }))).toEqual([
            { projection: 'membership', bytes: 106 }, { projection: 'full', bytes: expect.any(Number) }, { projection: 'membership', bytes: 106 },
        ]);
        expect(listRuns.mock.calls[1]?.[0].request).toMatchObject({ attention: 'required', limit: expect.any(Number) });
    });

    it('counts an ordinary Automation failure with Workflows disabled', async () => {
        await getServerFeaturesSnapshot({ serverId: connection!.home.id, force: true });
        workflowsEnabled = false;
        primeServerFeaturesSnapshot({ serverId: connection!.home.id, snapshot: { status: 'ready', features: features() } });
        listAutomationRuns.mockResolvedValue({ runs: [createAutomationRunFixture({ id: 'pre-session', state: 'failed' })], nextCursor: null });
        await renderSummary();
        expect(listRuns).not.toHaveBeenCalled();
        expect(latest).toEqual({ count: 1, hasContent: true });
    });

    it('lets an answered off-page hold recede on the next Account-change wake', async () => {
        listRuns.mockResolvedValueOnce(page(['run-held'])).mockResolvedValueOnce(page([]));

        await renderSummary();
        expect(latest?.count).toBe(1);

        await act(async () => {
            publishHomeAccountChange(connection!.home.id, ['workflow-run:run-held']);
        });
        await act(async () => {});

        expect(listRuns).toHaveBeenCalledTimes(2);
        expect(latest).toEqual({ count: 0, hasContent: false });
    });

    it('reads nothing and counts nothing when the Home does not offer Workflows', async () => {
        // Drain restoration's initial public observation before changing the served capability.
        await getServerFeaturesSnapshot({ serverId: connection!.home.id, force: true });
        workflowsEnabled = false;
        primeServerFeaturesSnapshot({ serverId: connection!.home.id, snapshot: { status: 'ready', features: features() } });

        await renderSummary();

        expect(listRuns).not.toHaveBeenCalled();
        expect(latest).toEqual({ count: 0, hasContent: false });
    });

    it('counts unread private plugin notices while leaving read, resolved and foreign notices quiet', async () => {
        listRuns.mockResolvedValue(page([]));
        const notice = createAccountNoticeArtifactFixture();
        storage.setState({ artifacts: { [notice.id]: notice,
            read: createAccountNoticeArtifactFixture({ id: 'read', header: { ...notice.header!, readAt: 2_000 } }),
            resolved: createAccountNoticeArtifactFixture({ id: 'resolved', header: { ...notice.header!, resolved: true } }),
            foreign: createAccountNoticeArtifactFixture({ id: 'foreign', ownerAccountId: 'account-b' }),
        } });
        await renderSummary();
        expect(latest).toEqual({ count: 1, hasContent: true });
        await act(async () => { storage.setState({ artifacts: {} }); });
        expect(latest).toEqual({ count: 0, hasContent: false });
    });

    it('marks an opened informational plugin notice read through Artifact CAS once without dismissing it', async () => {
        listRuns.mockResolvedValue(page([]));
        artifactRead = createAccountNoticeArtifactFixture();
        storage.setState({ artifacts: { [artifactRead.id]: artifactRead } });
        let inbox: InboxModel | null = null;
        function ModelProbe() { inbox = useInboxModel(); return null; }
        await renderScreen(<InboxModelProvider><ModelProbe /></InboxModelProvider>);
        await act(async () => {});
        const readModel = () => inbox!;
        const item = readModel().items.find(item => item.source.id === artifactRead.id)!;
        expect(item).toMatchObject({ view: 'updates', read: false });
        await act(async () => { await Promise.all([readModel().markItemOpened(item), readModel().markItemOpened(item)]); });
        expect(artifactWrites).toHaveLength(1);
        expect(artifactWrites[0]).toMatchObject({ expectedHeaderVersion: 3, expectedBodyVersion: 2 });
        expect(decodePlainArtifactStoredContent(artifactWrites[0]!.header as string)).toMatchObject({
            status: 'open', resolved: false, readAt: expect.any(Number),
        });
        const writtenBody = decodePlainArtifactStoredContent(artifactWrites[0]!.body as string);
        expect(writtenBody).toEqual({ body: artifactRead.body });
        expect(readAccountNoticeArtifactV1({ header: decodePlainArtifactStoredContent(artifactWrites[0]!.header as string),
            body: artifactRead.body })).toMatchObject({ kind: 'account_notice.v1', readAt: expect.any(Number) });
        expect(readModel().items.find(row => row.key === item.key)).toMatchObject({ read: true });
        expect(readModel().openAccountNotices).toHaveLength(1);
    });

    it('opening a plugin Needs-you item leaves its source request open and unread', async () => {
        listRuns.mockResolvedValue(page([]));
        artifactRead = createAccountNoticeArtifactFixture({ header: { type: 'decision' } });
        storage.setState({ artifacts: { [artifactRead.id]: artifactRead } });
        let inbox: InboxModel | null = null;
        function ModelProbe() { inbox = useInboxModel(); return null; }
        await renderScreen(<InboxModelProvider><ModelProbe /></InboxModelProvider>);
        await act(async () => {});
        const readModel = () => inbox!;
        const item = readModel().items.find(item => item.source.id === artifactRead.id)!;
        await act(async () => { await readModel().markItemOpened(item); });
        expect(artifactWrites).toHaveLength(0);
        expect(readModel().items).toContain(item);
    });

    it.each(['update', 'mention', 'decision'] as const)('directly opens a generic %s on a phone through its notice read owner', async type => {
        listRuns.mockResolvedValue(page([]));
        artifactRead = createAccountNoticeArtifactFixture({ header: { type } });
        storage.setState({ artifacts: { [artifactRead.id]: artifactRead } });
        let inbox: InboxModel | null = null;
        const observe = (model: InboxModel) => { inbox = model; };
        const screen = await renderScreen(<InboxModelProvider><DirectInboxRows
            view={type === 'update' ? 'updates' : type === 'mention' ? 'mentions' : 'needs_you'} observe={observe} /></InboxModelProvider>);
        const readModel = () => inbox!;
        const item = readModel().items[0]!;
        await screen.pressByTestIdAsync(`inbox.item.${item.key}`);
        expect(screen.findByTestId('notice-destination')?.props.children).toBe(item.pageRoute);
        if (type === 'decision') {
            expect(artifactWrites).toEqual([]);
            expect(readModel().items[0]).toMatchObject({ view: 'needs_you', read: false });
        } else {
            expect(artifactWrites).toHaveLength(1);
            expect(artifactWrites[0]).toMatchObject({ expectedHeaderVersion: 3, expectedBodyVersion: 2 });
            expect(decodePlainArtifactStoredContent(artifactWrites[0]!.header as string)).toMatchObject({
                status: 'open', resolved: false, readAt: expect.any(Number),
            });
            expect(decodePlainArtifactStoredContent(artifactWrites[0]!.body as string)).toEqual({ body: artifactRead.body });
            expect(readModel().items[0]).toMatchObject({ read: true });
        }
        expect(readModel().openAccountNotices).toHaveLength(1);
        expect(noticeAlert).not.toHaveBeenCalled();
    });

    it('keeps a generic notice unread and reports a failed read while still opening its page', async () => {
        listRuns.mockResolvedValue(page([]));
        artifactRead = createAccountNoticeArtifactFixture();
        refuseArtifactRead = true;
        storage.setState({ artifacts: { [artifactRead.id]: artifactRead } });
        let inbox: InboxModel | null = null;
        const screen = await renderScreen(<InboxModelProvider><DirectInboxRows view="updates"
            observe={value => { inbox = value; }} /></InboxModelProvider>);
        const readModel = () => inbox!;
        const item = readModel().items[0]!;
        await screen.pressByTestIdAsync(`inbox.item.${item.key}`);
        expect(noticeAlert).toHaveBeenCalled();
        expect(screen.findByTestId('notice-destination')?.props.children).toBe(item.pageRoute);
        expect(artifactWrites).toEqual([]);
        expect(readModel().items[0]).toMatchObject({ read: false });
        expect(readModel().openAccountNotices).toHaveLength(1);
    });

    it('counts private open usage notices and retires them when the Account changes', async () => {
        listRuns.mockResolvedValue(page([]));
        const notice = createUsageNoticeArtifactFixture();
        storage.setState({ artifacts: { [notice.id]: notice,
            shared: { ...notice, id: 'shared', ownerAccountId: 'account-b', access: 'view' },
            closed: createUsageNoticeArtifactFixture({ id: 'closed', header: { ...notice.header!, status: 'dismissed' } }),
        } });
        await renderSummary();
        expect(latest).toEqual({ count: 1, hasContent: true });
        await act(async () => { storage.setState({ profileScope: {
            serverId: connection!.home.id, accountId: 'account-b',
        } }); });
        expect(latest).toEqual({ count: 0, hasContent: false });
    });

    it('dismisses a usage notice through the Account Artifact CAS preserving its exact body, and refuses changed revisions or privacy', async () => {
        listRuns.mockResolvedValue(page([]));
        storage.setState({ artifacts: { [artifactRead.id]: artifactRead } });
        let inbox: InboxModel | null = null;
        function ModelProbe() { inbox = useInboxModel(); return null; }
        await renderScreen(<InboxModelProvider><ModelProbe /></InboxModelProvider>);
        await act(async () => {});
        const readModel = () => inbox!;
        const entry = readModel().openUsageNotices[0]!;
        const originalBody = entry.artifact.body;
        if (typeof originalBody !== 'string') throw new Error('Expected a readable usage notice body');
        const item = readModel().items.find(item => item.source.id === artifactRead.id)!;
        // The retained closed usage schema has no read field. Opening it must
        // not invent one or migrate its stored kind/content.
        await act(async () => { await readModel().markItemOpened(item); });
        expect(artifactWrites).toHaveLength(0);
        await act(async () => { await readModel().dismissUsageNotice(entry); });
        expect(artifactWrites).toHaveLength(1);
        expect(artifactWrites[0]).toMatchObject({ expectedHeaderVersion: 3, expectedBodyVersion: 2 });
        expect(decodePlainArtifactStoredContent(artifactWrites[0]!.header as string)).toMatchObject({ status: 'dismissed', notice: entry.header.notice });
        const writtenHeader = decodePlainArtifactStoredContent(artifactWrites[0]!.header as string);
        const writtenBody = decodePlainArtifactStoredContent(artifactWrites[0]!.body as string);
        if (!writtenBody || typeof writtenBody !== 'object' || !('body' in writtenBody)) throw new Error('Expected paired Artifact body');
        expect(writtenBody.body).toBe(originalBody);
        const expectedHeader = withArtifactExcerptV1({ ...entry.artifact.rawHeader, status: 'dismissed' }, originalBody);
        expect(writtenHeader).toEqual(expectedHeader);
        expect(readUsageNoticeArtifactV1({ header: writtenHeader, body: writtenBody.body }))
            .toEqual(expectedHeader);
        expect(readModel().openUsageNotices).toEqual([]);
        artifactRead = { ...artifactRead, headerVersion: 4 };
        await act(async () => { await expect(readModel().dismissUsageNotice(entry)).rejects.toThrow(); });
        expect(artifactWrites).toHaveLength(1);
        artifactRead = { ...artifactRead, publicAudience: 'retained' };
        await act(async () => { await expect(readModel().dismissUsageNotice(entry)).rejects.toThrow(); });
        expect(artifactWrites).toHaveLength(1);
    });
});
