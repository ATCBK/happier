import * as React from 'react';
import type { View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { MediaStageItem } from './mediaStageItems';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

describe('canonical media stage opener', () => {
    it('snapshots the selected gallery and returns its focus through the modal owner', async () => {
        const { openMediaStage } = await import('./useMediaStage');
        const { MediaStage } = await import('./MediaStage');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { ModalProvider, useModal } = await import('@/modal');
        const originRef = React.createRef<View>();
        const source = { enabled: true, source: { kind: 'uri' as const, uri: 'blob:selected' }, cacheKey: 'revision' };
        const items: MediaStageItem[] = [{ kind: 'image', title: 'First', source },
            { kind: 'image', title: 'Selected', source, originRef }];
        let modal!: ReturnType<typeof useModal>;
        function ObserveModal() { modal = useModal(); return null; }
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><ModalProvider><ObserveModal /></ModalProvider></InjectedAuthProvider>);
        try {
            let id = '';
            await act(async () => { id = openMediaStage(items, 1); });
            items.reverse();
            items.push({ kind: 'image', title: 'Later', source });
            expect(modal.state.modals[0]).toMatchObject({ id, type: 'custom', chrome: { kind: 'stage' } });
            expect(modal.state.modals[0].focusReturnRef).toBe(originRef);
            const stage = screen.findByType(MediaStage);
            expect(stage.props.items.map((item: MediaStageItem) => item.title)).toEqual(['First', 'Selected']);
            expect(stage.props.items[1].source).toBe(source);
            expect(stage.props.initialIndex).toBe(1);
            await act(async () => stage.props.onClose());
            expect(screen.findAllByType(MediaStage)).toHaveLength(0);
        } finally { await screen.unmount(); }
    });

    it('keeps stage keyboard handlers on the caller runtime across the modal host boundary', async () => {
        const { useMediaStage } = await import('./useMediaStage');
        const { KeyboardShortcutProvider, useKeyboardCommand } = await import('@/keyboard/KeyboardShortcutProvider');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { ModalProvider, useModal } = await import('@/modal');
        let open!: ReturnType<typeof useMediaStage>['open'];
        let execute!: ReturnType<typeof useKeyboardCommand>;
        let modal!: ReturnType<typeof useModal>;
        function Controls() { open = useMediaStage().open; execute = useKeyboardCommand(); modal = useModal(); return null; }
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><ModalProvider>
            <KeyboardShortcutProvider handlers={{}}><Controls /></KeyboardShortcutProvider>
        </ModalProvider></InjectedAuthProvider>);
        try {
            await act(async () => { open(['First', 'Second'].map(title => ({ kind: 'image', title,
                source: { enabled: true, source: { kind: 'uri', uri: `blob:${title}` } } }))); });
            // The native image load is the real stage's external intrinsic-size boundary.
            await act(async () => screen.findByTestId('media-stage-image')!.props.onLoad({ source: { width: 100, height: 60 } }));
            let consumed = false;
            await act(async () => { consumed = execute('media.next'); });
            expect(consumed).toBe(true);
            expect(screen.findByTestId('media-stage-image')!.props.source).toEqual({ uri: 'blob:Second' });
            await act(async () => modal.hideAllModals());
            expect(execute('media.next')).toBe(false);
        } finally { await screen.unmount(); }
    });
});
