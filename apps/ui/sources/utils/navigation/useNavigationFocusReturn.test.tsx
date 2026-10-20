import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    renderHook as renderTestHook,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { FocusReturnProvider } from '@/keyboard/focusReturn';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';

const navigationState = vi.hoisted(() => ({
    setFocused: null as null | React.Dispatch<React.SetStateAction<boolean>>,
}));

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

/** Drive the real destination owner rather than a retired native useFocusEffect mock. */
function DestinationFocusScope(props: React.PropsWithChildren) {
    const [focused, setFocused] = React.useState(true);
    navigationState.setFocused = setFocused;
    return <DestinationInstanceHost tabId="focus-test" ref={{ kind: 'settings', params: {} }} pathname="/settings" focused={focused} visible>{props.children}</DestinationInstanceHost>;
}

function renderHook<T>(hook: () => T) {
    return renderTestHook(hook, { wrapper: DestinationFocusScope });
}

async function returnToScreen() {
    await React.act(async () => { navigationState.setFocused?.(false); });
    await React.act(async () => { navigationState.setFocused?.(true); });
}

describe('useNavigationFocusReturn', () => {
    afterEach(() => {
        standardCleanup();
        vi.unstubAllGlobals();
        navigationState.setFocused = null;
    });

    it('keeps navigation unchanged when the platform has no document focus owner', async () => {
        vi.stubGlobal('document', undefined);
        const navigate = vi.fn();
        const { useNavigationFocusReturn } = await import('./useNavigationFocusReturn');
        const hook = await renderHook(() => useNavigationFocusReturn());

        React.act(() => {
            hook.getCurrent()(navigate);
        });
        await returnToScreen();

        expect(navigate).toHaveBeenCalledOnce();
    });

    it('restores a registered native host when normal navigation returns', async () => {
        vi.stubGlobal('document', undefined);
        const focus = vi.fn();
        const navigate = vi.fn();
        const { useNavigationFocusReturn } = await import('./useNavigationFocusReturn');
        const hook = await renderHook(() => useNavigationFocusReturn());

        React.act(() => {
            hook.getCurrent().targetRef('native-return-target')({ focus });
            hook.getCurrent().navigateFrom('native-return-target', navigate);
        });

        expect(navigate).toHaveBeenCalledOnce();
        expect(focus).not.toHaveBeenCalled();

        await returnToScreen();

        expect(focus).toHaveBeenCalledOnce();
    });

    it('restores the exact initiating element only after the source screen regains focus', async () => {
        const focus = vi.fn();
        const target = {
            focus,
            isConnected: true,
            getAttribute: (name: string) => name === 'data-testid' ? 'return-target' : null,
        };
        vi.stubGlobal('document', {
            activeElement: target,
            body: {},
            documentElement: {},
            querySelectorAll: () => [target],
        });
        const navigate = vi.fn();
        const { useNavigationFocusReturn } = await import('./useNavigationFocusReturn');
        const hook = await renderHook(() => useNavigationFocusReturn());

        expect(focus).not.toHaveBeenCalled();

        React.act(() => {
            hook.getCurrent()(() => navigate());
        });

        expect(navigate).toHaveBeenCalledOnce();
        expect(focus).not.toHaveBeenCalled();

        await returnToScreen();

        expect(focus).toHaveBeenCalledOnce();

        await returnToScreen();
        expect(focus).toHaveBeenCalledOnce();
    });

    it('returns focus to the row that opened an in-place picker once the row is back', async () => {
        const rowFocus = vi.fn();
        const row = { focus: rowFocus, isConnected: true, getAttribute: (name: string) => name === 'data-testid' ? 'settings-row' : null };
        const pickerDone = { focus: vi.fn(), isConnected: true, getAttribute: (name: string) => name === 'data-testid' ? 'picker-done' : null };
        const documentState = { activeElement: row as typeof row | typeof pickerDone, body: {}, documentElement: {}, querySelectorAll: () => [] as unknown[] };
        vi.stubGlobal('document', documentState);
        const { useInPlaceFocusReturn } = await import('./useNavigationFocusReturn');
        const hook = await renderHook(() => useInPlaceFocusReturn());

        hook.getCurrent().capture();
        // The picker replaces the settings; its own control takes focus, the row is gone.
        documentState.activeElement = pickerDone;
        // The settings are back with a new host for the same row.
        const remountedRow = { ...row, focus: vi.fn() };
        documentState.querySelectorAll = () => [remountedRow, pickerDone];

        expect(hook.getCurrent().restore()).toBe(true);
        expect(remountedRow.focus).toHaveBeenCalledOnce();
        expect(pickerDone.focus).not.toHaveBeenCalled();
        // One return per capture.
        expect(hook.getCurrent().restore()).toBe(false);
    });

    it('retains the original trigger when focus moves before deferred navigation commits', async () => {
        const originalFocus = vi.fn();
        const movedFocus = vi.fn();
        const originalTarget = {
            focus: originalFocus,
            isConnected: true,
            getAttribute: (name: string) => name === 'data-testid' ? 'original-trigger' : null,
        };
        const movedTarget = {
            focus: movedFocus,
            isConnected: true,
            getAttribute: (name: string) => name === 'data-testid' ? 'moved-trigger' : null,
        };
        const documentState = {
            activeElement: originalTarget as typeof originalTarget | typeof movedTarget,
            body: {},
            documentElement: {},
            querySelectorAll: () => [originalTarget, movedTarget],
        };
        vi.stubGlobal('document', documentState);
        const navigate = vi.fn();
        const { useNavigationFocusReturn } = await import('./useNavigationFocusReturn');
        const hook = await renderHook(() => useNavigationFocusReturn());

        const capture = hook.getCurrent().capture();
        documentState.activeElement = movedTarget;
        React.act(() => {
            capture.navigate(navigate);
        });
        await returnToScreen();

        expect(navigate).toHaveBeenCalledOnce();
        expect(originalFocus).toHaveBeenCalledOnce();
        expect(movedFocus).not.toHaveBeenCalled();
    });

    it('safely drops a return target that disconnected while the destination was open', async () => {
        const focus = vi.fn();
        const target = {
            focus,
            isConnected: true,
            getAttribute: (name: string) => name === 'data-testid' ? 'disconnected-target' : null,
        };
        vi.stubGlobal('document', {
            activeElement: target,
            body: {},
            documentElement: {},
            querySelectorAll: () => [target],
        });
        const { useNavigationFocusReturn } = await import('./useNavigationFocusReturn');
        const hook = await renderHook(() => useNavigationFocusReturn());

        React.act(() => {
            hook.getCurrent()(() => undefined);
        });
        target.isConnected = false;

        await returnToScreen();
        expect(focus).not.toHaveBeenCalled();
    });

    it('restores the sole visible enabled incarnation when the original trigger becomes a hidden stack copy', async () => {
        const originalFocus = vi.fn();
        const visibleFocus = vi.fn();
        const disabledFocus = vi.fn();
        let originalHidden = false;
        const createTarget = (
            focus: ReturnType<typeof vi.fn>,
            options: Readonly<{ hidden: () => boolean; disabled?: boolean }>,
        ) => ({
            focus,
            isConnected: true,
            getAttribute: (name: string) => {
                if (name === 'data-testid') return 'settings-provider-available:deepseek';
                if (name === 'aria-disabled') return options.disabled ? 'true' : null;
                return null;
            },
            getClientRects: () => options.hidden() ? [] : [{ width: 313, height: 58 }],
            getBoundingClientRect: () => options.hidden()
                ? ({ width: 0, height: 0 })
                : ({ width: 313, height: 58 }),
            closest: () => null,
        });
        const original = createTarget(originalFocus, { hidden: () => originalHidden });
        const disabledDuplicate = createTarget(disabledFocus, {
            hidden: () => false,
            disabled: true,
        });
        const visibleReplacement = createTarget(visibleFocus, { hidden: () => false });
        vi.stubGlobal('document', {
            activeElement: original,
            body: {},
            documentElement: {},
            querySelectorAll: () => [original, disabledDuplicate, visibleReplacement],
        });
        const { useNavigationFocusReturn } = await import('./useNavigationFocusReturn');
        const hook = await renderHook(() => useNavigationFocusReturn());

        React.act(() => {
            hook.getCurrent()(() => undefined);
        });
        originalHidden = true;

        await returnToScreen();

        expect(originalFocus).not.toHaveBeenCalled();
        expect(disabledFocus).not.toHaveBeenCalled();
        expect(visibleFocus).toHaveBeenCalledOnce();
    });

    it('does not guess between multiple visible incarnations with the same stable identity', async () => {
        const createTarget = (focus: ReturnType<typeof vi.fn>, visible: boolean) => ({
            focus,
            isConnected: true,
            getAttribute: (name: string) => name === 'data-testid' ? 'duplicate-trigger' : null,
            getClientRects: () => visible ? [{ width: 100, height: 40 }] : [],
            getBoundingClientRect: () => visible
                ? ({ width: 100, height: 40 })
                : ({ width: 0, height: 0 }),
            closest: () => null,
        });
        const originalFocus = vi.fn();
        const firstVisibleFocus = vi.fn();
        const secondVisibleFocus = vi.fn();
        const original = createTarget(originalFocus, false);
        const firstVisible = createTarget(firstVisibleFocus, true);
        const secondVisible = createTarget(secondVisibleFocus, true);
        let candidates = [original, firstVisible, secondVisible];
        vi.stubGlobal('document', {
            activeElement: original,
            body: {},
            documentElement: {},
            querySelectorAll: () => candidates,
        });
        const { useNavigationFocusReturn } = await import('./useNavigationFocusReturn');
        const hook = await renderHook(() => useNavigationFocusReturn());

        React.act(() => {
            hook.getCurrent()(() => undefined);
        });
        await returnToScreen();

        expect(originalFocus).not.toHaveBeenCalled();
        expect(firstVisibleFocus).not.toHaveBeenCalled();
        expect(secondVisibleFocus).not.toHaveBeenCalled();

        candidates = [firstVisible];
        await returnToScreen();
        expect(firstVisibleFocus).not.toHaveBeenCalled();
    });

    it('clears the pending shared intent when navigation throws', async () => {
        const focus = vi.fn();
        const target = {
            focus,
            isConnected: true,
            getAttribute: (name: string) => name === 'data-testid' ? 'throwing-target' : null,
        };
        vi.stubGlobal('document', {
            activeElement: target,
            body: {},
            documentElement: {},
            querySelectorAll: () => [target],
        });
        const { useNavigationFocusReturn } = await import('./useNavigationFocusReturn');
        const hook = await renderHook(() => useNavigationFocusReturn());

        expect(() => {
            hook.getCurrent()(() => {
                throw new Error('navigation failed');
            });
        }).toThrow('navigation failed');

        await returnToScreen();
        expect(focus).not.toHaveBeenCalled();
    });

    it('waits for final layout readiness before a different screen instance consumes the shared return', async () => {
        const originalFocus = vi.fn();
        const visibleFocus = vi.fn();
        let originalHidden = false;
        let replacementHidden = true;
        const createTarget = (
            focus: ReturnType<typeof vi.fn>,
            hidden: () => boolean,
        ) => ({
            focus,
            isConnected: true,
            getAttribute: (name: string) => name === 'data-testid'
                ? 'settings-provider-add-custom'
                : null,
            getClientRects: () => hidden() ? [] : [{ width: 313, height: 58 }],
            getBoundingClientRect: () => hidden()
                ? ({ width: 0, height: 0 })
                : ({ width: 313, height: 58 }),
            closest: () => null,
        });
        const original = createTarget(originalFocus, () => originalHidden);
        const visibleReplacement = createTarget(visibleFocus, () => replacementHidden);
        const body = {};
        vi.stubGlobal('document', {
            activeElement: original,
            body,
            documentElement: {},
            querySelectorAll: () => [original, visibleReplacement],
        });
        const { useNavigationFocusReturn } = await import('./useNavigationFocusReturn');
        const navigateFromSource = {
            current: null as ((navigate: () => void) => void) | null,
        };

        type ScreenInstanceId = 'source' | 'return' | 'later';

        function ScreenInstance(props: Readonly<{
            instance: ScreenInstanceId;
            ready: boolean;
        }>) {
            const navigateWithFocusReturn = useNavigationFocusReturn({ ready: props.ready });
            if (props.instance === 'source') {
                navigateFromSource.current = navigateWithFocusReturn;
            }
            return null;
        }

        function Harness(props: Readonly<{
            instance: ScreenInstanceId;
            ready: boolean;
        }>) {
            return (
                <FocusReturnProvider>
                    <ScreenInstance
                        key={props.instance}
                        instance={props.instance}
                        ready={props.ready}
                    />
                </FocusReturnProvider>
            );
        }

        const screen = await renderScreen(<Harness instance="source" ready />);
        const sourceNavigation = navigateFromSource.current;
        if (!sourceNavigation) throw new Error('Expected the source screen navigation callback');
        React.act(() => {
            sourceNavigation(() => undefined);
        });

        originalHidden = true;
        replacementHidden = false;
        (document as unknown as { activeElement: unknown }).activeElement = body;
        await screen.update(<Harness instance="return" ready={false} />);
        expect(originalFocus).not.toHaveBeenCalled();
        expect(visibleFocus).not.toHaveBeenCalled();

        await screen.update(<Harness instance="return" ready />);

        expect(originalFocus).not.toHaveBeenCalled();
        expect(visibleFocus).toHaveBeenCalledOnce();

        await screen.update(<Harness instance="later" ready />);
        expect(visibleFocus).toHaveBeenCalledOnce();
    });
});
