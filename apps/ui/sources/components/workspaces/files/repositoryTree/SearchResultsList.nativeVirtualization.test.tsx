import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const legendListState = vi.hoisted(() => ({
    props: null as Record<string, unknown> | null,
}));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

vi.mock('@legendapp/list/react-native', async () => {
    const ReactModule = await import('react');
    return {
        LegendList: ReactModule.forwardRef((props: Record<string, unknown>, _ref) => {
            legendListState.props = props;
            return ReactModule.createElement('LegendList');
        }),
    };
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());




describe('SearchResultsList native virtualization', () => {
    it('keeps native search results in the virtualized list during refinement', async () => {
        const { SearchResultsList } = await import('./SearchResultsList');
        const searchResults = Array.from({ length: 40 }, (_, index) => ({
            fileType: 'file',
            fileName: `file-${index}.ts`,
            filePath: 'src/',
            fullPath: `src/file-${index}.ts`,
        }));

        const element = <SearchResultsList
                theme={createThemeFixture({
                    colors: {
                        border: { default: '#ddd' },
                        surface: { inset: '#eee' },
                        text: { link: '#09f', primary: '#111', secondary: '#999' },
                    },
                })}
                isSearching={false}
                searchQuery="session"
                searchResults={searchResults as any}
                onFilePress={vi.fn()}
            />;
        const screen = await renderScreen(element);

        expect(legendListState.props?.data).toHaveLength(40);
        expect(legendListState.props?.estimatedItemSize).toBeGreaterThan(0);
        await screen.update(React.cloneElement(element, { isSearching: true, searchQuery: 'session.ts' }));
        expect(legendListState.props?.data).toBe(searchResults);
    });
});
