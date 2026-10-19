import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { NotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { readAccountNoticeArtifactV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { resolveSessionFollowActionRequest } from '@happier-dev/protocol/sessions/follow/actionTransport';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { db } from '@/storage/db';
import { changeDeliveryMute } from '@/app/session/follow/sessionDeliveryMuteService';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { registerSessionFollowSourceRoutes } from './registerSessionFollowSourceRoutes';
import { registerSessionFollowRoutes } from './registerSessionFollowRoutes';
import { artifactsRoutes } from '../artifacts/artifactsRoutes';
import { createDiscussion, postDiscussionMessage } from '@/app/discussions/mutations';
import { DISCUSSION_DEFAULT_PAGE_SIZE_V1 } from '@happier-dev/protocol/discussions/api';
import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';

describe('Account Run Follow source to personal delivery (SQLite + HTTP)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-account-run-follow-', initEncrypt: true, env: {
            HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: 'true', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_SERVER_IDENTITY_ID: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['human', 'agent'] as const)('delivers an exact %s Discussion original through its stored Account Follow', async kind => {
        const author = await db.account.create({ data: { encryptionMode: 'plain' } });
        const receiver = kind === 'agent' ? author : await db.account.create({ data: { encryptionMode: 'plain' } });
        const agent = kind === 'agent' ? await db.session.create({ data: { accountId: author.id,
            tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } }) : null;
        const producer = agent ? { v: 1 as const, kind: 'agent' as const, sessionId: agent.id } : undefined;
        const policy: FollowPolicyV1 = kind === 'agent' ? { preset: 'custom', events: { message: { delivery: 'interrupt' } } } : { preset: 'important' };
        const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
        const created = await createDiscussion({ actorAccountId: author.id, authentication, ...(producer ? { producer } : {}), request: {
            creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Discussion' } },
            participants: agent ? [{ kind: 'session', sessionId: agent.id }]
                : [{ kind: 'account', accountId: receiver.id }],
            firstMessage: { localId: randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Initial' }] } }, mentionedAccountIds: [] },
        } });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const source = { kind: 'discussion' as const, discussionId };
        const app = createAuthenticatedTestApp();
        app.addHook('onRequest', async request => { request.headers['x-test-user-id'] = receiver.id; });
        registerSessionFollowSourceRoutes(app);
        registerSessionFollowRoutes(app);
        artifactsRoutes(app);
        const serverHttpBaseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
        try {
            const path = resolveSessionFollowActionRequest('follow.set', { receiver: { kind: 'account' }, source, policy }).path;
            expect((await app.inject({ method: 'PUT', url: path, payload: { policy } })).statusCode).toBe(200);
            const posted = await postDiscussionMessage({ actorAccountId: author.id, authentication, discussionId, ...(producer ? { producer } : {}), request: {
                localId: randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Original human text stays private' }] } }, mentionedAccountIds: [],
            } });
            if (!posted.ok) throw new Error(posted.error);
            const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: receiver.id })).toString('base64url')}.fixture`, encryption: null };
            const { createInvocationSavedSecretOperationContextV1 } = await vi.importActual<{
                createInvocationSavedSecretOperationContextV1(input: unknown): unknown;
            }>('../../../../../../cli/src/settings/secrets/savedSecretOperationContext');
            const { createAccountArtifactStore } = await vi.importActual<{
                createAccountArtifactStore(input: unknown): { list(): Promise<{ items: { artifactId: string }[] }>; read(id: string): Promise<{ header: unknown; body: unknown } | null> };
            }>('../../../../../../cli/src/api/artifacts/accountArtifactStore');
            const { createPersonalFollowOccurrenceDispatcher } = await vi.importActual<{
                createPersonalFollowOccurrenceDispatcher(input: unknown): (input: unknown) => Promise<unknown>;
            }>('../../../../../../cli/src/notifications/activity/dispatchPersonalFollowOccurrence');
            const { createSessionFollowOccurrenceDispatcher } = await vi.importActual<{
                createSessionFollowOccurrenceDispatcher(input: unknown): { dispatchAccountSourceRange(input: unknown): Promise<unknown>; dispose(): void };
            }>('../../../../../../cli/src/agent/runtime/session/follow/sessionFollowOccurrenceDispatcher');
            const { resolveAccountSettingsScopeKey } = await vi.importActual<{ resolveAccountSettingsScopeKey(input: unknown): string }>(
                '../../../../../../cli/src/settings/accountSettings/accountSettingsScopeKey');
            const { runWithServerHttpBaseUrl } = await vi.importActual<{ runWithServerHttpBaseUrl<T>(url: string, run: () => T): T }>(
                '../../../../../../cli/src/api/client/serverHttpBaseUrl');
            const pushes: unknown[][] = [];
            const snapshot = { source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1, loadedAtMs: 1,
                settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials), notificationChannelCatalog: { status: 'ready', revision: 1,
                    diagnostics: [], channels: [NotificationChannelRecordV1Schema.parse({ v: 1, id: 'push', kind: 'expo_push', topics: {} })] } };
            const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl, isCurrent: async () => true, snapshot });
            const store = createAccountArtifactStore({ credentials, getAccountEncryptionMode: async () => 'plain' });
            const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: receiver.id, credentials, serverId: 'home', serverHttpBaseUrl,
                machineId: 'fixture-machine', installationId: 'fixture-installation', signal: new AbortController().signal,
                isCurrent: async () => true, subscribeInvalidation: () => () => {}, resolveSourceKeyContext: async () => null,
                isPersonalCurrent: async () => true,
                dispatchPersonal: (input: unknown, isCurrent: () => Promise<boolean>) => createPersonalFollowOccurrenceDispatcher({ operationContext, isCurrent,
                    pluginNotifications: null, usageNoticeArtifactStore: { accountId: receiver.id, store },
                    readAccountSessionDeliveryMutedScopes: async () => [],
                    expoPushSender: { sendToAllDevicesAsync: async (...args: unknown[]) => { pushes.push(args); return true; } } })(input),
            });
            try {
                await Promise.all([dispatcher.dispatchAccountSourceRange({ discussionIds: [discussionId] }), dispatcher.dispatchAccountSourceRange({ discussionIds: [discussionId] })]);
                const notices = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.list());
                expect(notices.items).toHaveLength(1);
                const stored = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.read(notices.items[0]!.artifactId));
                expect(readAccountNoticeArtifactV1(stored!)).toMatchObject({
                    notice: { topic: 'follow_update', follow: { original: { kind: 'discussion', discussion: { serverId: 'home', discussionId },
                        messageId: posted.value.message.id }, event: { kind: kind === 'agent' ? 'message' : 'person_wrote' } } },
                });
                expect(pushes).toHaveLength(kind === 'agent' ? 1 : 0);
                expect((await db.accountSessionFollow.findFirstOrThrow({ where: { accountId: receiver.id } })).deliveredDiscussionSeq).toBe(posted.value.message.seq);
                expect(await db.sessionPendingMessage.count({ where: agent ? { sessionId: agent.id } : {} })).toBe(0);
                if (kind === 'human') {
                    const post = async (actorAccountId: string) => {
                        const next = await postDiscussionMessage({ actorAccountId, authentication, discussionId, request: {
                            localId: randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Next original' }] } }, mentionedAccountIds: [],
                        } });
                        if (!next.ok) throw new Error(next.error);
                        return next.value.message;
                    };
                    const early = await post(author.id);
                    for (let index = 0; index < DISCUSSION_DEFAULT_PAGE_SIZE_V1 + 1; index++) await post(receiver.id);
                    const late = await post(author.id);
                    await dispatcher.dispatchAccountSourceRange({ discussionIds: [discussionId] });
                    const caughtUp = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.list());
                    expect(caughtUp.items).toHaveLength(3);
                    const originals = await Promise.all(caughtUp.items.map(async item =>
                        readAccountNoticeArtifactV1((await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.read(item.artifactId)))!)));
                    expect(originals).toEqual(expect.arrayContaining([early, late].map(message => expect.objectContaining({ notice: expect.objectContaining({
                        follow: expect.objectContaining({ original: expect.objectContaining({ messageId: message.id }) }),
                    }) }))));
                    expect((await db.accountSessionFollow.findFirstOrThrow({ where: { accountId: receiver.id } })).deliveredDiscussionSeq).toBe(late.seq);
                    await changeDeliveryMute({ accountId: receiver.id, receiver: { kind: 'account' }, scope: { kind: 'source', source }, authentication, operation: 'set' });
                    await post(author.id);
                    await dispatcher.dispatchAccountSourceRange({ discussionIds: [discussionId] });
                    expect((await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.list())).items).toHaveLength(3);
                    await changeDeliveryMute({ accountId: receiver.id, receiver: { kind: 'account' }, scope: { kind: 'source', source }, authentication, operation: 'remove' });
                    expect((await app.inject({ method: 'DELETE', url: path })).statusCode).toBe(200);
                    await dispatcher.dispatchAccountSourceRange({ discussionIds: [discussionId] });
                    expect((await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.list())).items).toHaveLength(3);
                    expect((await db.accountSessionFollow.findFirstOrThrow({ where: { accountId: receiver.id } })).deliveredDiscussionSeq).toBe(late.seq);
                }
            } finally { dispatcher.dispose(); }
        } finally { await app.close(); }
    });

    it.each((['execution_run', 'workflow_run'] as const).flatMap(kind => [
        { kind, entry: 'hint' as const, terminalStatus: 'failed' as const, expectedPushes: 1 },
        { kind, entry: 'catchup' as const, terminalStatus: 'failed' as const, expectedPushes: 1 },
        { kind, entry: 'hint' as const, terminalStatus: 'succeeded' as const, expectedPushes: 0 },
    ]))('delivers one exact $kind $terminalStatus original via $entry and respects mute and suppression', async ({ kind, entry, terminalStatus, expectedPushes }) => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const parent = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}',
            encryptionMode: 'plain', publisherGeneration: 1n } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        await db.accessKey.create({ data: { accountId: account.id, machineId: machine.id, sessionId: parent.id, data: 'opaque' } });
        await db.session.update({ where: { id: parent.id }, data: { runtimeMachineTarget: {
            homeId: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', accountId: account.id, sessionId: parent.id,
            machineId: machine.id, installationId: machine.installationId!,
        } } });
        const run = await db.automationRun.create({ data: { accountId: account.id, originKind: 'direct', automationId: null,
            causeKind: null, causeOccurredAt: null, workflowAcceptedSnapshotEnvelope: '{}', state: 'running',
            workflowCustodyState: 'pending', revision: 1, scheduledAt: new Date(), dueAt: new Date() } });
        let terminal = false;
        let terminalEventId = 'exact-terminal';
        const app = createAuthenticatedTestApp();
        const failures: unknown[] = [];
        app.addHook('onSend', async (request, reply, payload) => {
            if (reply.statusCode >= 400 && request.method === 'POST') failures.push({ path: request.url, status: reply.statusCode, payload });
        });
        app.addHook('onRequest', async request => { request.headers['x-test-user-id'] = account.id; });
        // The retained Run RPC is an external Machine transport boundary. All
        // source admission, policy, HTTP, persistence and delivery logic is real.
        app.decorate('forwardRpcForUser', async () => ({ ok: true, result: { sessionId: parent.id, runId: 'exact-run',
            status: terminal ? terminalStatus : 'running', terminalEventId: terminal ? terminalEventId : null } }));
        registerSessionFollowSourceRoutes(app);
        registerSessionFollowRoutes(app);
        artifactsRoutes(app);
        const serverHttpBaseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
        const source = kind === 'execution_run' ? { kind, sessionId: parent.id, runId: 'exact-run' } : { kind, runId: run.id };
        const original = kind === 'execution_run' ? { source, terminalEventId: 'exact-terminal' } : { source, revision: 2 };
        const path = resolveSessionFollowActionRequest('follow.set', { receiver: { kind: 'account' }, source,
            policy: { preset: 'important' } }).path;
        const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: account.id })).toString('base64url')}.fixture`, encryption: null };
        const signal = new AbortController().signal;
        const pushes: unknown[][] = [];
        try {
            expect((await app.inject({ method: 'PUT', url: path, payload: { policy: { preset: 'important' } } })).statusCode).toBe(200);
            const { createInvocationSavedSecretOperationContextV1 } = await vi.importActual<{
                createInvocationSavedSecretOperationContextV1(input: unknown): unknown;
            }>('../../../../../../cli/src/settings/secrets/savedSecretOperationContext');
            const { createAccountArtifactStore } = await vi.importActual<{
                createAccountArtifactStore(input: unknown): { list(): Promise<{ items: { artifactId: string }[] }>; read(id: string): Promise<{ header: unknown; body: unknown } | null> };
            }>('../../../../../../cli/src/api/artifacts/accountArtifactStore');
            const { createPersonalFollowOccurrenceDispatcher } = await vi.importActual<{
                createPersonalFollowOccurrenceDispatcher(input: unknown): (input: unknown) => Promise<unknown>;
            }>('../../../../../../cli/src/notifications/activity/dispatchPersonalFollowOccurrence');
            const { createSessionFollowOccurrenceDispatcher } = await vi.importActual<{
                createSessionFollowOccurrenceDispatcher(input: unknown): { dispatch(input: unknown): Promise<unknown>;
                    dispatchAccountSourceRange(input: unknown): Promise<unknown>; dispose(): void };
            }>('../../../../../../cli/src/agent/runtime/session/follow/sessionFollowOccurrenceDispatcher');
            const { createWorkflowRunCommittedNotificationHandler } = await vi.importActual<{
                createWorkflowRunCommittedNotificationHandler(input: unknown): (input: unknown) => Promise<void>;
            }>('../../../../../../cli/src/notifications/activity/dispatchWorkflowRunUpdateNotification');
            const { resolveAccountSettingsScopeKey } = await vi.importActual<{ resolveAccountSettingsScopeKey(input: unknown): string }>(
                '../../../../../../cli/src/settings/accountSettings/accountSettingsScopeKey');
            const { runWithServerHttpBaseUrl } = await vi.importActual<{ runWithServerHttpBaseUrl<T>(url: string, run: () => T): T }>(
                '../../../../../../cli/src/api/client/serverHttpBaseUrl');
            const settings = accountSettingsParse({});
            const snapshot = { source: 'network', settings, rawSettings: {}, settingsVersion: 1, loadedAtMs: 1,
                settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials), notificationChannelCatalog: { status: 'ready', revision: 1,
                    diagnostics: [], channels: [NotificationChannelRecordV1Schema.parse({ v: 1, id: 'push', kind: 'expo_push', topics: {} })] } };
            const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl, isCurrent: async () => true,
                snapshot });
            const store = createAccountArtifactStore({ credentials, getAccountEncryptionMode: async () => 'plain' });
            const personal = (input: unknown, isCurrent: () => Promise<boolean>) => createPersonalFollowOccurrenceDispatcher({ operationContext, isCurrent,
                pluginNotifications: null, usageNoticeArtifactStore: { accountId: account.id, store },
                readAccountSessionDeliveryMutedScopes: async () => [],
                expoPushSender: { sendToAllDevicesAsync: async (...args: unknown[]) => { pushes.push(args); return true; } } })(input);
            const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: account.id, credentials, serverId: 'home', serverHttpBaseUrl,
                machineId: machine.id, installationId: machine.installationId!, signal,
                isCurrent: async () => true, subscribeInvalidation: () => () => {}, resolveSourceKeyContext: async () => null,
                isPersonalCurrent: async () => true, dispatchPersonal: personal });
            try {
                terminal = true;
                await db.automationRun.update({ where: { id: run.id }, data: { state: terminalStatus, revision: 2 } });
                const dispatch = () => entry === 'hint' ? dispatcher.dispatch({ original }) : dispatcher.dispatchAccountSourceRange(
                    kind === 'execution_run' ? { sourceSessionId: parent.id } : { workflowRunIds: [run.id] });
                await Promise.all([dispatch(), dispatch()])
                    .catch(error => { throw new Error(JSON.stringify(failures), { cause: error }); });
                await dispatch();
                expect(pushes).toHaveLength(expectedPushes);
                if (kind === 'workflow_run') {
                    const implicitNotify = createWorkflowRunCommittedNotificationHandler({
                        followSource: { token: credentials.token, serverHttpBaseUrl }, getSettingsSnapshot: () => snapshot,
                        expoPushSender: { sendToAllDevicesAsync: async (...args: unknown[]) => { pushes.push(args); return true; } },
                    });
                    await implicitNotify({ run: { id: run.id }, result: { state: terminalStatus } });
                    expect(pushes).toHaveLength(expectedPushes);
                }
                if (expectedPushes) expect(pushes[0]?.[2]).toMatchObject({ followOriginal: original });
                const notices = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.list());
                expect(notices.items).toHaveLength(1);
                expect(readAccountNoticeArtifactV1((await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.read(notices.items[0]!.artifactId)))!)).toMatchObject({
                    notice: { topic: 'follow_update', follow: { original, event: { kind: terminalStatus === 'succeeded' ? 'finished' : 'failed_or_stopped' } } },
                });
                const row = await db.accountSessionFollow.findFirstOrThrow({ where: { accountId: account.id } });
                expect(kind === 'execution_run' ? row.deliveredExecutionRunTerminalEventId : row.deliveredWorkflowRunRevision)
                    .toBe(kind === 'execution_run' ? 'exact-terminal' : 2);
                expect(await db.sessionPendingMessage.count({ where: { sessionId: parent.id } })).toBe(0);
                expect(await changeDeliveryMute({ accountId: account.id, receiver: { kind: 'account' }, scope: { kind: 'source', source },
                    authentication: createPresentUserSessionAccessAuthentication({ env: {} }), operation: 'set' })).toMatchObject({ ok: true });
                terminalEventId = 'later-terminal';
                await db.automationRun.update({ where: { id: run.id }, data: { revision: 3 } });
                const laterOriginal = kind === 'execution_run' ? { source, terminalEventId } : { source, revision: 3 };
                await dispatcher.dispatch({ original: laterOriginal });
                expect(pushes).toHaveLength(expectedPushes);
                expect(await changeDeliveryMute({ accountId: account.id, receiver: { kind: 'account' }, scope: { kind: 'source', source },
                    authentication: createPresentUserSessionAccessAuthentication({ env: {} }), operation: 'remove' })).toMatchObject({ ok: true });
                expect((await app.inject({ method: 'DELETE', url: path })).statusCode).toBe(200);
                await dispatcher.dispatch({ original: laterOriginal });
                expect(pushes).toHaveLength(expectedPushes);
                const suppressed = await db.accountSessionFollow.findFirstOrThrow({ where: { accountId: account.id } });
                expect(kind === 'execution_run' ? suppressed.deliveredExecutionRunTerminalEventId : suppressed.deliveredWorkflowRunRevision)
                    .toBe(kind === 'execution_run' ? 'exact-terminal' : 2);
            } finally { dispatcher.dispose(); }
        } finally { await app.close(); }
    });
});
