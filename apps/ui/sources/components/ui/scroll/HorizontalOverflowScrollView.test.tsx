import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function renderSelectableTextInScroller(
    os: 'android' | 'ios' | 'web',
    props: Readonly<{ keepNativeTextSelection?: boolean }> = {},
) {
    vi.resetModules();
    vi.doMock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: os },
            Text: (textProps: any) => React.createElement('RNText', textProps, textProps.children),
        });
    });
    const { HorizontalOverflowScrollView } = await import('./HorizontalOverflowScrollView');
    // 0.3 owns selectability in shared presentation; the app Text adapter consumes this same owner.
    const { HappierText: Text } = await import('@happier-dev/plugin-ui/presentation');

    const screen = await renderScreen(
        <HorizontalOverflowScrollView {...props}>
            <Text selectable>wide content</Text>
        </HorizontalOverflowScrollView>,
    );
    return {
        selectable: screen.findByType('RNText' as any).props.selectable,
        nativeScroller: screen.findAllByType('ScrollView' as any).length === 1,
    };
}

describe('HorizontalOverflowScrollView (native text selection)', () => {
    it('suppresses native selection of descendant text on Android, where it fights the horizontal drag', async () => {
        const result = await renderSelectableTextInScroller('android');
        expect(result.nativeScroller).toBe(true);
        expect(result.selectable).toBe(false);
    });

    it('keeps descendant text selectable on iOS and web', async () => {
        expect((await renderSelectableTextInScroller('ios')).selectable).toBe(true);
        expect((await renderSelectableTextInScroller('web')).selectable).toBe(true);
    });

    it('keeps descendant text selectable on Android when the owner opts out of suppression', async () => {
        expect((await renderSelectableTextInScroller('android', { keepNativeTextSelection: true })).selectable).toBe(true);
    });
});
