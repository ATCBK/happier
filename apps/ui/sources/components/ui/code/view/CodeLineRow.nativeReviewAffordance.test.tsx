import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import {
    findTestInstanceByTypeWithProps,
    renderScreen,
} from '@/dev/testkit';
import { installCodeViewCommonModuleMocks } from './codeViewTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installCodeViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (options: any) => options?.ios ?? options?.default ?? options?.web ?? options?.android,
            },
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
            View: ({ children, ...props }: any) => React.createElement('View', props, children),
            Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        });
    },
    icons: async () => ({
        Ionicons: 'Ionicons',
    }),
});

describe('CodeLineRow native review affordance', () => {
    it('activates the tapped identifier using measured wrapped text without consuming long-press comments', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');
        const activate = vi.fn();
        const comment = vi.fn();
        const line = { id: 'current', sourceIndex: 0, hunkIndex: null, kind: 'file' as const, oldLine: null, newLine: 2,
            renderPrefixText: '', renderCodeText: 'const first = 1; second();', renderIsHeaderLine: false, selectable: false };
        const screen = await renderScreen(<CodeLineRow line={line} selected={false} onActivateToken={activate} onPressAddComment={comment}
            syntaxHighlighting={{ mode: 'simple', language: 'typescript', maxLineLength: 100 }} />);
        const code = screen.tree.root.findAll(node => typeof node.type === 'string' && node.props.onTextLayout)[0]!;
        expect(code).toBeDefined();
        act(() => code.props.onTextLayout({ nativeEvent: { lines: [
            { text: 'const first = 1; ', x: 0, y: 0, width: 170, height: 20 },
            { text: 'second();', x: 0, y: 20, width: 90, height: 20 },
        ] } }));
        act(() => code.props.onPress({ nativeEvent: { locationX: 25, locationY: 25 }, stopPropagation: vi.fn() }));
        expect(activate).toHaveBeenLastCalledWith('current', 19);
        activate.mockClear();
        act(() => code.props.onLongPress());
        act(() => code.props.onPress({ nativeEvent: { locationX: 25, locationY: 25 } }));
        expect(comment).toHaveBeenCalledWith(line);
        expect(activate).not.toHaveBeenCalled();
    });
    it('renders a visible comment affordance beside selectable diff lines without replacing line selection', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');
        const onPressAddComment = vi.fn();
        const onPressLine = vi.fn();

        const line = {
            id: '1',
            sourceIndex: 0, hunkIndex: null,
            kind: 'add' as const,
            oldLine: null,
            newLine: 1,
            renderPrefixText: '+',
            renderCodeText: 'const selected = true;',
            renderIsHeaderLine: false,
            selectable: true,
        };

        const screen = await renderScreen(<CodeLineRow
            line={line}
            selected={false}
            onPressLine={onPressLine}
            onPressAddComment={onPressAddComment}
        />);

        expect(screen.findByProps({ testID: 'review-comment-line-affordance-lane' })).toBeTruthy();

        const commentButton = findTestInstanceByTypeWithProps(screen.tree, 'Pressable' as any, {
            accessibilityRole: 'button',
            testID: 'review-comment-line-affordance',
        });
        const rowPressable = screen.tree
            .findAllByType('Pressable' as any)
            .find((node) => typeof node.props.onPress === 'function' && node.props.testID !== 'review-comment-line-affordance');

        act(() => {
            commentButton!.props.onPress({
                stopPropagation: vi.fn(),
                nativeEvent: { stopImmediatePropagation: vi.fn() },
            });
        });
        act(() => {
            rowPressable!.props.onPress();
        });

        expect(onPressAddComment).toHaveBeenCalledWith(line);
        expect(onPressLine).toHaveBeenCalledWith(line, undefined);
    });

    it('can suppress inactive native comment affordances while preserving row comment gestures', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');
        const onPressAddComment = vi.fn();

        const line = {
            id: '1',
            sourceIndex: 0, hunkIndex: null,
            kind: 'add' as const,
            oldLine: null,
            newLine: 1,
            renderPrefixText: '+',
            renderCodeText: 'const selected = true;',
            renderIsHeaderLine: false,
            selectable: true,
        };

        const screen = await renderScreen(<CodeLineRow
            line={line}
            selected={false}
            onPressAddComment={onPressAddComment}
            showInactiveCommentAffordance={false}
        />);

        expect(screen.tree.findAllByProps({ testID: 'review-comment-line-affordance-lane' })).toHaveLength(0);

        const rowPressable = screen.tree
            .findAllByType('Pressable' as any)
            .find((node) => typeof node.props.onLongPress === 'function');

        act(() => {
            rowPressable!.props.onLongPress();
        });

        expect(onPressAddComment).toHaveBeenCalledWith(line);
    });

    it('keeps active native comment affordances visible when inactive affordances are suppressed', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');
        const onPressAddComment = vi.fn();

        const line = {
            id: '1',
            sourceIndex: 0, hunkIndex: null,
            kind: 'add' as const,
            oldLine: null,
            newLine: 1,
            renderPrefixText: '+',
            renderCodeText: 'const selected = true;',
            renderIsHeaderLine: false,
            selectable: true,
        };

        const screen = await renderScreen(<CodeLineRow
            line={line}
            selected={false}
            onPressAddComment={onPressAddComment}
            commentActive
            showInactiveCommentAffordance={false}
        />);

        expect(screen.findByProps({ testID: 'review-comment-line-affordance-lane' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'review-comment-line-affordance' })).toBeTruthy();
    });
});
