import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storage';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { getDiscussionRepository, retireDiscussionRepository, clearDiscussionRepositoryRegistryForTests } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import { useDestinationInstanceTitles, type DestinationInstanceTitleEntry } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import type { DiscussionRepositoryClient } from '@/sync/ops/discussions/discussionRepository';
import { createSessionDiscussionDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { DetailsTabStrip } from './DetailsTabStrip';
import type { DetailsTabState } from './detailsWorkspaceTypes';

installPanelCommonModuleMocks();
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
// Secure credential storage is the system boundary; Home/Account resolution stays real.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({ importOriginal, tokenStorage: {
        getCredentialsForServerUrl: async () => ({ token: `header.${Buffer.from(JSON.stringify({ sub: 'titles-account' })).toString('base64')}.signature`, secret: 'test-secret' }),
    } });
});

afterEach(() => {
    standardCleanup();
    clearDiscussionRepositoryRegistryForTests();
    storage.setState(storage.getInitialState(), true);
});

async function renderStrip(tab: DetailsTabState, sessionId: string, serverId?: string) {
    const props = {
        sessionId, serverId,
        pane: { setActiveDetailsTab: vi.fn(), pinDetailsTab: vi.fn(), unpinDetailsTab: vi.fn(), closeDetailsTab: vi.fn() },
        group: { id: 'titles', tabKeys: [tab.key], activeTabKey: tab.key, tabs: [tab], isFocused: true },
    };
    return renderScreen(<DetailsTabStrip {...props} />);
}

function text(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.root.findAll(node => typeof node.props.children === 'string').map(node => node.props.children);
}

describe('Details live instance titles', () => {
    it('uses the session title owner and updates a retained tab after rename', async () => {
        const named = (name: string) => createSessionFixture({ id: 'titles-session', metadata: {
            path: '/project', host: 'tester', homeDir: '/home/tester', summary: { text: name, updatedAt: 1 },
        } });
        act(() => storage.getState().applySessions([named('Before rename')]));
        const screen = await renderStrip({ key: 'session-title', kind: 'session', title: 'Saved title', resource: null, isPinned: false, isPreview: false }, 'titles-session');
        expect(text(screen)).toContain('Before rename');
        await act(async () => storage.getState().applySessions([named('After rename')]));
        expect(text(screen)).toContain('After rename');
        expect(text(screen)).not.toContain('Before rename');
    });

    it('observes the canonical discussion source even when it arrives after the strip, without mounting a watcher', async () => {
        const profile = await upsertServerProfile({ serverUrl: 'https://titles.example.test', name: 'Titles' });
        const address = { serverId: profile.id, sessionId: 'titles-session' };
        const tab = { ...createSessionDiscussionDetailsTab({ kind: 'discussion', address, discussionId: 'd1', title: 'Saved discussion' }), isPinned: false, isPreview: false };
        const screen = await renderStrip(tab, address.sessionId, address.serverId);
        expect(text(screen)).toContain('Saved discussion');
        const summary = (title: string): DiscussionOpenedSummaryV1 => ({
            id: 'd1', ownerAccountId: 'titles-account', encryptionMode: 'plain', anchor: null,
            access: 'owner', keyReadiness: true, dataEncryptionKey: null, creationLocalId: null, title,
            latestMessage: { id: 'message-1', localId: null, seq: 1, authorAccountId: null, accountActor: null, producerV1: null, createdAt: 1 },
            messageSeq: 1, lastReadSeq: 1, unreadCount: 0, unreadMentionCount: 0, recentAuthorAccountIds: [], archivedAt: null,
            capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false },
        });
        // The repository's HTTP client is the boundary; summary application and notifications are real.
        let currentTitle = 'Live discussion';
        const unavailable = async () => ({ kind: 'failed' as const, errorCode: 'unavailable' });
        const client: DiscussionRepositoryClient = {
            list: async () => ({ kind: 'succeeded', value: { v: 1, serverId: address.serverId, discussions: [summary(currentTitle)], nextCursor: null, incomplete: false } }),
            rename: async (_id, title) => { currentTitle = title; return { kind: 'succeeded', value: { v: 1, serverId: address.serverId, discussion: summary(title) } }; },
            attention: unavailable, get: unavailable, read: unavailable, create: unavailable, post: unavailable, archive: unavailable, restore: unavailable, readState: unavailable,
            participants: unavailable, setParticipantPolicy: unavailable, invite: unavailable, inviteExecutableParticipant: unavailable, removeParticipant: unavailable, leave: unavailable,
            transferOwner: unavailable, listGrants: unavailable, setGrant: unavailable, removeGrant: unavailable,
        };
        const repository = getDiscussionRepository({ scope: { serverId: address.serverId, accountId: 'titles-account' }, address, client });
        await act(async () => repository.refreshList('active'));
        await vi.waitFor(() => expect(text(screen)).toContain('Live discussion'));
        await act(async () => { await repository.rename('d1', 'Renamed discussion'); });
        expect(text(screen)).toContain('Renamed discussion');
        expect(text(screen)).not.toContain('Live discussion');
        expect(repository.isMounted()).toBe(false);
        currentTitle = 'Other Account discussion';
        const otherAccount = getDiscussionRepository({ scope: { serverId: address.serverId, accountId: 'other-account' }, address, client });
        await act(async () => otherAccount.refreshList('active'));
        expect(text(screen)).toContain('Renamed discussion');
        expect(text(screen)).not.toContain('Other Account discussion');
        currentTitle = 'Renamed discussion';
        const entries: readonly DestinationInstanceTitleEntry[] = [
            { key: 'discussion', ref: { kind: 'sessionDetails', params: { id: address.sessionId, serverId: address.serverId, details: 'discussion', discussionId: 'd1' } } },
            { key: 'home-discussion', ref: { kind: 'discussions', params: { serverId: address.serverId, discussionId: 'd1', workspacePathname: '/discussions/d1' } } },
        ];
        const catalog = Object.freeze([]);
        const observer = await renderHook(() => useDestinationInstanceTitles(catalog, entries));
        await vi.waitFor(() => expect(observer.getCurrent().get('discussion')).toBe('Renamed discussion'));
        expect(observer.getCurrent().get('home-discussion')).toBe('Renamed discussion');
        const unchanged = observer.getCurrent();
        await act(async () => repository.refreshList('active'));
        expect(observer.getCurrent()).toBe(unchanged);
        act(() => retireDiscussionRepository({ scope: { serverId: address.serverId, accountId: 'titles-account' }, address }));
        expect(text(screen)).not.toContain('Renamed discussion');
        currentTitle = 'Replacement repository';
        const replacement = getDiscussionRepository({ scope: { serverId: address.serverId, accountId: 'titles-account' }, address, client });
        await act(async () => replacement.refreshList('active'));
        expect(text(screen)).toContain('Replacement repository');
        expect(replacement.isMounted()).toBe(false);
    });
});
