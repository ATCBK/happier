// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { expect, it, vi } from 'vitest';
import { HappierPageChromeProvider, HappierScrollArea } from '@happier-dev/plugin-ui/presentation';
import { measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

it('keeps every block of a plugin page on the page column, not only its sections (R-APP-4)', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(
            <View style={{ width: 1200, height: 800 }}>
                <HappierPageChromeProvider chrome={{ showsTitle: true, columnMaxWidthPx: 704 }}>
                    <HappierScrollArea testID="page">
                        <View testID="banner" style={{ height: 40 }} />
                    </HappierScrollArea>
                </HappierPageChromeProvider>
            </View>,
        ));
        const layout = await measureWebLayout(host, { viewport: { width: 1200, height: 800 } });
        const banner = layout.rect('banner');
        expect(banner.width).toBe(704);
        expect(Math.abs(banner.left - (1200 - 704) / 2)).toBeLessThanOrEqual(1);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
