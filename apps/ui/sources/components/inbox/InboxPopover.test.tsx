import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createUsageNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { InboxSummaryProvider, useSharedInboxSummary } from '@/hooks/inbox/useInboxSummary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const navigation = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    router: { push: route => navigation.order.push(String(route)) },
}).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

const initialState = storage.getState();
let summaryCount = 0;
function SummaryProbe() {
    summaryCount = useSharedInboxSummary().count;
    return null;
}

describe('InboxPopoverContent (lab inbox-I2)', () => {
    beforeEach(() => {
        navigation.order = [];
        storage.setState(initialState, true);
        storage.setState({ isDataReady: true, profileScope: {
            serverId: getActiveServerSnapshot().serverId, accountId: 'account-a',
        } });
    });
    afterEach(() => {
        standardCleanup();
        storage.setState(initialState, true);
    });

    it('names itself, offers Open Inbox as its one header action, and closes before every navigation', async () => {
        const notice = createUsageNoticeArtifactFixture();
        storage.setState({ artifacts: { [notice.id]: notice } });
        const { InboxPopoverContent } = await import('./InboxPopover');
        const screen = await renderScreen(<InboxPopoverContent
            close={() => navigation.order.push('close')} onOpenInbox={() => navigation.order.push('open')} />);

        expect(screen.getTextContent()).toContain('tabs.inbox');
        expect(screen.findByTestId('inbox.popover.mark_all_read')).toBeNull();
        expect(screen.findByTestId('inbox.popover.open')).not.toBeNull();
        expect(screen.findByTestId('inbox.popover.count')?.props.children).toBe('1');

        await screen.pressByTestIdAsync('inbox.popover.open');
        expect(navigation.order).toEqual(['close', 'open']);
        // A notice is an Update: the popover offers one line to the Inbox rather than its row.
        expect(screen.findByTestId(`inbox.usage-notice.${notice.id}`)).toBeNull();
        await screen.pressByTestIdAsync('inbox.popover.updates');
        expect(navigation.order).toEqual(['close', 'open', 'close', 'open']);
    });

    it('shows the same real Account-notice count as the rail summary that opened it', async () => {
        const notices = Array.from({ length: 4 }, (_, index) => createUsageNoticeArtifactFixture({ id: `notice-${index}` }));
        storage.setState({ artifacts: Object.fromEntries(notices.map(notice => [notice.id, notice])) });
        const { InboxPopoverContent } = await import('./InboxPopover');
        const screen = await renderScreen(<InboxSummaryProvider><SummaryProbe />
            <InboxPopoverContent close={() => {}} onOpenInbox={() => {}} />
        </InboxSummaryProvider>);
        expect(summaryCount).toBe(4);
        expect(screen.findByTestId('inbox.popover.count')?.props.children).toBe(String(summaryCount));
        await act(async () => storage.setState({ artifacts: {} }));
        expect(summaryCount).toBe(0);
        expect(screen.findByTestId('inbox.popover.count')).toBeNull();
    });
});
