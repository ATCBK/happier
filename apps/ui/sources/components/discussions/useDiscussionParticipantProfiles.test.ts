import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { getStorage } from '@/sync/domains/state/storage';
import { resolveAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';
import { t } from '@/text';
import { standardCleanup } from '@/dev/testkit';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { TokenStorage, type HomeCredentialWriteRollback } from '@/auth/storage/tokenStorage';
import { useDiscussionParticipantProfiles } from './useDiscussionParticipantProfiles';

afterEach(standardCleanup);

function usePeople(input: Omit<Parameters<typeof useDiscussionParticipantProfiles>[0], 'accountLifetime'>) {
    const bindings = useServerCredentialAccountScopeBindings([input.scope.serverId]);
    return useDiscussionParticipantProfiles({ ...input, accountLifetime: bindings.get(input.scope.serverId) ?? null });
}

function roster(ownerAccountId: string) {
    return DiscussionParticipantsListResponseV1Schema.parse({
        discussionId: 'discussion-1', ownerAccountId, access: 'view', participants: [],
        grants: [{ principal: { kind: 'account', accountId: 'collaborator' }, accessLevel: 'edit',
            createdByAccountId: ownerAccountId, createdAt: 1, display: { name: 'Roster Name', username: 'colleague' } }],
    });
}

describe('useDiscussionParticipantProfiles', () => {
    it('resolves the owner and humans from the captured Home without borrowing the same Account on another Home', async () => {
        const home = await serveAccountHomes({
            homes: [{ key: 'captured', serverUrl: 'https://discussion-people.test', accountId: 'viewer' },
                { key: 'focused', serverUrl: 'https://discussion-other-people.test', accountId: 'owner' }],
            route: request => request.path.startsWith('/v1/user/') ? Response.json({ user: {
                id: request.path.split('/').at(-1), firstName: 'Captured', lastName: 'Person', username: 'person',
                avatar: { path: '/face.png', url: 'https://discussion-people.test/face.png' },
                bio: null, status: 'none', publicKey: null,
            } }) : undefined,
        });
        try {
            const scope = { serverId: home.homes.captured!.id, accountId: 'viewer' };
            const wrongScope = { serverId: home.homes.focused!.id, accountId: 'owner' };
            getStorage().setState({ profileScope: wrongScope,
                profile: AccountProfileSchema.parse({ id: 'owner', firstName: 'Wrong', lastName: 'Home' }) });
            const people = roster('owner');
            const hook = await renderHook(() => usePeople({ scope, roster: people, enabled: true }));
            await vi.waitFor(() => expect(hook.getCurrent().owner?.profile?.name).toBe('Captured Person'));
            expect(hook.getCurrent().owner).toMatchObject({ serverId: scope.serverId, accountId: 'owner',
                profile: { name: 'Captured Person', avatarUrl: 'https://discussion-people.test/face.png' } });
            expect(hook.getCurrent().accounts.get('collaborator')?.profile?.avatarUrl).toBe('https://discussion-people.test/face.png');
            expect(resolveAccountActorPresentation(hook.getCurrent().owner!, wrongScope)).toMatchObject({ isSelf: false, name: 'Captured Person' });
            expect(home.requests.filter(request => request.path.startsWith('/v1/user/')).map(request => request.home)).toEqual(['captured', 'captured']);
            await hook.unmount();
        } finally { await home.dispose(); }
    });

    it('keeps missing owner profiles distinct from unnamed members and overlays only the exact viewer profile', async () => {
        const home = await serveAccountHomes({ homes: [{ key: 'captured', serverUrl: 'https://discussion-viewer-profile.test', accountId: 'viewer' }],
            route: request => request.path === '/v1/user/missing' ? Response.json({ error: 'not_found' }, { status: 404 })
                : request.path.startsWith('/v1/user/') ? Response.json({ user: { id: request.path.split('/').at(-1),
                    firstName: '', lastName: null, username: '', avatar: null, bio: null, status: 'none', publicKey: null } }) : undefined });
        try {
            const scope = { serverId: home.homes.captured!.id, accountId: 'viewer' };
            const hook = await renderHook(({ owner }) => usePeople({ scope, roster: roster(owner), enabled: true }),
                { initialProps: { owner: 'missing' } });
            await vi.waitFor(() => expect(hook.getCurrent().owner?.accountId).toBe('missing'));
            expect(hook.getCurrent().owner).toMatchObject({ accountId: 'missing', profile: null });
            expect(resolveAccountActorPresentation(hook.getCurrent().owner!, scope).name).toBe(t('message.accountActorFormerMember'));
            await hook.rerender({ owner: 'unnamed' });
            await vi.waitFor(() => expect(hook.getCurrent().owner?.accountId).toBe('unnamed'));
            expect(resolveAccountActorPresentation(hook.getCurrent().owner!, scope).name).toBe(t('message.accountActorUnnamedMember'));
            await act(async () => { getStorage().setState({ profileScope: scope,
                profile: AccountProfileSchema.parse({ id: 'viewer', firstName: 'Scoped', lastName: 'Viewer',
                    avatar: { path: '/viewer.png', url: 'https://discussion-viewer-profile.test/viewer.png' } }) }); });
            await hook.rerender({ owner: 'viewer' });
            expect(hook.getCurrent().owner?.profile).toMatchObject({ name: 'Scoped Viewer', avatarUrl: 'https://discussion-viewer-profile.test/viewer.png' });
            expect(resolveAccountActorPresentation(hook.getCurrent().owner!, scope).isSelf).toBe(true);
            await hook.unmount();
        } finally { await home.dispose(); }
    });

    it('hides a retired same-Account binding and discards its late profile result after credential renewal', async () => {
        let ownerReads = 0;
        let releaseRetired: ((value: Response) => void) | undefined;
        let retiredSignal: AbortSignal | null | undefined;
        const home = await serveAccountHomes({ homes: [
            { key: 'captured', serverUrl: 'https://discussion-profile-renewal.test', accountId: 'viewer' },
            { key: 'focused', serverUrl: 'https://discussion-profile-renewal-other.test', accountId: 'other' },
        ], route: request => {
            if (!request.path.startsWith('/v1/user/')) return undefined;
            const id = request.path.split('/').at(-1)!;
            if (id === 'owner' && ++ownerReads === 2) {
                retiredSignal = request.signal;
                return new Promise<Response>(resolve => { releaseRetired = resolve; });
            }
            return Response.json({ user: { id, firstName: ownerReads >= 3 ? 'Fresh' : 'Old', lastName: 'Owner', username: 'owner',
                avatar: null, bio: null, status: 'none', publicKey: null } });
        } });
        const rollbacks: HomeCredentialWriteRollback[] = [];
        try {
            const target = home.homes.captured!;
            const scope: ServerAccountScope = { serverId: target.id, accountId: 'viewer' };
            const people = roster('owner');
            const hook = await renderHook(() => usePeople({ scope, roster: people, enabled: true }));
            await vi.waitFor(() => expect(hook.getCurrent().owner?.profile?.name).toBe('Old Owner'));
            const rotate = async (signature: string) => {
                await act(async () => {
                    const token = `header.${Buffer.from(JSON.stringify({ sub: 'viewer' })).toString('base64url')}.${signature}`;
                    const rollback = await TokenStorage.setCredentialsForServerUrlWithRollback(target.serverUrl, { serverId: target.id }, { token });
                    if (!rollback) throw new Error('Credential renewal did not persist');
                    rollbacks.push(rollback);
                });
            };
            await rotate('renewal-one');
            expect(hook.getCurrent().owner).toBeNull();
            await vi.waitFor(() => expect(releaseRetired).toBeDefined());
            await rotate('renewal-two');
            await vi.waitFor(() => expect(hook.getCurrent().owner?.profile?.name).toBe('Fresh Owner'));
            expect(retiredSignal?.aborted).toBe(true);
            await act(async () => { releaseRetired!(Response.json({ user: { id: 'owner', firstName: 'Retired', lastName: 'Owner',
                username: 'owner', avatar: null, bio: null, status: 'none', publicKey: null } })); });
            expect(hook.getCurrent().owner?.profile?.name).toBe('Fresh Owner');
            await hook.unmount();
        } finally {
            releaseRetired?.(Response.json({ error: 'gone' }, { status: 404 }));
            for (const rollback of rollbacks.reverse()) await rollback.rollback();
            await home.dispose();
        }
    });
});
