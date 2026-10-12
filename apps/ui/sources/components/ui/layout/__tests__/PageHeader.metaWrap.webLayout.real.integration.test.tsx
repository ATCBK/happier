// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { HappierPageHeader } from '@happier-dev/plugin-ui/presentation';
import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

installWebLayoutBridge();

const FACTS = ['Online', 'Linux', '48 cores', '125 GB', 'Up 1 d 18 h', 'End-to-end encrypted']
    .map((text, index) => ({ key: `fact-${index}`, text, testID: `fact-${index}` }));

it.each([240, 300, 360])('never ends a wrapped meta line with a separator, in a %spx pane', async (width) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<HappierPageHeader testID="header" title="NLDW4-5-40-40 · 0da8" meta={FACTS} />));
        const layout = await measureWebLayout(host, {
            viewport: { width, height: 600 },
            settle: async (replay) => { await act(replay); },
        });
        const tops = FACTS.map((fact) => layout.rect(fact.testID).top);
        const separatorOpacity = (index: number) => {
            const separator = host.querySelector(`[data-testid="${FACTS[index]!.testID}"] [aria-hidden="true"]`) as HTMLElement | null;
            return separator?.style.opacity ?? null;
        };
        expect(new Set(tops).size, 'the facts wrap in this pane').toBeGreaterThan(1);
        for (let index = 0; index < FACTS.length - 1; index += 1) {
            const endsLine = tops[index + 1]! > tops[index]! + 4;
            expect(separatorOpacity(index) === '0', `separator after fact ${index} hidden iff it ends a line`).toBe(endsLine);
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
