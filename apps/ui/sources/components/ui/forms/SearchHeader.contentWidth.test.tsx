import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installFormsCommonModuleMocks } from './formsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    contentWidthMode: 'compact' as 'compact' | 'medium' | 'full',
}));

installFormsCommonModuleMocks();

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useLocalSetting: ((key: string) => {
                if (key === 'uiContentWidthMode') return shared.contentWidthMode;
                if (key === 'uiFontScale') return 1;
                return undefined;
            }) as typeof import('@/sync/domains/state/storage')['useLocalSetting'],
        },
    });
});

vi.mock('@/sync/domains/state/storageStore', async (importOriginal) => {
    const { createLiveStorageStoreMock, createStorageStoreModuleMock } = await import('@/dev/testkit/mocks/storage');
    const store = createLiveStorageStoreMock(() => ({
        localSettings: { uiContentWidthMode: shared.contentWidthMode } as never,
    }));
    return createStorageStoreModuleMock({ importOriginal, overrides: { getStorage: () => store } });
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

function findSearchHeaderConstrainedStyle(screen: Awaited<ReturnType<typeof renderScreen>>): Record<string, unknown> {
    const matchingNode = screen.findAllByType('View' as never).find((node) => {
        const style = flattenStyle(node.props.style);
        return style.width === '100%' && style.alignSelf === 'center' && style.maxWidth !== undefined;
    });
    return matchingNode ? flattenStyle(matchingNode.props.style) : {};
}

function findSearchHeaderContainerStyle(screen: Awaited<ReturnType<typeof renderScreen>>): Record<string, unknown> {
    const matchingNode = screen.findAllByType('View' as never).find((node) => {
        const style = flattenStyle(node.props.style);
        return style.borderBottomWidth === 1 && style.paddingBottom !== undefined;
    });
    return matchingNode ? flattenStyle(matchingNode.props.style) : {};
}

function findSearchInputWrapperStyle(
    screen: Awaited<ReturnType<typeof renderScreen>>,
): Record<string, unknown> {
    const matchingNode = screen.findAllByType('View' as never).find((node) => {
        const style = flattenStyle(node.props.style);
        return style.flexDirection === 'row' && style.borderRadius !== undefined;
    });
    return matchingNode ? flattenStyle(matchingNode.props.style) : {};
}

describe('SearchHeader touch target', () => {
    it('draws the field at its padding and line height and reaches the finger target through the hit area', async () => {
        shared.contentWidthMode = 'compact';
        const { SearchHeader } = await import('./SearchHeader');
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');

        const screen = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
                <SearchHeader value="" onChangeText={() => {}} placeholder="Search actions" />
            </HappierUiPlatformProvider>,
        );

        // A touch target is a hit area, not a drawn size (DESIGN.md): no minimum height inflates the field.
        const wrapper = findSearchInputWrapperStyle(screen);
        expect(wrapper.minHeight).toBeUndefined();
        // The field is 22 (iOS line height) + 2 x 8 = 38 high once laid out, so the hit area reaches 3 up and down.
        const findWrapper = () => screen.tree.root.findAll((node) => typeof node.type === 'string'
            && flattenStyle(node.props.style).flexDirection === 'row'
            && flattenStyle(node.props.style).borderRadius !== undefined)[0]!;
        await act(async () => {
            findWrapper().props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 38 } } });
        });
        // The web's Pressable ignores hitSlop, so the hit area is an invisible frame that overhangs the field.
        const frame = findWrapper().findAll((node) => typeof node.type === 'string' && node.props['aria-hidden'] === true
            && flattenStyle(node.props.style).position === 'absolute')[0];
        expect(flattenStyle(frame?.props.style)).toMatchObject({ top: -3, bottom: -3 });
    });
});

describe('SearchHeader content width', () => {
    it('updates the search field max width when the local content width setting changes', async () => {
        shared.contentWidthMode = 'compact';
        const { SearchHeader } = await import('./SearchHeader');

        const screen = await renderScreen(
            <SearchHeader value="" onChangeText={() => {}} placeholder="Search actions" />,
        );

        expect(findSearchHeaderConstrainedStyle(screen).maxWidth).toBe(850);
        expect(findSearchHeaderConstrainedStyle(screen).paddingHorizontal).toBe(16);
        expect(findSearchHeaderContainerStyle(screen).paddingTop).toBe(0);
        expect(findSearchHeaderContainerStyle(screen).paddingBottom).toBe(12);

        shared.contentWidthMode = 'full';
        await act(async () => {
            screen.tree.update(
                <SearchHeader value="" onChangeText={() => {}} placeholder="Search actions" />,
            );
        });

        expect(findSearchHeaderConstrainedStyle(screen).maxWidth).toBe(Number.POSITIVE_INFINITY);
        expect(findSearchHeaderConstrainedStyle(screen).paddingHorizontal).toBe(16);
    });
});
