import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionFollowSourceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';

import { standardCleanup } from '@/dev/testkit';
import { activateStorageAccountScope } from '@/dev/testkit/mocks/storage';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';

// The Follow API adapter is the network boundary; the editor, its controller and the panel stay real.
const api = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn(), set: vi.fn() }));
const followState = vi.hoisted(() => ({ rows: {} as Record<string, unknown> }));
const router = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));
vi.mock('@/components/ui/popover', async (importOriginal) => (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
vi.mock('@/sync/api/session/sessionFollowSourcesApi', () => ({
    listSessionFollowSources: api.list,
    removeSessionFollowSource: api.remove,
    setSessionFollowSource: api.set,
}));
vi.mock('@/components/appShell/workspace/destinationRoute', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useRouter: () => router,
}));
vi.mock('@/text', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    t: (key: string, params?: { title?: string }) => params?.title ? `${key}:${params.title}` : key,
}));
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useSessionListRowsByServerId: () => followState.rows, useServerScopedMachine: () => null });
});

import { projectSessionFollowerCensus, SessionFollowerRows } from './SessionPeopleFollowSections';

function relation(relation: 'follower' | 'manager', preset: 'important' | 'quiet'): SessionFollowSourceV1 {
    return { sourceSessionId: 'this', destinationSessionId: 'lead', relation, policy: { preset }, deliveryState: 'eligible', hasPendingUpdates: false };
}

let account: Awaited<ReturnType<typeof activateStorageAccountScope>> | undefined;
afterEach(() => { standardCleanup(); account?.dispose(); account = undefined; });

describe('People follower rows', () => {
    beforeEach(async () => {
        account = await activateStorageAccountScope({ serverId: 'home-a', accountId: 'follow-account' });
        api.list.mockReset(); api.remove.mockReset(); api.set.mockReset(); router.push.mockReset();
        followState.rows = {};
    });

    it('opens the follower’s own Follow panel for this pair, not the follower Session, and writes its edge', async () => {
        api.list.mockResolvedValue({ kind: 'ok', value: { sources: [
            { sourceSessionId: 'this', destinationSessionId: 'lead', policy: { preset: 'quiet' }, deliveryState: 'eligible', hasPendingUpdates: false },
        ] } });
        api.set.mockResolvedValue({ kind: 'ok', value: { changed: true } });
        const followers = projectSessionFollowerCensus({ sources: [relation('follower', 'quiet')], follows: [], peopleCount: 0 }).sessions ?? [];
        followState.rows = { 'home-a': { lead: createSessionListRenderableSessionFixture({ id: 'lead', metadata: { name: 'Daily coordinator', path: '/repo' } }) } };
        const screen = await renderSettingsView(<SessionFollowerRows target={{ serverId: 'home-a', sessionId: 'this' }} followers={followers} />);
        await act(async () => { screen.findByTestId('session-people-follower-session-lead')?.props.onPress?.(); await Promise.resolve(); });
        expect(router.push).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(screen.findByTestId('session-follow-source-this-policy.preset.important')).not.toBeNull());
        expect(api.list).toHaveBeenCalledWith({ serverId: 'home-a', sessionId: 'lead' });
        // Direction and why: who follows, and on what terms.
        expect(screen.getTextContent()).toContain('session.follow.sources.followsThis:');
        expect(screen.findByTestId('session-people-follower-session-lead-panel')).not.toBeNull();
        const segment = screen.tree.root.findAll((node) => node.props.testID === 'session-follow-source-this-policy.preset.important'
            && typeof node.props.onPress === 'function')[0];
        await act(async () => { segment?.props.onPress?.(); await Promise.resolve(); });
        expect(api.set).toHaveBeenCalledWith(expect.objectContaining({ destinationSessionId: 'lead', sourceSessionId: 'this' }));
        await screen.unmount();
    });

    it('says where a manager-only relation is changed instead of offering an editor that would write an ordinary follow', async () => {
        const followers = projectSessionFollowerCensus({ sources: [relation('manager', 'important')], follows: [], peopleCount: 0 }).sessions ?? [];
        const screen = await renderSettingsView(<SessionFollowerRows target={{ serverId: 'home-a', sessionId: 'this' }} followers={followers} />);
        await act(async () => { screen.findByTestId('session-people-follower-session-lead')?.props.onPress?.(); await Promise.resolve(); });
        expect(screen.getTextContent()).toContain('session.follow.sources.managerOnly');
        expect(api.list).not.toHaveBeenCalled();
        expect(router.push).not.toHaveBeenCalled();
        await screen.unmount();
    });
});
