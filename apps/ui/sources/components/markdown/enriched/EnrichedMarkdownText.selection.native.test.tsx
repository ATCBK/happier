import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { activateStorageAccountScope } from '@/dev/testkit/runtime/storageRuntime';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit');
    return createExpoRouterMock({ router: { push: navigation.push } }).module;
});

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
// Only the two native view carriers are replaced. Exercise the installed JS
// wrapper and app adapter, not the default whole-package Markdown boundary stub.
vi.mock('../../../../node_modules/react-native-enriched-markdown/src/EnrichedMarkdownTextNativeComponent.ts', () => ({ default: 'NativeMarkdownText' }));
vi.mock('../../../../node_modules/react-native-enriched-markdown/src/EnrichedMarkdownNativeComponent.ts', () => ({ default: 'NativeGithubMarkdown' }));
vi.mock('react-native-enriched-markdown', async () => await vi.importActual<typeof import('react-native-enriched-markdown')>(
    '../../../../node_modules/react-native-enriched-markdown/src/native/EnrichedMarkdownText',
));

const { EnrichedMarkdownTextAdapter } = await import('./EnrichedMarkdownTextAdapter');
const { ArtifactPassageSelection } = await import('@/components/artifacts/ArtifactPassageSelection');
const { resetSessionDraftRepositoryForTests } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
let home: Awaited<ReturnType<typeof activateStorageAccountScope>> | null = null;
afterEach(() => { standardCleanup(); home?.dispose(); home = null; navigation.push.mockClear(); resetSessionDraftRepositoryForTests(); });

describe('installed enriched native selection carrier', () => {
    it('preserves actual rendered text and UTF-16 selection through the real dependency wrapper and app adapter', async () => {
        const selected = vi.fn();
        const screen = await renderScreen(<EnrichedMarkdownTextAdapter markdown="😀 **same**. 😀 **same**." profile="default"
            selectable streamingAnimated={false} agentTexMath={false} contextMenuItems={[{ text: 'Comment', onPress: selected }]} />);
        const renderedText = '\n😀 same. 😀 same.\n';
        const start = renderedText.lastIndexOf('same');
        await act(async () => screen.findByType('NativeMarkdownText').props.onContextMenuItemPress({ nativeEvent: {
            itemText: 'Comment', selectedText: 'same', sourceMarkdown: '😀 **same**. 😀 **same**.', renderedText, selectionStart: start, selectionEnd: start + 4,
        } }));
        expect(selected).toHaveBeenCalledWith({ text: 'same', renderedText, selection: { start, end: start + 4 } });
    });

    it('withholds mapping evidence from a held old native menu snapshot while preserving its text callback', async () => {
        const selected = vi.fn();
        const original = 'same. same.';
        const current = 'same.';
        const props = { profile: 'default' as const, selectable: true, streamingAnimated: false, agentTexMath: false,
            contextMenuItems: [{ text: 'Comment', onPress: selected }] };
        const screen = await renderScreen(<EnrichedMarkdownTextAdapter {...props} markdown={original} />);
        await act(async () => screen.update(<EnrichedMarkdownTextAdapter {...props} markdown={current} />));
        await act(async () => screen.findByType('NativeMarkdownText').props.onContextMenuItemPress({ nativeEvent: {
            itemText: 'Comment', selectedText: 'same', sourceMarkdown: original,
            renderedText: '\nsame. same.\n', selectionStart: 1, selectionEnd: 5,
        } }));
        expect(selected).toHaveBeenCalledWith({ text: 'same', selection: { start: 1, end: 5 } });
    });

    it('does not retarget a held native menu to a different Doc with identical Markdown', async () => {
        home = await activateStorageAccountScope({ serverId: 'home', accountId: 'alice' });
        const markdown = 'same. same.';
        const revision = { headerVersion: 1, bodyVersion: 1 };
        const screen = await renderScreen(<ArtifactPassageSelection artifactId="original" markdown={markdown} revision={revision} />);
        const native = screen.findByType('NativeMarkdownText');
        const held = native.props.onContextMenuItemPress;
        const event = { nativeEvent: { itemText: native.props.contextMenuItems[0].text, selectedText: 'same', sourceMarkdown: markdown,
            renderedText: '\nsame. same.\n', selectionStart: 1, selectionEnd: 5 } };
        await act(async () => held(event));
        expect(navigation.push).toHaveBeenCalledTimes(1);
        navigation.push.mockClear();
        await act(async () => screen.update(<ArtifactPassageSelection artifactId="different" markdown={markdown} revision={revision} />));
        await act(async () => held(event));
        expect(navigation.push).not.toHaveBeenCalled();
        await act(async () => screen.update(<ArtifactPassageSelection artifactId="original" markdown={markdown} revision={revision} />));
        await act(async () => held(event));
        expect(navigation.push).not.toHaveBeenCalled();
    });

    it('preserves a legacy text-only native selection callback without publishing a Doc passage', async () => {
        const selected = vi.fn();
        const screen = await renderScreen(<EnrichedMarkdownTextAdapter markdown="same." profile="default"
            selectable streamingAnimated={false} agentTexMath={false} contextMenuItems={[{ text: 'Comment', onPress: selected }]} />);
        const legacy = { itemText: 'Comment', selectedText: 'same', selectionStart: 0, selectionEnd: 4 };
        await act(async () => screen.findByType('NativeMarkdownText').props.onContextMenuItemPress({ nativeEvent: legacy }));
        expect(selected).toHaveBeenCalledWith({ text: 'same', selection: { start: 0, end: 4 } });

        home = await activateStorageAccountScope({ serverId: 'home', accountId: 'alice' });
        await act(async () => screen.update(<ArtifactPassageSelection artifactId="original" markdown="same." revision={{ headerVersion: 1, bodyVersion: 1 }} />));
        const native = screen.findByType('NativeMarkdownText');
        await act(async () => native.props.onContextMenuItemPress({ nativeEvent: { ...legacy, itemText: native.props.contextMenuItems[0].text } }));
        expect(navigation.push).not.toHaveBeenCalled();
    });
});
