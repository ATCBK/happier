// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { expect, it, vi } from 'vitest';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { SegmentedTabBar } from './SegmentedTabBar';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

installWebLayoutBridge();

it.each([false, true])('keeps a column mode control at its natural height beside growing content (compact=%s)', async compact => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const tabs = [{ id: 'titles', label: 'Titles' }, { id: 'conversations', label: 'Conversations' }];
    try {
        async function measure(height?: number) {
            await act(async () => root.render(
                <View style={{ height }}>
                    <SegmentedTabBar tabs={tabs} activeTabId="titles" onSelectTab={() => {}}
                        role="radiogroup" compact={compact} targetSize="platform" testIDPrefix="mode" />
                    <View testID="results" style={{ flex: 1 }} />
                </View>,
            ));
            return measureWebLayout(host, { viewport: { width: 390, height: 844 } });
        }
        const natural = await measure();
        const tall = await measure(844);
        const shorter = await measure(400);
        for (const layout of [tall, shorter]) {
            // Height belongs to the control's content, not its parent's spare vertical space.
            expect(layout.rect('mode:titles').height).toBe(natural.rect('mode:titles').height);
            expect(layout.rect('results').top).toBe(natural.rect('results').top);
            // Equal-width segments still fill the available horizontal row.
            expect(layout.rect('mode:titles').width).toBe(natural.rect('mode:titles').width);
            expect(layout.rect('mode:conversations').right).toBe(natural.rect('mode:conversations').right);
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

it('lets a pointer reach every visible page tab and More when the row overflows', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const pages = ['Overview', 'Code', 'Changes', 'Scripts', 'Services', 'Context'].map(label => ({ id: label.toLowerCase(), label }));
    try {
        await act(async () => root.render(
            <View style={{ width: 260 }}>
                <SegmentedTabBar tabs={pages} activeTabId="overview" onSelectTab={() => {}} presentation="plain"
                    overflow={{ label: 'More', testID: 'pages.more' }} testIDPrefix="pages" />
            </View>,
        ));
        const layout = await measureWebLayout(host, { viewport: { width: 400, height: 200 }, settle: replay => act(replay) });
        // The row really overflowed: some pages went behind More.
        expect(layout.rects.has('pages.more')).toBe(true);
        // The off-screen measuring copy of the tabs must never sit on top of the live controls.
        expect(layout.rect('pages.more').receivesPointer).toBe(true);
        expect(layout.rect('pages:overview').receivesPointer).toBe(true);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
