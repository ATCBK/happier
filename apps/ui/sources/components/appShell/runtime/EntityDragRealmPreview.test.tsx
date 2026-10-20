// @vitest-environment jsdom
import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { OverlayPortalHost, OverlayPortalProvider } from '@/components/ui/popover/OverlayPortal';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import type { EntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropTypes';
import type { EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import { EntityDragRealmPreview } from './EntityDragRealmPreview';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
// Expo is the native-device boundary; the real shared adapter and policy stay in this path.
const nativeHaptics = vi.hoisted(() => ({
    impactAsync: vi.fn(async () => {}), selectionAsync: vi.fn(async () => {}),
    notificationAsync: vi.fn(async () => {}), performAndroidHapticsAsync: vi.fn(async () => {}),
}));
vi.mock('expo-haptics', () => ({
    ...nativeHaptics,
    ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
    NotificationFeedbackType: { Success: 'success', Error: 'error' },
    AndroidHaptics: { Drag_Start: 'drag-start', Segment_Tick: 'segment-tick', Context_Click: 'context-click', Reject: 'reject', Confirm: 'confirm', Long_Press: 'long-press' },
}));
vi.mock('@/utils/web/reactDomCjs', () => ({
    // ReactTestRenderer cannot render DOM portals; the native portal and drag owner stay real.
    requireReactDOM: () => ({ createPortal: (children: React.ReactNode) => children }),
}));

let runtime: EntityDragDropRuntime;
const retire: Array<() => void> = [];
function RuntimeProbe() { runtime = useEntityDragDropRuntime(); return null; }
function Realm(props: Readonly<{ page: string; feedback?: boolean }>) {
    return <OverlayPortalProvider>
        <RuntimeProbe />
        {props.feedback !== false ? <EntityDragRealmPreview /> : null}
        <React.Fragment key={props.page}>{props.page}</React.Fragment>
        <OverlayPortalHost />
    </OverlayPortalProvider>;
}

afterEach(() => {
    for (const effect of Object.values(nativeHaptics)) effect.mockClear();
    standardCleanup();
    for (const dispose of retire.splice(0)) dispose();
    runtime?.cancel('test-end');
});

describe('one app-realm carried preview', () => {
    it('ticks discrete places within one target, ignores repeated frames, and ticks allowed re-entry', async () => {
        Reflect.set(Platform, 'OS', 'ios');
        await renderScreen(<Realm page="Sessions" />);
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        let allowed = true;
        retire.push(runtime.registerSource({ id: 'row', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'todo', scope, todoId: 'task' }) }));
        retire.push(runtime.registerTarget({ id: 'list', scope, acceptedKinds: ['todo'],
            getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
            getDestinationKey: ({ pointer }) => pointer && pointer.y < 50 ? 'gap:a:b' : 'gap:b:c',
            resolve: () => allowed ? { status: 'allowed', effect: { actionId: 'tasks.internal.reorder', input: {}, preview: { verb: 'Move', target: 'Tasks' } } }
                : { status: 'refused', reason: { code: 'read-only', message: 'Read only' } }, execute: async () => ({ status: 'applied' }) }));
        await act(async () => { runtime.begin('row')!.move({ x: 20, y: 20 }); });
        expect(nativeHaptics.impactAsync).toHaveBeenCalledTimes(1);
        nativeHaptics.impactAsync.mockClear();
        expect(nativeHaptics.selectionAsync).toHaveBeenCalledTimes(1);
        await act(async () => { runtime.move({ x: 25, y: 25 }); runtime.move({ x: 30, y: 40 }); });
        expect(nativeHaptics.selectionAsync).toHaveBeenCalledTimes(1);
        await act(async () => { runtime.move({ x: 30, y: 60 }); });
        expect(nativeHaptics.selectionAsync).toHaveBeenCalledTimes(2);
        await act(async () => { allowed = false; runtime.refresh(); allowed = true; runtime.refresh(); });
        expect(nativeHaptics.selectionAsync).toHaveBeenCalledTimes(3);
        await act(async () => { runtime.cancel(); });
        expect(nativeHaptics.impactAsync).not.toHaveBeenCalled();
        expect(nativeHaptics.notificationAsync).not.toHaveBeenCalled();
    });

    it('keeps continuous canvas movement quiet after entering the allowed target', async () => {
        Reflect.set(Platform, 'OS', 'ios');
        await renderScreen(<Realm page="Board" />);
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        retire.push(runtime.registerSource({ id: 'card', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'todo', scope, todoId: 'task' }) }));
        retire.push(runtime.registerTarget({ id: 'canvas', scope, acceptedKinds: ['todo'], getDestinationKey: () => null,
            getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
            resolve: ({ pointer }) => ({ status: 'allowed', effect: { actionId: 'boards.apply',
                input: { x: pointer?.x ?? 0, y: pointer?.y ?? 0 }, preview: { verb: 'Move', target: 'Board' } } }),
            execute: async () => ({ status: 'applied' }) }));
        await act(async () => { runtime.begin('card')!.move({ x: 20, y: 20 }); });
        expect(nativeHaptics.selectionAsync).toHaveBeenCalledTimes(1);
        await act(async () => { runtime.move({ x: 40, y: 40 }); runtime.move({ x: 60, y: 60 }); });
        expect(nativeHaptics.selectionAsync).toHaveBeenCalledTimes(1);
    });

    it.each(['applied', 'refused', 'unknown'] as const)('settles %s once at the real outcome, with a quiet successful landing', async status => {
        Reflect.set(Platform, 'OS', 'ios');
        await renderScreen(<Realm page="Pending queue" />);
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        let finish: (outcome: EntityDropOutcomeV1) => void = () => {};
        const outcome = new Promise<EntityDropOutcomeV1>(resolve => { finish = resolve; });
        retire.push(runtime.registerSource({ id: 'message', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'todo', scope, todoId: 'message' }) }));
        retire.push(runtime.registerTarget({ id: 'queue', scope, acceptedKinds: ['todo'],
            getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
            resolve: () => ({ status: 'allowed', effect: { actionId: 'tasks.internal.reorder', input: {}, preview: { verb: 'Move', target: 'Queue' } } }),
            execute: () => outcome }));
        let release: Promise<EntityDropOutcomeV1 | null> | undefined;
        await act(async () => { const carry = runtime.begin('message')!; carry.move({ x: 20, y: 20 }); nativeHaptics.impactAsync.mockClear(); release = carry.release(); });
        try {
            expect(runtime.getSnapshot().phase).toBe('pending');
            expect(nativeHaptics.impactAsync).not.toHaveBeenCalled();
            expect(nativeHaptics.notificationAsync).not.toHaveBeenCalled();
            await act(async () => { finish(status === 'applied' ? { status } : { status, reason: { code: 'owner-result', message: 'Owner result' } }); await release; runtime.refresh(); });
            expect(nativeHaptics.impactAsync).toHaveBeenCalledTimes(status === 'applied' ? 1 : 0);
            expect(nativeHaptics.notificationAsync).toHaveBeenCalledTimes(status === 'refused' ? 1 : 0);
            expect(nativeHaptics.notificationAsync).not.toHaveBeenCalledWith('success');
        } finally {
            await act(async () => { finish({ status: 'unknown', reason: { code: 'test-cleanup', message: 'Test cleanup' } }); await release; });
        }
    });

    it.each(['same-position', 'already-kept', 'already-placed', 'board-already-here', 'unchanged', 'already_under'])('leaves a %s release silent', async code => {
        Reflect.set(Platform, 'OS', 'ios');
        await renderScreen(<Realm page="Home" />);
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        retire.push(runtime.registerSource({ id: 'widget', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'home-section', scope, sectionId: 'setup' }) }));
        retire.push(runtime.registerTarget({ id: 'own-place', scope, acceptedKinds: ['home-section'],
            getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
            resolve: () => ({ status: 'refused', reason: { code, message: 'Same position' } }), execute: async () => ({ status: 'applied' }) }));
        await act(async () => { const carry = runtime.begin('widget')!; carry.move({ x: 20, y: 20 }); nativeHaptics.impactAsync.mockClear(); await carry.release(); });
        expect(nativeHaptics.impactAsync).not.toHaveBeenCalled();
        expect(nativeHaptics.notificationAsync).not.toHaveBeenCalled();
    });

    it.each(['ios', 'android', 'web'])('shows Home and Zen carries without SessionsList on %s across page retirement', async platform => {
        Reflect.set(Platform, 'OS', platform);
        const screen = await renderScreen(<Realm page="Home" />);
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        retire.push(runtime.registerSource({ id: 'home-section', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'home-section', scope, sectionId: 'setup' }),
            describe: () => ({ title: 'Home setup' }) }));
        retire.push(runtime.registerSource({ id: 'todo', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'todo', scope, todoId: 'task' }),
            describe: () => ({ title: 'Zen task' }) }));
        await act(async () => { runtime.begin('home-section')!.move({ x: 150, y: 150 }); });
        expect(screen.findAllHostsByTestId('entity-drag-carried-preview')).toHaveLength(1);
        // A phone lift ticks once; the web pointer shows grabbing instead.
        if (platform === 'android') expect(nativeHaptics.performAndroidHapticsAsync).toHaveBeenCalledWith('drag-start');
        else expect(nativeHaptics.impactAsync).toHaveBeenCalledTimes(platform === 'web' ? 0 : 1);
        expect(JSON.stringify(screen.tree.toJSON())).toContain('Home setup');
        await screen.update(<Realm page="Zen" />);
        expect(runtime.getSnapshot().phase).toBe('carrying');
        expect(screen.findAllHostsByTestId('entity-drag-carried-preview')).toHaveLength(1);
        await act(async () => { runtime.cancel('switch-source'); runtime.begin('todo')!.move({ x: 150, y: 150 }); });
        expect(screen.findAllHostsByTestId('entity-drag-carried-preview')).toHaveLength(1);
        expect(JSON.stringify(screen.tree.toJSON())).toContain('Zen task');
        await act(async () => { runtime.cancel('cancel'); });
        expect(screen.findAllHostsByTestId('entity-drag-carried-preview')).toHaveLength(0);
    });

    it('keeps one web cancellation boundary across navigation and retires it with the feedback host', async () => {
        Reflect.set(Platform, 'OS', 'web');
        const screen = await renderScreen(<Realm page="Pool" />);
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        retire.push(runtime.registerSource({ id: 'todo', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'todo', scope, todoId: 'task' }), describe: () => ({ title: 'Task' }) }));
        await act(async () => { runtime.begin('todo')!.move({ x: 150, y: 150 }); });
        await screen.update(<Realm page="Pending queue" />);
        await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })); });
        expect(runtime.getSnapshot().phase).toBe('idle');
        await act(async () => { runtime.begin('todo'); });
        await screen.update(<Realm page="Signed out" feedback={false} />);
        expect(runtime.getSnapshot().phase).toBe('idle');
        await act(async () => { runtime.begin('todo'); window.dispatchEvent(new Event('blur')); });
        expect(runtime.getSnapshot().phase).toBe('carrying');
    });
});
