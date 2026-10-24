import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import type { SessionSwitcherRow } from '@/components/navigation/mobile/chrome/lateralSwipe/sessionSwitcherRows';

import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionShellCommonModuleMocks({
    // The overview reads no Sync state; the real storage graph re-enters this mock through the Socket owner.
    storage: async () => (await import('@/dev/testkit/mocks/storage')).createStorageModuleStub({}),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

const row = (key: string, section: SessionSwitcherRow['section'], target: SessionSwitcherRow['target']): SessionSwitcherRow => ({
    key, section, target, title: key, agentId: null, machineId: null, serverId: 's', icon: target.kind === 'tab' ? 'file' : null,
    status: null, timeLabel: '', excerpt: null, draft: null, unavailable: false,
});

describe('All tabs overview', () => {
    afterEach(() => standardCleanup());

    it('leads with open tabs, then recents; without open tabs the recents are this phone’s own', async () => {
        const { buildSessionAllTabsSections } = await import('./useSessionAllTabsOpener');
        const withTabs = buildSessionAllTabsSections({
            synced: true,
            rows: [
                row('tab:a', 'openTabs', { kind: 'tab', tabId: 'a' }),
                row('r1', 'recent', { kind: 'session', sessionId: 'r1', serverId: 's', tabId: null }),
            ],
        });
        expect(withTabs.map((section) => [section.key, section.title, section.rows.map((r) => r.key)])).toEqual([
            ['openTabs', 'phoneNav.allTabs.openTabsSynced', ['tab:a']],
            ['recent', 'phoneNav.allTabs.recent', ['r1']],
        ]);
        const recentOnly = buildSessionAllTabsSections({
            synced: false,
            rows: [row('r1', 'recent', { kind: 'session', sessionId: 'r1', serverId: 's', tabId: null })],
        });
        expect(recentOnly.map((section) => section.title)).toEqual(['phoneNav.allTabs.recentOnThisDevice']);
    });

    it('marks the session on screen, opens the tapped card, and invites when there is nothing else', async () => {
        const { SessionAllTabsOverviewBody } = await import('./SessionAllTabsOverview');
        const { buildServerScopedSessionKey } = await import('@/sync/domains/session/navigation/sessionNavigationOrder');
        const onOpen = vi.fn();
        const current = row('tab:here', 'openTabs', { kind: 'session', sessionId: 'here', serverId: 's', tabId: 'here' });
        const other = row('tab:other', 'openTabs', { kind: 'tab', tabId: 'other' });
        const screen = await renderScreen(
            <SessionAllTabsOverviewBody
                sections={[{ key: 'openTabs', title: 'Open tabs', rows: [current, other] }]}
                currentKey={buildServerScopedSessionKey('here', 's')}
                onOpen={onOpen}
            />,
        );
        expect(screen.findByTestId('session-all-tabs-card:tab:here')?.props.accessibilityState).toMatchObject({ selected: true });
        expect(screen.findByTestId('session-all-tabs-card:tab:other')?.props.accessibilityState).toMatchObject({ selected: false });
        await pressTestInstanceAsync(screen.findByTestId('session-all-tabs-card:tab:other')!, 'open other');
        expect(onOpen).toHaveBeenCalledWith('tab:other');

        const empty = await renderScreen(
            <SessionAllTabsOverviewBody sections={[{ key: 'recent', title: 'Recent', rows: [] }]} currentKey={null} onOpen={onOpen} />,
        );
        expect(empty.findByTestId('session-all-tabs-card:tab:other')).toBeNull();
        expect(empty.getTextContent()).toContain('phoneNav.allTabs.emptyTitle');
    });
});
