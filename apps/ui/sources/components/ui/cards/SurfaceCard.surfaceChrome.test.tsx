import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { GROUPED_SURFACE_RADIUS_PX } from '@/components/ui/lists/pageListMetrics';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    themeOverride: {} as Record<string, unknown>,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({ theme: shared.themeOverride });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

function hasShadow(style: Record<string, unknown>): boolean {
    return style.boxShadow !== undefined || style.shadowOpacity !== undefined || style.elevation !== undefined;
}

async function renderSurfaceCard() {
    const { SurfaceCard } = await import('./SurfaceCard');
    return renderScreen(
        <SurfaceCard>
            {React.createElement('View')}
        </SurfaceCard>,
    );
}

function findSurfaceCardStyle(screen: Awaited<ReturnType<typeof renderSurfaceCard>>): Record<string, unknown> {
    const matchingNode = screen.findAllByType('View' as never).find((node) => {
        const style = flattenStyle(node.props.style);
        return style.minWidth === 0 && style.borderRadius === GROUPED_SURFACE_RADIUS_PX;
    });
    return matchingNode ? flattenStyle(matchingNode.props.style) : {};
}

afterEach(() => {
    standardCleanup();
    vi.resetModules();
    shared.themeOverride = {};
});

describe('SurfaceCard surface chrome', () => {
    it('stands on its raised lip and the card elevation like a grouped sheet, even with a transparent border', async () => {
        shared.themeOverride = { colors: { border: { surface: 'transparent' } } };
        const screen = await renderSurfaceCard();
        const style = findSurfaceCardStyle(screen);

        expect(style.borderWidth).toBe(0);
        expect(Number(style.borderBottomWidth)).toBeGreaterThan(0);
        expect(hasShadow(style)).toBe(true);
    });

    it('sits on a configuration page as the same W3 card as the page sections, on the sheet radius', async () => {
        const { SurfaceCard } = await import('./SurfaceCard');
        const { ListPresentationProvider } = await import('@/components/ui/lists/listPresentation');
        const { PAGE_LIST_METRICS } = await import('@/components/ui/lists/pageListMetrics');
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <SurfaceCard testID="card">{React.createElement('View')}</SurfaceCard>
            </ListPresentationProvider>,
        );
        // The theme the card resolved with (the mocked Unistyles theme), not a second import of it.
        const { useUnistyles } = await import('react-native-unistyles');
        const lightTheme = useUnistyles().theme;
        const cardStyle = screen.findAllByType('View' as never)
            .map((node) => flattenStyle(node.props.style))
            .find((style) => style.minWidth === 0 && style.width === '100%') ?? {};

        // The material owner paints the fill on its own layer beneath the content.
        const paints = screen.findAllByType('View' as never).map((node) => flattenStyle(node.props.style));
        expect(paints.some((style) => style.backgroundColor === lightTheme.colors.edge.cardFill)).toBe(true);
        expect(cardStyle.borderColor).toBe(lightTheme.colors.border.surface);
        expect(cardStyle.borderBottomColor).toBe(lightTheme.colors.edge.surface);
        expect(cardStyle.boxShadow).toBe(lightTheme.colors.shadowCard.boxShadow);
        expect(cardStyle.borderRadius).toBe(PAGE_LIST_METRICS.sheetRadiusPx);
    });
});
