import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, createSessionMessagesFixture, flushHookEffects, renderHook } from '@/dev/testkit';
import { createReducer } from "@happier-dev/session-core/reducer";
import { createPlainSessionByIdResponseFixture, createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { SessionMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import type { FetchUserMessageHistoryPageResult } from '@/sync/engine/sessions/fetchUserMessageHistoryPage';

const account = createProviderSettingsAccountHarness();
const { storage } = await import('@/sync/domains/state/storageStore');
const { useUserMessageHistoryEntries } = await import('./useUserMessageHistoryEntries');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const {
    USER_MESSAGE_HISTORY_REMOTE_RETRY_COOLDOWN_MS,
    resetUserMessageHistoryRemoteEntriesForTests,
    useUserMessageHistory,
    useUserMessageHistoryRemoteEntries,
} = await import('./useUserMessageHistory');

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Response sequencing is at the genuine HTTP boundary. Sync admission, paging,
// stored-content parsing and row projection stay real for every scenario.
const historyPageHttpReply = vi.fn<(sessionId: string, options: { limit: number; beforeSeq?: number }) => Promise<FetchUserMessageHistoryPageResult>>();
let serverId = '';
const roleQuerySupportedState = {
    set supported(supported: boolean) {
        const features = createRootLayoutFeaturesResponse();
        features.capabilities.session.messages.role = supported;
        account.home.answer(serverId, '/v1/features', { body: features });
        account.home.answer(serverId, '/v1/features/authenticated', { body: features });
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    },
};

function installHistoryHttpPage(sessionId: string) {
    const path = `/v1/sessions/${sessionId}/messages`;
    account.home.answer(serverId, path, { select: async () => {
        const request = account.home.requests.filter(request => request.path.startsWith(`${path}?`)).at(-1);
        if (!request) throw new Error('History request did not reach HTTP');
        const query = new URL(request.path, 'https://history.test').searchParams;
        expect(query.get('role')).toBe('user');
        expect(query.get('roles')).toBe('user,agent');
        const page = await historyPageHttpReply(sessionId, { limit: Number(query.get('limit')),
            ...(query.has('beforeSeq') ? { beforeSeq: Number(query.get('beforeSeq')) } : {}) });
        if (page.status !== 'loaded') return { status: page.status === 'unsupported' ? 400 : 503, body: {} };
        return { body: SessionMessagesPageV1Schema.parse({ messages: page.rows.map(row => ({
            id: row.messageId, seq: row.seq, createdAt: row.createdAt, localId: null,
            messageRole: row.role === 'user' ? 'user' : 'agent',
            content: { t: 'plain', v: row.role === 'user'
                ? { role: 'user', content: { type: 'text', text: row.text } }
                : { role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: row.messageId,
                    message: { role: 'assistant', content: row.role === 'tool'
                        ? [{ type: 'tool_use', id: row.messageId, name: row.text, input: {} }]
                        : [{ type: 'text', text: row.text }] } } } },
            },
        })), hasMore: page.hasMore, nextBeforeSeq: page.nextBeforeSeq }) };
    } });
}

async function switchAccount(accountId: string) {
    ({ serverId } = await account.restore({ accountId }));
    storage.setState({ sessions: { s1: createSessionFixture({ id: 's1', serverId }), s2: createSessionFixture({ id: 's2', serverId }) },
        sessionListRowsByServerId: {} });
    roleQuerySupportedState.supported = true;
}

