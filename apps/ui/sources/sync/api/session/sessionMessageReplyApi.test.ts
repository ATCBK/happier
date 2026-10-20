import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { readSessionMessageReply } = await import('./sessionMessageReplyApi');
beforeEach(async () => { await homes.reset(); });
afterEach(standardCleanup);

describe('original Session input reply read', () => {
    it('reads only the exact original input on its captured Home and preserves typed terminal outcomes', async () => {
        const serverId = await homes.addHome({ name: 'Original', serverUrl: 'https://reply.test', accountId: 'alice', currentAccount: true });
        const path = '/v2/sessions/receiver/messages/by-local-id/question%2F1/reply';
        homes.answer(serverId, path, { body: { v: 1, status: 'available', progress: {
            v: 1, mode: 'wait', disposition: 'released', outcome: { kind: 'pass' },
        } } });
        expect(await readSessionMessageReply({ scope: { serverId, accountId: 'alice' }, sessionId: 'receiver', localId: 'question/1' }))
            .toMatchObject({ status: 'available', progress: { outcome: { kind: 'pass' } } });
        expect(homes.requestsFor(path)).toHaveLength(1);
        expect(homes.requests.filter(request => request.path.includes('/messages') && request.path !== path)).toEqual([]);
    });

    it('rejects malformed progress and refuses to reinterpret an old Home as an empty answer', async () => {
        const serverId = await homes.addHome({ name: 'Original', serverUrl: 'https://reply.test', accountId: 'alice', currentAccount: true });
        const path = '/v2/sessions/receiver/messages/by-local-id/question/reply';
        const params = { scope: { serverId, accountId: 'alice' }, sessionId: 'receiver', localId: 'question' };
        homes.answer(serverId, path, { body: { v: 1, status: 'available', progress: {
            v: 1, mode: 'wait', disposition: 'inline', unexpectedAuthority: true,
        } } });
        expect(await readSessionMessageReply(params)).toEqual({ v: 1, status: 'unavailable' });
        homes.answer(serverId, path, { status: 404, body: { error: 'not_found' } });
        expect(await readSessionMessageReply(params)).toEqual({ v: 1, status: 'unavailable' });
    });

    it('drops an in-flight result after its captured view retires', async () => {
        const serverId = await homes.addHome({ name: 'Original', serverUrl: 'https://reply.test', accountId: 'alice', currentAccount: true });
        const ready = createDeferred<void>();
        const release = createDeferred<void>();
        homes.answer(serverId, '/v2/sessions/receiver/messages/by-local-id/question/reply', { select: async () => {
            ready.resolve();
            await release.promise;
            return { body: { v: 1, status: 'available', progress: { v: 1, mode: 'wait', disposition: 'inline', outcome: { kind: 'pass' } } } };
        } });
        let current = true;
        const read = readSessionMessageReply({ scope: { serverId, accountId: 'alice' }, sessionId: 'receiver', localId: 'question', isCurrent: () => current });
        await ready.promise;
        current = false;
        release.resolve();
        expect(await read).toEqual({ v: 1, status: 'unavailable' });
    });
});
