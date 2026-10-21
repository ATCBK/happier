import React from 'react';
import type { View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installCodeViewCommonModuleMocks } from '@/components/ui/code/view/codeViewTestHelpers';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useLocalSetting: () => 1 });
});
installCodeViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'android' });
    },
});
const { FileContentPanel } = await import('./FileContentPanel');

describe('native file panel reading continuity', () => {
    it('remembers the departing raw reader before Changes replaces its viewport', async () => {
        const remember = vi.fn();
        const props = { theme: { colors: { text: { secondary: '#999' } } }, sessionId: 's1', filePath: 'a.txt',
            diffContent: '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c', language: null, fileContent: 'a\nb\nc',
            selectedLineKeys: new Set<string>(), lineSelectionEnabled: false, onToggleLine: vi.fn() };
        const screen = await renderScreen(<FileContentPanel {...props} displayMode="file"
            readingMemory={{ identity: 'a.txt', active: true, remember }} />);
        try {
            await act(async () => screen.findByType('FlatList').props.onViewableItemsChanged({ viewableItems: [{ index: 2 }] }));
            await screen.update(<FileContentPanel {...props} displayMode="diff" />);
            expect(remember).toHaveBeenCalledWith(3);
        } finally { await screen.unmount(); }
    });
    it.each([true, false])('retains nonvirtualized commented file reading with wrapLines=%s', async (wrapLines) => {
        let scrollY = 55;
        const props = {
            theme: { colors: { text: { secondary: '#999' } } },
            displayMode: 'file' as const,
            sessionId: 's1', filePath: 'a.txt', diffContent: null, language: null,
            selectedLineKeys: new Set<string>(), lineSelectionEnabled: false,
            onToggleLine: vi.fn(), reviewCommentsEnabled: true, reviewCommentModeActive: true,
            reviewCommentDrafts: [], scrollTestID: 'code-scroll', wrapLines,
        };
        const screen = await renderScreen(<FileContentPanel {...props} fileContent={'a\nb\nreading\nd'} />, {
            createNodeMock: (element) => {
                // Native host props are opaque at the renderer boundary.
                const hostProps = element.props as { innerViewRef?: React.RefObject<View | null>; nativeID?: string };
                const nativeID = hostProps.nativeID;
                if (element.type === 'ScrollView') {
                    // The native ScrollView owns this inner host View.
                    if (hostProps.innerViewRef) hostProps.innerViewRef.current = {} as View;
                    return { scrollTo: ({ y }: { y: number }) => { scrollY = y; } };
                }
                if (typeof nativeID === 'string') return {
                    measureLayout: (_relative: unknown, success: (x: number, y: number, width: number, height: number) => void) => {
                        success(0, (Number(nativeID.split(':').at(-1)) - 1) * 25, 100, 25);
                    },
                };
                return null;
            },
        });
        expect(screen.findAllByType('FlatList')).toHaveLength(0);
        const scroll = screen.findHostByTestId('code-scroll');
        expect(scroll).not.toBeNull();
        expect(scroll!.props.horizontal).not.toBe(true);
        await act(async () => {
            scroll!.props.onScroll({ nativeEvent: { contentOffset: { y: scrollY } } });
            for (const row of screen.tree.root.findAll((node) => typeof node.type === 'string' && String(node.type) === 'View' && typeof node.props.nativeID === 'string')) row.props.onLayout?.();
        });
        await screen.update(<FileContentPanel {...props} fileContent={'inserted\na\nb\nreading\nd'} />);
        expect(scrollY).toBe(80);
    });
});