describe('useUserMessageHistory server role query', () => {
    beforeEach(async () => {
        await account.reset();
        ({ serverId } = await account.restore({ accountId: 'account-1' }));
        historyPageHttpReply.mockReset();
        roleQuerySupportedState.supported = true;
        for (const sessionId of ['s1', 's2', 'newer', 'older']) installHistoryHttpPage(sessionId);
        storage.setState((state) => ({
            ...state,
            profileScope: { serverId, accountId: 'account-1' },
            sessionMessages: {},
            sessions: { s1: createSessionFixture({ id: 's1', serverId }), s2: createSessionFixture({ id: 's2', serverId }) },
            sessionListRowsByServerId: {},
        }));
    });

    afterEach(async () => {
        vi.useRealTimers();
        vi.clearAllMocks();
        resetUserMessageHistoryRemoteEntriesForTests();
        roleQuerySupportedState.supported = true;
        storage.setState((state) => ({
            ...state,
            sessionMessages: {},
        }));
        await account.reset();
    });

    it('hydrates a list-only Session for Sent before without hydrating its transcript', async () => {
        const sessionId = 'list-only-history';
        const text = 'transcript fixture: a prompt from another Session';
        const session = createSessionFixture({ id: sessionId, serverId });
        storage.setState({ sessions: {}, sessionMessages: {}, sessionListRowsByServerId: {
            [serverId]: { [sessionId]: createSessionListRenderableSessionFixture({ id: sessionId }) },
        } });
        account.home.answer(serverId, `/v2/sessions/${sessionId}`, {
            body: createPlainSessionByIdResponseFixture(session),
        });
        installHistoryHttpPage(sessionId);
        historyPageHttpReply.mockResolvedValueOnce({ status: 'loaded', rows: [
            { messageId: 'older-prompt', routeMessageId: 'server:older-prompt', seq: 7, createdAt: 70, role: 'user', text },
        ], hasMore: false, nextBeforeSeq: null });
        const hook = await renderHook(() => useUserMessageHistoryEntries({ scope: 'global', enabled: true }));
        expect(hook.getCurrent().coverage).toBe('loaded');
        expect(historyPageHttpReply).not.toHaveBeenCalled();
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(hook.getCurrent().entries).toEqual([
            { serverId, sessionId, messageId: 'older-prompt', seq: 7, createdAtMs: 70, text },
        ]);
        expect(hook.getCurrent().error).toBe(false);
        expect(hook.getCurrent().coverage).toBe('partial');
        expect(hook.getCurrent().hasMore).toBe(false);
        expect(storage.getState().sessionMessages[sessionId]?.messageIdsOldestFirst ?? []).toEqual([]);
        await hook.unmount();
    });

    it('opens an unhydrated E2EE Session reader before paging Sent before', async () => {
        const { Encryption } = await import('@/sync/encryption/encryption');
        const { encodeBase64 } = await import('@/encryption/base64');
        const { sealEncryptedDataKeyEnvelopeV1 } = await import('@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1');
        const { V2SessionByIdResponseSchema } = await import('@happier-dev/protocol/sessions/control/contract');
        const secret = new Uint8Array(32).fill(7);
        ({ serverId } = await account.restore({ accountId: 'account-1', e2eeSecret: secret }));
        roleQuerySupportedState.supported = true;
        const sessionId = 'encrypted-list-only-history';
        const writer = await Encryption.create(secret);
        const dataKey = new Uint8Array(32).fill(8);
        await writer.initializeSessions(new Map([[sessionId, dataKey]]));
        const cipher = writer.getSessionEncryption(sessionId)!;
        const text = 'transcript fixture: an encrypted prompt from another Session';
        const metadata = await cipher.encryptRaw({ path: '/repo', host: 'fixture' });
        const { ownerMetadata: _ownerMetadata, ...sessionRecord } = createPlainSessionByIdResponseFixture(
            createSessionFixture({ id: sessionId, serverId }),
        ).session;
        account.home.answer(serverId, `/v2/sessions/${sessionId}`, { body: V2SessionByIdResponseSchema.parse({ session: {
            ...sessionRecord, metadataLayoutVersion: 0,
            id: sessionId, seq: 7, createdAt: 1, updatedAt: 70, active: false, activeAt: 1,
            encryptionMode: 'e2ee', metadata, metadataVersion: 1, agentState: null, agentStateVersion: 0, share: null,
            dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({
                dataKey, recipientPublicKey: writer.contentDataKey, randomBytes: length => new Uint8Array(length).fill(3),
            }), 'base64'),
        } }) });
        account.home.answer(serverId, `/v1/sessions/${sessionId}/messages`, { body: SessionMessagesPageV1Schema.parse({
            messages: [{ id: 'encrypted-prompt', seq: 7, createdAt: 70, localId: null, messageRole: 'user',
                content: { t: 'encrypted', c: await cipher.encryptRaw({ role: 'user', content: { type: 'text', text } }) } }],
            hasMore: false, nextBeforeSeq: null,
        }) });
        storage.setState({ sessions: {}, sessionMessages: {}, sessionListRowsByServerId: {
            [serverId]: { [sessionId]: createSessionListRenderableSessionFixture({ id: sessionId, encryptionMode: 'e2ee' }) },
        } });
        const hook = await renderHook(() => useUserMessageHistoryEntries({ scope: 'global', enabled: true }));
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(hook.getCurrent().entries.map(row => row.text)).toEqual([text]);
        expect(hook.getCurrent().error).toBe(false);
        expect(hook.getCurrent().hasMore).toBe(false);
        expect(storage.getState().sessionMessages[sessionId]?.messageIdsOldestFirst ?? []).toEqual([]);
        await hook.unmount();
    });

    it('pages global sent history from unhydrated sessions in recency order, one page per demand', async () => {
        storage.setState({
            sessions: {
                older: createSessionFixture({ id: 'older', serverId, updatedAt: 100, meaningfulActivityAt: 10 }),
                newer: createSessionFixture({ id: 'newer', serverId, updatedAt: 20, meaningfulActivityAt: 20 }),
                otherHome: createSessionFixture({ id: 'otherHome', serverId: 'server-2', updatedAt: 30 }),
            },
            sessionListRowsByServerId: {},
        });
        historyPageHttpReply
            .mockResolvedValueOnce({ status: 'loaded', rows: [
                { messageId: 'm9', routeMessageId: 'server:m9', seq: 9, createdAt: 90, role: 'user', text: 'repeat' },
                { messageId: 'a9', routeMessageId: 'server:a9', seq: 10, createdAt: 91, role: 'assistant', text: 'answer' },
            ], hasMore: true, nextBeforeSeq: 9 })
            .mockResolvedValueOnce({ status: 'loaded', rows: [
                { messageId: 'm4', routeMessageId: 'server:m4', seq: 4, createdAt: 40, role: 'user', text: 'repeat' },
            ], hasMore: false, nextBeforeSeq: null })
            .mockResolvedValueOnce({ status: 'loaded', rows: [
                { messageId: 'm9', routeMessageId: 'server:m9', seq: 9, createdAt: 9, role: 'user', text: 'older session' },
            ], hasMore: false, nextBeforeSeq: null });
        const hook = await renderHook(() => useUserMessageHistoryEntries({ scope: 'global', enabled: true }));
        expect(historyPageHttpReply).not.toHaveBeenCalled();
        expect(hook.getCurrent().coverage).toBe('loaded');
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(historyPageHttpReply).toHaveBeenCalledTimes(1);
        expect(historyPageHttpReply).toHaveBeenNthCalledWith(1, 'newer', { limit: 40 });
        expect(hook.getCurrent().entries).toEqual([
            { serverId, sessionId: 'newer', messageId: 'm9', seq: 9, createdAtMs: 90, text: 'repeat' },
        ]);
        expect(hook.getCurrent().coverage).toBe('partial');
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(historyPageHttpReply).toHaveBeenNthCalledWith(2, 'newer', { limit: 40, beforeSeq: 9 });
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(historyPageHttpReply).toHaveBeenNthCalledWith(3, 'older', { limit: 40 });
        expect(hook.getCurrent().entries.map((entry) => [entry.sessionId, entry.messageId, entry.text])).toEqual([
            ['newer', 'm9', 'repeat'], ['newer', 'm4', 'repeat'], ['older', 'm9', 'older session'],
        ]);
        expect(hook.getCurrent().progress).toEqual({ pagesLoaded: 3, sessionsSearched: 2, totalSessions: 2 });
        expect(hook.getCurrent().hasMore).toBe(false);
        // Ordinary/archived/query membership is paged and cannot attest an entire Account inventory.
        expect(hook.getCurrent().coverage).toBe('partial');
        await hook.unmount();
    });

    it('keeps disabled history inert and Stop rejects late publication while leaving the shared page usable', async () => {
        const page = createDeferred<FetchUserMessageHistoryPageResult>();
        historyPageHttpReply.mockReturnValueOnce(page.promise);
        const hook = await renderHook(
            (props: { enabled: boolean }) => useUserMessageHistoryEntries({ scope: 'perSession', sessionId: 's1', enabled: props.enabled }),
            { initialProps: { enabled: false } },
        );
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(historyPageHttpReply).not.toHaveBeenCalled();
        await hook.rerender({ enabled: true });
        let pending!: Promise<void>;
        await act(async () => { pending = hook.getCurrent().loadMore(); });
        expect(hook.getCurrent().isLoading).toBe(true);
        await act(async () => {
            hook.getCurrent().stop();
            page.resolve({ status: 'loaded', rows: [
                { messageId: 'm1', routeMessageId: 'server:m1', seq: 1, createdAt: 1, role: 'user', text: 'late' },
            ], hasMore: false, nextBeforeSeq: null });
            await pending;
        });
        expect(hook.getCurrent().entries).toEqual([]);
        expect(hook.getCurrent().isLoading).toBe(false);
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(hook.getCurrent().entries[0]?.text).toBe('late');
        expect(hook.getCurrent().coverage).toBe('complete');
        expect(historyPageHttpReply).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });

    it('does not publish an old Account page into the newly addressed history', async () => {
        const page = createDeferred<FetchUserMessageHistoryPageResult>();
        historyPageHttpReply.mockReturnValueOnce(page.promise);
        const hook = await renderHook(() => useUserMessageHistoryEntries({ scope: 'perSession', sessionId: 's1' }));
        let pending!: Promise<void>;
        await act(async () => { pending = hook.getCurrent().loadMore(); });
        await act(async () => {
            await switchAccount('account-2');
            await hook.rerender();
            page.resolve({ status: 'loaded', rows: [
                { messageId: 'm1', routeMessageId: 'server:m1', seq: 1, createdAt: 1, role: 'user', text: 'private old Account' },
            ], hasMore: false, nextBeforeSeq: null });
            await pending;
        });
        expect(hook.getCurrent().entries).toEqual([]);
        expect(hook.getCurrent().coverage).toBe('loaded');
        historyPageHttpReply.mockResolvedValueOnce({ status: 'loaded', rows: [], hasMore: false, nextBeforeSeq: null });
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(historyPageHttpReply).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().coverage).toBe('complete');
        await hook.unmount();
    });

    it('retains readable records and immediately retries a failed older cursor on explicit demand', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        historyPageHttpReply
            .mockResolvedValueOnce({ status: 'loaded', rows: [
                { messageId: 'm9', routeMessageId: 'server:m9', seq: 9, createdAt: 9, role: 'user', text: 'readable' },
            ], hasMore: true, nextBeforeSeq: 9 })
            .mockResolvedValueOnce({ status: 'error' })
            .mockResolvedValueOnce({ status: 'loaded', rows: [], hasMore: false, nextBeforeSeq: null });
        const hook = await renderHook(() => useUserMessageHistoryEntries({ scope: 'perSession', sessionId: 's1' }));
        await act(async () => { await hook.getCurrent().loadMore(); });
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(hook.getCurrent().entries[0]?.text).toBe('readable');
        expect(hook.getCurrent().coverage).toBe('partial');
        expect(hook.getCurrent().error).toBe(true);
        expect(hook.getCurrent().isLoading).toBe(false);
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(historyPageHttpReply).toHaveBeenCalledTimes(2);
        await act(async () => { await hook.getCurrent().retry(); });
        expect(historyPageHttpReply).toHaveBeenCalledTimes(3);
        expect(historyPageHttpReply).toHaveBeenLastCalledWith('s1', { limit: 40, beforeSeq: 9 });
        expect(hook.getCurrent().entries[0]?.text).toBe('readable');
        expect(hook.getCurrent().coverage).toBe('complete');
        expect(hook.getCurrent().error).toBe(false);
        await hook.unmount();
    });

    it('reuses already read history when the picker reopens without issuing another page request', async () => {
        historyPageHttpReply.mockResolvedValueOnce({ status: 'loaded', rows: [
            { messageId: 'm1', routeMessageId: 'server:m1', seq: 1, createdAt: 1, role: 'user', text: 'retained prompt' },
        ], hasMore: false, nextBeforeSeq: null });
        const first = await renderHook(() => useUserMessageHistoryEntries({ scope: 'perSession', sessionId: 's1' }));
        await act(async () => { await first.getCurrent().loadMore(); });
        await first.unmount();
        const reopened = await renderHook(() => useUserMessageHistoryEntries({ scope: 'perSession', sessionId: 's1' }));
        expect(reopened.getCurrent().entries[0]?.text).toBe('retained prompt');
        expect(reopened.getCurrent().coverage).toBe('complete');
        expect(historyPageHttpReply).toHaveBeenCalledTimes(1);
        await reopened.unmount();
    });

    it('projects local display text and merges by message identity while old servers remain partial', async () => {
        storage.setState({ sessionMessages: { s1: createSessionMessagesFixture({
            messageIdsOldestFirst: ['internal-1'],
            messagesById: { 'internal-1': { kind: 'user-text', id: 'internal-1', realID: 'm1', localId: null, seq: 1,
                createdAt: 1, text: 'expanded body', displayText: '  readable prompt\n' } },
        }) } });
        roleQuerySupportedState.supported = false;
        const hook = await renderHook(() => useUserMessageHistoryEntries({ scope: 'perSession', sessionId: 's1' }));
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(historyPageHttpReply).not.toHaveBeenCalled();
        expect(hook.getCurrent().coverage).toBe('partial');
        expect(hook.getCurrent().error).toBe(true);
        expect(hook.getCurrent().entries).toEqual([
            { serverId, sessionId: 's1', messageId: 'm1', seq: 1, createdAtMs: 1, text: '  readable prompt\n' },
        ]);
        roleQuerySupportedState.supported = true;
        historyPageHttpReply.mockResolvedValueOnce({ status: 'loaded', rows: [
            { messageId: 'm1', routeMessageId: 'server:m1', seq: 1, createdAt: 1, role: 'user', text: '  readable prompt\n' },
        ], hasMore: false, nextBeforeSeq: null });
        await hook.rerender();
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(hook.getCurrent().entries).toHaveLength(1);
        expect(hook.getCurrent().coverage).toBe('complete');
        await hook.unmount();
    });

    it('keeps an explicitly addressed Home isolated from another active Home inventory', async () => {
        storage.setState({
            sessions: { s1: createSessionFixture({ id: 's1', serverId }) },
            sessionMessages: { s1: createSessionMessagesFixture({ messageIdsOldestFirst: ['m1'], messagesById: {
                m1: { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, text: 'private active Home' },
            } }) },
        });
        const hook = await renderHook(() => useUserMessageHistoryEntries({ scope: 'global', serverId: 'server-2' }));
        expect(hook.getCurrent().entries).toEqual([]);
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(historyPageHttpReply).not.toHaveBeenCalled();
        expect(hook.getCurrent().coverage).toBe('partial');
        expect(hook.getCurrent().error).toBe(true);
        await hook.unmount();
    });

    it('reads the latest history before certifying a shared cache that began below a loaded transcript window', async () => {
        historyPageHttpReply
            .mockResolvedValueOnce({ status: 'loaded', rows: [
                { messageId: 'm4', routeMessageId: 'server:m4', seq: 4, createdAt: 4, role: 'user', text: 'older navigation cache' },
            ], hasMore: false, nextBeforeSeq: null })
            .mockResolvedValueOnce({ status: 'loaded', rows: [
                { messageId: 'm9', routeMessageId: 'server:m9', seq: 9, createdAt: 9, role: 'user', text: 'latest prompt' },
            ], hasMore: true, nextBeforeSeq: 9 })
            .mockResolvedValueOnce({ status: 'loaded', rows: [], hasMore: false, nextBeforeSeq: null });
        const navigation = await renderHook(() => useUserMessageHistoryRemoteEntries({ sessionId: 's1', initialBeforeSeq: 20 }));
        await act(async () => { navigation.getCurrent().requestNextPage(); await flushHookEffects(); });
        await navigation.unmount();
        const hook = await renderHook(() => useUserMessageHistoryEntries({ scope: 'perSession', sessionId: 's1' }));
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(historyPageHttpReply).toHaveBeenNthCalledWith(2, 's1', { limit: 40 });
        expect(hook.getCurrent().entries.map((entry) => entry.text)).toEqual(['latest prompt', 'older navigation cache']);
        expect(hook.getCurrent().coverage).toBe('partial');
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(historyPageHttpReply).toHaveBeenNthCalledWith(3, 's1', { limit: 40, beforeSeq: 9 });
        expect(hook.getCurrent().coverage).toBe('complete');
        await hook.unmount();
    });

    it('shares one in-flight remote history page across same-scope consumers', async () => {
        const page = createDeferred<{
            status: 'loaded';
            rows: Array<{ messageId: string; routeMessageId: string; seq: number; createdAt: number; role: 'user'; text: string }>;
            hasMore: boolean;
            nextBeforeSeq: number | null;
        }>();
        historyPageHttpReply.mockReturnValueOnce(page.promise);

        const hook = await renderHook(() => {
            const first = useUserMessageHistoryRemoteEntries({
                enabled: true,
                initialBeforeSeq: null,
                sessionId: 's1',
            });
            const second = useUserMessageHistoryRemoteEntries({
                enabled: true,
                initialBeforeSeq: null,
                sessionId: 's1',
            });
            return { first, second };
        });

        await act(async () => {
            hook.getCurrent().first.requestNextPage();
            hook.getCurrent().second.requestNextPage();
            await flushHookEffects();
        });

        expect(historyPageHttpReply).toHaveBeenCalledTimes(1);
        expect(historyPageHttpReply).toHaveBeenCalledWith('s1', { limit: 40 });

        await act(async () => {
            page.resolve({
                status: 'loaded',
                rows: [{ messageId: 'm5', routeMessageId: 'server:m5', seq: 5, createdAt: 50, role: 'user' as const, text: 'shared prompt' }],
                hasMore: false,
                nextBeforeSeq: null,
            });
            await page.promise;
            await flushHookEffects();
        });

        expect(hook.getCurrent().first.rows).toEqual([{ messageId: 'm5', routeMessageId: 'server:m5', seq: 5, createdAt: 50, role: 'user' as const, text: 'shared prompt' }]);
        expect(hook.getCurrent().second.rows).toEqual([{ messageId: 'm5', routeMessageId: 'server:m5', seq: 5, createdAt: 50, role: 'user' as const, text: 'shared prompt' }]);
        await hook.unmount();
    });

    it('keys shared remote history by active server account scope', async () => {
        historyPageHttpReply
            .mockResolvedValueOnce({
                status: 'loaded',
                rows: [{ messageId: 'm5', routeMessageId: 'server:m5', seq: 5, createdAt: 50, role: 'user' as const, text: 'account one prompt' }],
                hasMore: false,
                nextBeforeSeq: null,
            })
            .mockResolvedValueOnce({
                status: 'loaded',
                rows: [{ messageId: 'm5', routeMessageId: 'server:m5', seq: 5, createdAt: 50, role: 'user' as const, text: 'account two prompt' }],
                hasMore: false,
                nextBeforeSeq: null,
            });

        const hook = await renderHook(() =>
            useUserMessageHistoryRemoteEntries({
                enabled: true,
                initialBeforeSeq: null,
                sessionId: 's1',
            }),
        );

        await act(async () => {
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });
        expect(hook.getCurrent().rows.map((entry) => entry.text)).toEqual(['account one prompt']);

        await act(async () => {
            await switchAccount('account-2');
            await hook.rerender();
        });

        await act(async () => {
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });

        expect(historyPageHttpReply).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().rows.map((entry) => entry.text)).toEqual(['account two prompt']);
        await hook.unmount();
    });

    it('reuses shared remote entries when composer history warms up later', async () => {
        historyPageHttpReply.mockResolvedValueOnce({
            status: 'loaded',
            rows: [{ messageId: 'm5', routeMessageId: 'server:m5', seq: 5, createdAt: 50, role: 'user' as const, text: 'cached remote prompt' }],
            hasMore: false,
            nextBeforeSeq: null,
        });

        const remoteHook = await renderHook(() =>
            useUserMessageHistoryRemoteEntries({
                enabled: true,
                initialBeforeSeq: null,
                sessionId: 's1',
            }),
        );
        await act(async () => {
            remoteHook.getCurrent().requestNextPage();
            await flushHookEffects();
        });
        await remoteHook.unmount();

        const historyHook = await renderHook(() =>
            useUserMessageHistory({ scope: 'perSession', sessionId: 's1', maxEntries: 20 }),
        );
        await act(async () => {
            historyHook.getCurrent().warmup();
            await flushHookEffects();
        });

        expect(historyPageHttpReply).toHaveBeenCalledTimes(1);
        expect(historyHook.getCurrent().moveUp('draft')).toBe('cached remote prompt');
        await historyHook.unmount();
    });

    it('preserves repeated remote prompt text as distinct seq-backed entries', async () => {
        historyPageHttpReply.mockResolvedValueOnce({
            status: 'loaded',
            rows: [
                { messageId: 'm8', routeMessageId: 'server:m8', seq: 8, createdAt: 80, role: 'user' as const, text: 'repeat this' },
                { messageId: 'm4', routeMessageId: 'server:m4', seq: 4, createdAt: 40, role: 'user' as const, text: 'repeat this' },
            ],
            hasMore: false,
            nextBeforeSeq: null,
        });

        const hook = await renderHook(() =>
            useUserMessageHistoryRemoteEntries({
                enabled: true,
                initialBeforeSeq: null,
                sessionId: 's1',
            }),
        );

        await act(async () => {
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });

        expect(hook.getCurrent().rows.map((entry) => entry.seq)).toEqual([8, 4]);
        expect(hook.getCurrent().rows.map((entry) => entry.text)).toEqual(['repeat this', 'repeat this']);
        await hook.unmount();
    });

    it('extends the cached record when the transcript cursor moves older instead of refetching from scratch', async () => {
        historyPageHttpReply
            .mockResolvedValueOnce({
                status: 'loaded',
                rows: [{ messageId: 'm9', routeMessageId: 'server:m9', seq: 9, createdAt: 90, role: 'user' as const, text: 'first page' }],
                hasMore: true,
                nextBeforeSeq: 9,
            })
            .mockResolvedValueOnce({
                status: 'loaded',
                rows: [{ messageId: 'm4', routeMessageId: 'server:m4', seq: 4, createdAt: 40, role: 'user' as const, text: 'second page' }],
                hasMore: false,
                nextBeforeSeq: null,
            });

        const hook = await renderHook(
            (props: { initialBeforeSeq: number }) =>
                useUserMessageHistoryRemoteEntries({
                    enabled: true,
                    initialBeforeSeq: props.initialBeforeSeq,
                    sessionId: 's1',
                }),
            { initialProps: { initialBeforeSeq: 20 } },
        );

        await act(async () => {
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });
        expect(hook.getCurrent().rows.map((row) => row.text)).toEqual(['first page']);

        // Loading older transcript messages moves the cursor the host would seed with.
        await hook.rerender({ initialBeforeSeq: 12 });
        await act(async () => {
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });

        expect(historyPageHttpReply).toHaveBeenNthCalledWith(2, 's1', { limit: 40, beforeSeq: 9 });
        expect(hook.getCurrent().rows.map((row) => row.text)).toEqual(['first page', 'second page']);
        await hook.unmount();
    });

    it('keeps agent rows out of composer history while sharing one fetched page', async () => {
        historyPageHttpReply.mockResolvedValueOnce({
            status: 'loaded',
            rows: [
                { messageId: 'm5', routeMessageId: 'server:m5', seq: 5, createdAt: 50, role: 'user' as const, text: 'a prompt' },
                { messageId: 'm6', routeMessageId: 'server:m6', seq: 6, createdAt: 60, role: 'assistant' as const, text: 'an answer' },
            ],
            hasMore: false,
            nextBeforeSeq: null,
        });

        const hook = await renderHook(() =>
            useUserMessageHistory({ scope: 'perSession', sessionId: 's1', maxEntries: 20 }),
        );

        await act(async () => {
            hook.getCurrent().warmup();
            await flushHookEffects();
        });

        expect(hook.getCurrent().moveUp('draft')).toBe('a prompt');
        expect(hook.getCurrent().moveUp('a prompt')).toBe('a prompt');
        await hook.unmount();
    });

    it('walks the newest remote prompt first when the real history fetch produces the page', async () => {
        // The raw stored wire retains expanded text and authored display text separately.
        // Real Sync, content parsing and the history projection decide what is replayed.
        const serverPage = {
            // A `beforeSeq` page comes back newest-first from the server.
            messages: [3, 2, 1].map((seq) => ({
                id: `m${seq}`,
                seq,
                localId: null,
                messageRole: 'user' as const,
                content: { t: 'plain' as const, v: {
                    role: 'user', content: { type: 'text', text: `expanded prompt ${seq}` },
                    meta: { displayText: `  prompt ${seq}\n` },
                } },
                createdAt: seq * 10,
            })),
            hasMore: false,
            nextBeforeSeq: null,
        };
        account.home.answer(serverId, '/v1/sessions/s1/messages', { body: SessionMessagesPageV1Schema.parse(serverPage) });

        const hook = await renderHook(() =>
            useUserMessageHistory({ scope: 'perSession', sessionId: 's1', maxEntries: 20 }),
        );

        await act(async () => {
            hook.getCurrent().warmup();
            await flushHookEffects();
        });

        expect(hook.getCurrent().moveUp('draft')).toBe('  prompt 3\n');
        expect(hook.getCurrent().moveUp('  prompt 3\n')).toBe('  prompt 2\n');
        expect(hook.getCurrent().moveUp('  prompt 2\n')).toBe('  prompt 1\n');
        await hook.unmount();
    });

    it('keeps the cursor retryable until the addressed Session shell is hydrated', async () => {
        storage.setState({ sessions: {}, sessionListRowsByServerId: {} });
        historyPageHttpReply.mockResolvedValueOnce({
                status: 'loaded',
                rows: [{ messageId: 'm3', routeMessageId: 'server:m3', seq: 3, createdAt: 30, role: 'user' as const, text: 'decrypted later' }],
                hasMore: false,
                nextBeforeSeq: null,
            });

        const hook = await renderHook(() =>
            useUserMessageHistoryRemoteEntries({
                enabled: true,
                initialBeforeSeq: null,
                sessionId: 's1',
                serverId,
            }),
        );

        await act(async () => {
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });
        expect(hook.getCurrent().pendingEncryption).toBe(true);
        expect(hook.getCurrent().hasMore).toBe(true);
        expect(historyPageHttpReply).not.toHaveBeenCalled();

        await act(async () => {
            storage.setState({ sessions: { s1: createSessionFixture({ id: 's1', serverId }) } });
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });

        expect(hook.getCurrent().rows.map((row) => row.text)).toEqual(['decrypted later']);
        expect(hook.getCurrent().pendingEncryption).toBe(false);
        await hook.unmount();
    });

    it('loads server user messages on warmup when no local per-session history is loaded', async () => {
        historyPageHttpReply.mockResolvedValueOnce({
            status: 'loaded',
            rows: [{ messageId: 'm3', routeMessageId: 'server:m3', seq: 3, createdAt: 30, role: 'user' as const, text: 'from server' }],
            hasMore: false,
            nextBeforeSeq: null,
        });

        const hook = await renderHook(() =>
            useUserMessageHistory({ scope: 'perSession', sessionId: 's1', maxEntries: 20 }),
        );

        await act(async () => {
            hook.getCurrent().warmup();
            await flushHookEffects();
        });

        expect(historyPageHttpReply).toHaveBeenCalledWith('s1', {
            limit: 40,
        });
        expect(hook.getCurrent().moveUp('draft')).toBe('from server');
        await hook.unmount();
    });

    it('does not query old servers without session message role capability', async () => {
        roleQuerySupportedState.supported = false;
        const hook = await renderHook(() =>
            useUserMessageHistory({ scope: 'perSession', sessionId: 's1', maxEntries: 20 }),
        );

        await act(async () => {
            hook.getCurrent().warmup();
            await flushHookEffects();
        });

        expect(historyPageHttpReply).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('cools a failing remote history cursor down before retrying it', async () => {
        // Only the clock is faked: the retry floor is wall-clock based and the rest of the
        // hook still runs on real microtasks.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        historyPageHttpReply
            .mockResolvedValueOnce({ status: 'error' })
            .mockResolvedValueOnce({
                status: 'loaded',
                rows: [{ messageId: 'm3', routeMessageId: 'server:m3', seq: 3, createdAt: 30, role: 'user' as const, text: 'retried prompt' }],
                hasMore: false,
                nextBeforeSeq: null,
            });

        const hook = await renderHook(() =>
            useUserMessageHistoryRemoteEntries({
                enabled: true,
                initialBeforeSeq: null,
                sessionId: 's1',
            }),
        );

        await act(async () => {
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });
        expect(hook.getCurrent().rows).toEqual([]);
        expect(historyPageHttpReply).toHaveBeenCalledTimes(1);
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(hook.getCurrent().failure).toBe('error');
        });

        // A failed page leaves the cursor unchanged, so the transcript-navigation continuation
        // effect re-drives it on every transcript store update. Those must not reach the wire.
        await act(async () => {
            hook.getCurrent().requestNextPage();
            hook.getCurrent().requestNextPage();
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });
        expect(historyPageHttpReply).toHaveBeenCalledTimes(1);

        vi.setSystemTime(Date.now() + USER_MESSAGE_HISTORY_REMOTE_RETRY_COOLDOWN_MS);
        await act(async () => {
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });

        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(hook.getCurrent().rows.map((entry) => entry.text)).toEqual(['retried prompt']);
        });
        expect(historyPageHttpReply).toHaveBeenCalledTimes(2);
        await hook.unmount();
    });

    it('cools the cursor down when the remote history request rejects outright', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        historyPageHttpReply.mockRejectedValueOnce(new Error('offline'));

        const hook = await renderHook(() =>
            useUserMessageHistoryRemoteEntries({
                enabled: true,
                initialBeforeSeq: null,
                sessionId: 's1',
            }),
        );

        await act(async () => {
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });

        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(hook.getCurrent().failure).toBe('error');
        });

        await act(async () => {
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });

        expect(historyPageHttpReply).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().hasMore).toBe(true);
        await hook.unmount();
    });

    it('prefetches before reaching the oldest loaded user message and stops after exhaustion', async () => {
        historyPageHttpReply
            .mockResolvedValueOnce({
                status: 'loaded',
                rows: [
                    { messageId: 'm10', routeMessageId: 'server:m10', seq: 10, createdAt: 100, role: 'user' as const, text: 'ten' },
                    { messageId: 'm9', routeMessageId: 'server:m9', seq: 9, createdAt: 90, role: 'user' as const, text: 'nine' },
                    { messageId: 'm8', routeMessageId: 'server:m8', seq: 8, createdAt: 80, role: 'user' as const, text: 'eight' },
                    { messageId: 'm7', routeMessageId: 'server:m7', seq: 7, createdAt: 70, role: 'user' as const, text: 'seven' },
                ],
                hasMore: true,
                nextBeforeSeq: 7,
            })
            .mockResolvedValueOnce({
                status: 'loaded',
                rows: [],
                hasMore: false,
                nextBeforeSeq: null,
            });

        const hook = await renderHook(() =>
            useUserMessageHistory({ scope: 'perSession', sessionId: 's1', maxEntries: 20 }),
        );

        await act(async () => {
            hook.getCurrent().warmup();
            await flushHookEffects();
        });

        expect(hook.getCurrent().moveUp('draft')).toBe('ten');

        await act(async () => {
            expect(hook.getCurrent().moveUp('ten')).toBe('nine');
            await flushHookEffects();
        });

        expect(historyPageHttpReply).toHaveBeenLastCalledWith('s1', {
            limit: 40,
            beforeSeq: 7,
        });

        await act(async () => {
            expect(hook.getCurrent().moveUp('nine')).toBe('eight');
            expect(hook.getCurrent().moveUp('eight')).toBe('seven');
            await flushHookEffects();
        });

        expect(historyPageHttpReply).toHaveBeenCalledTimes(2);
        await hook.unmount();
    });

    it('ignores a remote history page that resolves after switching sessions', async () => {
        const stalePage = createDeferred<{
            status: 'loaded';
            rows: Array<{ messageId: string; routeMessageId: string; seq: number; createdAt: number; role: 'user'; text: string }>;
            hasMore: boolean;
            nextBeforeSeq: number | null;
        }>();
        historyPageHttpReply.mockReturnValueOnce(stalePage.promise);

        const hook = await renderHook(
            (props: { sessionId: string }) =>
                useUserMessageHistory({ scope: 'perSession', sessionId: props.sessionId, maxEntries: 20 }),
            { initialProps: { sessionId: 's1' } },
        );

        await act(async () => {
            hook.getCurrent().warmup();
            await flushHookEffects();
        });

        storage.setState((state) => ({
            ...state,
            sessionMessages: {
                s2: {
                    messageIdsOldestFirst: ['s2-user'],
                    messagesById: {
                        's2-user': {
                            kind: 'user-text',
                            id: 's2-user',
                            localId: null,
                            createdAt: 40,
                            text: 'session two prompt',
                        },
                    },
                    messagesMap: {
                        's2-user': {
                            kind: 'user-text',
                            id: 's2-user',
                            localId: null,
                            createdAt: 40,
                            text: 'session two prompt',
                        },
                    },
                    reducerState: createReducer(),
                    latestThinkingMessageId: null,
                    latestThinkingMessageActivityAtMs: null,
                    latestReadyEventSeq: null,
                    latestReadyEventAt: null,
                    messagesVersion: 1,
                    lastAppliedAgentStateVersion: null,
                    isLoaded: true,
                },
            },
        }));
        await hook.rerender({ sessionId: 's2' });

        await act(async () => {
            stalePage.resolve({
                status: 'loaded',
                rows: [{ messageId: 'm3', routeMessageId: 'server:m3', seq: 3, createdAt: 30, role: 'user' as const, text: 'stale session one prompt' }],
                hasMore: false,
                nextBeforeSeq: null,
            });
            await stalePage.promise;
            await flushHookEffects();
        });

        historyPageHttpReply.mockResolvedValueOnce({
            status: 'loaded',
            rows: [],
            hasMore: false,
            nextBeforeSeq: null,
        });
        expect(hook.getCurrent().moveUp('draft')).toBe('session two prompt');
        await hook.unmount();
    });

    it('keeps active browsing state when role-query support becomes ready', async () => {
        roleQuerySupportedState.supported = false;
        storage.setState((state) => ({
            ...state,
            sessionMessages: {
                s1: {
                    messageIdsOldestFirst: ['older', 'newer'],
                    messagesById: {
                        older: { kind: 'user-text', id: 'older', localId: null, createdAt: 10, text: 'older prompt' },
                        newer: { kind: 'user-text', id: 'newer', localId: null, createdAt: 20, text: 'newer prompt' },
                    },
                    messagesMap: {
                        older: { kind: 'user-text', id: 'older', localId: null, createdAt: 10, text: 'older prompt' },
                        newer: { kind: 'user-text', id: 'newer', localId: null, createdAt: 20, text: 'newer prompt' },
                    },
                    reducerState: createReducer(),
                    latestThinkingMessageId: null,
                    latestThinkingMessageActivityAtMs: null,
                    latestReadyEventSeq: null,
                    latestReadyEventAt: null,
                    messagesVersion: 1,
                    lastAppliedAgentStateVersion: null,
                    isLoaded: true,
                },
            },
        }));

        const hook = await renderHook(() =>
            useUserMessageHistory({ scope: 'perSession', sessionId: 's1', maxEntries: 20 }),
        );

        expect(hook.getCurrent().moveUp('draft')).toBe('newer prompt');

        roleQuerySupportedState.supported = true;
        historyPageHttpReply.mockResolvedValue({
            status: 'loaded',
            rows: [],
            hasMore: false,
            nextBeforeSeq: null,
        });
        await hook.rerender();

        expect(hook.getCurrent().moveUp('newer prompt')).toBe('older prompt');
        await hook.unmount();
    });
});
