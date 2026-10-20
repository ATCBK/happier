import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { Item } from '@/components/ui/lists/Item';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

// `@legendapp/list` is a third-party boundary. It is stubbed here exactly as the
// sibling SearchResultsList suites stub it: the list keeps its real auxiliary
// contract (header, rows via `renderItem`, `ListEmptyComponent` when empty) so
// the assertions below still exercise the component's own rendering. Without
// this the real web build mounts and its passive effect calls
// `requestAnimationFrame`, which the node test environment does not provide.
vi.mock('@legendapp/list/react-native', async () => {
    const ReactModule = await import('react');
    return {
        LegendList: ReactModule.forwardRef((props: any, _ref) => {
            const renderAuxiliary = (component: any) => {
                if (!component) return null;
                if (ReactModule.isValidElement(component)) return component;
                return ReactModule.createElement(component);
            };
            const data: any[] = Array.isArray(props.data) ? props.data : [];
            const items = data.map((item: any, index: number) => ReactModule.createElement(
                'LegendListItem',
                { key: props.keyExtractor?.(item, index) ?? String(index) },
                props.renderItem?.({ item, index }),
            ));
            return ReactModule.createElement(
                'LegendList',
                props,
                renderAuxiliary(props.ListHeaderComponent),
                ...items,
                data.length === 0 ? renderAuxiliary(props.ListEmptyComponent) : null,
            );
        }),
    };
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

const searchResultsTheme = createThemeFixture({
    colors: {
        border: { default: '#ddd' },
        surface: { inset: '#eee' },
        text: {
            link: '#09f',
            primary: '#111',
            secondary: '#999',
        },
    },
});

describe('SearchResultsList', () => {
    it('reports failed or incomplete searches instead of claiming there are no matches', async () => {
        const { SearchResultsList } = await import('./SearchResultsList');
        const props = { theme: searchResultsTheme, searchQuery: 'needle', searchResults: [], isSearching: false, onFilePress: vi.fn() };
        const screen = await renderScreen(<SearchResultsList {...props} searchError onRetry={vi.fn()} />);
        expect(screen.findByTestId('files-search-error')).toBeTruthy();
        expect(screen.findByTestId('files-search-no-results')).toBeFalsy();
        await screen.update(<SearchResultsList {...props} hasMore />);
        expect(screen.findByTestId('files-search-incomplete')).toBeTruthy();
        expect(screen.findByTestId('files-search-no-results')).toBeFalsy();
    });

    it('keeps the mounted result list and rows while a refined query is searching', async () => {
        const { SearchResultsList } = await import('./SearchResultsList');
        const file = { fileType: 'file' as const, fileName: 'a.ts', filePath: 'src/', fullPath: 'src/a.ts' };
        const props = { theme: searchResultsTheme, searchQuery: 'a', searchResults: [file], onFilePress: vi.fn() };
        const screen = await renderScreen(<SearchResultsList {...props} isSearching={false} />);
        const list = screen.tree.findByType('LegendList');
        await screen.update(<SearchResultsList {...props} searchQuery="a.ts" isSearching />);
        expect(screen.tree.findByType('LegendList') === list).toBe(true);
        expect(screen.tree.findAllByType(Item)).toHaveLength(1);
        expect(screen.tree.findAllByType('Text').some(node => React.Children.toArray(node.props.children).includes('files.previousSearchResults'))).toBe(true);
        await screen.update(<SearchResultsList {...props} searchQuery="a.ts" searchResultsQuery="a" isSearching={false} />);
        expect(screen.tree.findAllByType('Text').some(node => React.Children.toArray(node.props.children).includes('files.previousSearchResults'))).toBe(true);
    });

    it('activates matching folders through the reveal callback without opening a file', async () => {
        const { SearchResultsList } = await import('./SearchResultsList');
        const folder = { fileType: 'folder' as const, fileName: 'nested/', filePath: 'src/', fullPath: 'src/nested/' };
        const onFolderPress = vi.fn();
        const onFilePress = vi.fn();
        const screen = await renderScreen(<SearchResultsList theme={searchResultsTheme} searchQuery="nested" searchResults={[folder]} isSearching={false} onFilePress={onFilePress} onFolderPress={onFolderPress} />);
        const item = screen.tree.findByType(Item);
        expect(typeof item.props.onPress).toBe('function');
        await act(async () => { item.props.onPress(); });
        expect(onFolderPress).toHaveBeenCalledWith(folder);
        expect(onFilePress).not.toHaveBeenCalled();
    });

    it('does not render string children under View when searchQuery is empty', async () => {
        const { SearchResultsList } = await import('./SearchResultsList');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SearchResultsList
                    theme={searchResultsTheme}
                    isSearching={false}
                    searchQuery=""
                    searchResults={[]}
                    onFilePress={vi.fn()}
                />)).tree;

        const views = tree!.findAllByType('View');
        expect(views.length).toBeGreaterThan(0);
        for (const view of views) {
            const children = React.Children.toArray(view.props.children ?? []);
            expect(children.some(child => typeof child === 'string' || typeof child === 'number')).toBe(false);
        }
    }, 60_000);

    it('wires onFilePressPinned to Item.onDoublePress for file results', async () => {
        const { SearchResultsList } = await import('./SearchResultsList');
        const onFilePress = vi.fn();
        const onFilePressPinned = vi.fn();

        const file = {
            fileType: 'file',
            fileName: 'AGENTS.md',
            filePath: '',
            fullPath: 'AGENTS.md',
        } as any;

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SearchResultsList
                    theme={searchResultsTheme}
                    isSearching={false}
                    searchQuery="AG"
                    searchResults={[file]}
                    onFilePress={onFilePress}
                    onFilePressPinned={onFilePressPinned}
                />)).tree;

        const item = tree!.findByType(Item);
        expect(typeof item.props.onDoublePress).toBe('function');

        act(() => {
            item.props.onDoublePress();
        });

        expect(onFilePressPinned).toHaveBeenCalledTimes(1);
        expect(onFilePressPinned).toHaveBeenCalledWith(file);
        expect(onFilePress).toHaveBeenCalledTimes(0);
    });

    it('renders a single inline repo path label with the directory truncating from the head', async () => {
        const { SearchResultsList } = await import('./SearchResultsList');

        const file = {
            fileType: 'file',
            fileName: '/a.ts',
            filePath: 'src/',
            fullPath: 'src/a.ts',
        } as any;

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SearchResultsList
                    theme={searchResultsTheme}
                    isSearching={false}
                    searchQuery="a"
                    searchResults={[file]}
                    onFilePress={vi.fn()}
                />)).tree;

        const item = tree!.findByType(Item);
        expect(React.isValidElement(item.props.title)).toBe(true);
        expect(item.props.rightElement).toBeNull();
        const title = item.props.title;
        expect(title.props.filePath).toBe('src/');
        expect(title.props.fileName).toBe('/a.ts');
        expect(title.props.nameMaxWidth).toBe(220);
    });
});
