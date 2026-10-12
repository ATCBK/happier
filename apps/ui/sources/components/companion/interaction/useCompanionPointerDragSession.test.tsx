import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { useCompanionPointerDragSession } from './useCompanionPointerDragSession';
import { PET_POINTER_DRAG_SELECTORS } from '@/components/pets/interaction/petPointerDragBindings';

const platformState = vi.hoisted(() => ({
    os: 'web',
}));

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-native')>();
    return {
        ...actual,
        Platform: {
            ...actual.Platform,
            get OS() {
                return platformState.os;
            },
        },
    };
});

class TestPointerEvent extends Event {
    button: number;
    pointerId: number;
    clientX: number;
    clientY: number;
    screenX: number;
    screenY: number;
    timeStamp: number;

    constructor(type: string, init: {
        button?: number;
        pointerId?: number;
        clientX: number;
        clientY: number;
        screenX: number;
        screenY: number;
        timeStamp?: number;
    }) {
        super(type, { cancelable: true });
        this.button = init.button ?? 0;
        this.pointerId = init.pointerId ?? 1;
        this.clientX = init.clientX;
        this.clientY = init.clientY;
        this.screenX = init.screenX;
        this.screenY = init.screenY;
        this.timeStamp = init.timeStamp ?? 0;
    }
}

function closestMascot(selector: string): object | null {
    return selector.includes('data-pet-mascot') ? {} : null;
}

describe('useCompanionPointerDragSession', () => {
    afterEach(() => {
        standardCleanup();
        platformState.os = 'web';
        vi.unstubAllGlobals();
    });

    it('captures and releases the pointer on a real web target', async () => {
        const fakeWindow = new EventTarget();
        vi.stubGlobal('window', fakeWindow);
        const setPointerCapture = vi.fn();
        const releasePointerCapture = vi.fn();
        const onDragMove = vi.fn();

        function Harness() {
            const drag = useCompanionPointerDragSession({
                coordinateSpace: 'screen',
                selectors: PET_POINTER_DRAG_SELECTORS,
                onDragMove,
            });
            return (
                <View
                    ref={drag.dragTargetRef}
                    testID="pet-drag-target"
                    {...drag.pointerHandlers}
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        const target = screen.findByTestId('pet-drag-target');

        await act(async () => {
            target?.props.onPointerDown?.({
                button: 0,
                pointerId: 7,
                clientX: 10,
                clientY: 20,
                screenX: 100,
                screenY: 200,
                timeStamp: 0,
                target: { closest: closestMascot },
                currentTarget: { setPointerCapture, releasePointerCapture },
                preventDefault: vi.fn(),
            });
        });

        // A press is not a drag yet: capturing now would retarget the coming `click` away from the
        // pressed child, so a tap on a control inside the handle would never activate it.
        expect(setPointerCapture).not.toHaveBeenCalled();

        const move = new TestPointerEvent('pointermove', {
            pointerId: 7,
            clientX: 11,
            clientY: 22,
            screenX: 112,
            screenY: 206,
            timeStamp: 20,
        });
        await act(async () => { fakeWindow.dispatchEvent(move); });

        expect(setPointerCapture).toHaveBeenCalledWith(7);
        expect(move.defaultPrevented).toBe(true);

        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('pointerup', {
                pointerId: 7,
                clientX: 11,
                clientY: 22,
                screenX: 112,
                screenY: 206,
                timeStamp: 25,
            }));
        });

        expect(onDragMove).toHaveBeenCalledWith(expect.objectContaining({
            coordinateSpace: 'screen',
            deltaX: 12,
            deltaY: 6,
        }));
        expect(releasePointerCapture).toHaveBeenCalledWith(7);
    });

    it('keeps below-threshold movement as an activation instead of a drag move', async () => {
        const fakeWindow = new EventTarget();
        vi.stubGlobal('window', fakeWindow);
        const onDragMove = vi.fn();
        const onDragEnd = vi.fn();
        const onActivate = vi.fn();

        function Harness() {
            const drag = useCompanionPointerDragSession({
                coordinateSpace: 'screen',
                selectors: PET_POINTER_DRAG_SELECTORS,
                onDragMove,
                onDragEnd,
                onActivate,
            });
            return (
                <View
                    ref={drag.dragTargetRef}
                    testID="pet-drag-target"
                    {...drag.pointerHandlers}
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        const target = screen.findByTestId('pet-drag-target');

        await act(async () => {
            target?.props.onPointerDown?.({
                button: 0,
                pointerId: 8,
                clientX: 10,
                clientY: 20,
                screenX: 100,
                screenY: 200,
                timeStamp: 0,
                target: { closest: closestMascot },
                currentTarget: {},
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        const move = new TestPointerEvent('pointermove', {
            pointerId: 8,
            clientX: 12,
            clientY: 20,
            screenX: 102,
            screenY: 200,
            timeStamp: 10,
        });
        await act(async () => {
            fakeWindow.dispatchEvent(move);
            fakeWindow.dispatchEvent(new TestPointerEvent('pointerup', {
                pointerId: 8,
                clientX: 12,
                clientY: 20,
                screenX: 102,
                screenY: 200,
                timeStamp: 20,
            }));
        });

        expect(onDragMove).not.toHaveBeenCalled();
        expect(move.defaultPrevented).toBe(false);
        expect(onDragEnd).toHaveBeenCalledWith(expect.objectContaining({
            pointerId: 8,
            cancelled: false,
            coordinateSpace: 'screen',
        }));
        expect(onActivate).toHaveBeenCalledTimes(1);
    });

    it('leaves a tap uncaptured and unsuppressed so the pressed child receives its click', async () => {
        const fakeWindow = new EventTarget();
        vi.stubGlobal('window', fakeWindow);
        const setPointerCapture = vi.fn();
        const releasePointerCapture = vi.fn();
        const onDragMove = vi.fn();
        let suppress: (() => boolean) | null = null;

        function Harness() {
            const drag = useCompanionPointerDragSession({
                coordinateSpace: 'client',
                selectors: PET_POINTER_DRAG_SELECTORS,
                onDragMove,
            });
            suppress = drag.shouldSuppressPress;
            return <View ref={drag.dragTargetRef} testID="pet-drag-target" {...drag.pointerHandlers} />;
        }

        const screen = await renderScreen(<Harness />);
        const target = screen.findByTestId('pet-drag-target');

        await act(async () => {
            target?.props.onPointerDown?.({
                button: 0,
                pointerId: 11,
                clientX: 10,
                clientY: 20,
                screenX: 100,
                screenY: 200,
                timeStamp: 0,
                target: { closest: closestMascot },
                currentTarget: { setPointerCapture, releasePointerCapture },
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });
        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', {
                pointerId: 11, clientX: 11, clientY: 21, screenX: 101, screenY: 201, timeStamp: 10,
            }));
            fakeWindow.dispatchEvent(new TestPointerEvent('pointerup', {
                pointerId: 11, clientX: 11, clientY: 21, screenX: 101, screenY: 201, timeStamp: 20,
            }));
        });

        expect(setPointerCapture).not.toHaveBeenCalled();
        expect(releasePointerCapture).not.toHaveBeenCalled();
        expect(onDragMove).not.toHaveBeenCalled();
        expect(suppress!()).toBe(false);
    });

    it('ignores pointer starts that did not originate on the mascot', async () => {
        const fakeWindow = new EventTarget();
        vi.stubGlobal('window', fakeWindow);
        const setPointerCapture = vi.fn();
        const onDragStart = vi.fn();
        const onDragMove = vi.fn();

        function Harness() {
            const drag = useCompanionPointerDragSession({
                coordinateSpace: 'screen',
                selectors: PET_POINTER_DRAG_SELECTORS,
                onDragMove,
                onDragStart,
            });
            return (
                <View
                    ref={drag.dragTargetRef}
                    testID="pet-drag-target"
                    {...drag.pointerHandlers}
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        const target = screen.findByTestId('pet-drag-target');

        await act(async () => {
            target?.props.onPointerDown?.({
                button: 0,
                pointerId: 6,
                clientX: 10,
                clientY: 20,
                screenX: 100,
                screenY: 200,
                timeStamp: 0,
                target: {},
                currentTarget: { setPointerCapture },
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', {
                pointerId: 6,
                clientX: 30,
                clientY: 20,
                screenX: 300,
                screenY: 200,
                timeStamp: 10,
            }));
        });

        expect(setPointerCapture).not.toHaveBeenCalled();
        expect(onDragStart).not.toHaveBeenCalled();
        expect(onDragMove).not.toHaveBeenCalled();
    });

    it('ignores move and end events from a different active pointer', async () => {
        const fakeWindow = new EventTarget();
        vi.stubGlobal('window', fakeWindow);
        const onDragMove = vi.fn();
        const onDragEnd = vi.fn();

        function Harness() {
            const drag = useCompanionPointerDragSession({
                coordinateSpace: 'screen',
                selectors: PET_POINTER_DRAG_SELECTORS,
                onDragMove,
                onDragEnd,
            });
            return (
                <View
                    ref={drag.dragTargetRef}
                    testID="pet-drag-target"
                    {...drag.pointerHandlers}
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        const target = screen.findByTestId('pet-drag-target');

        await act(async () => {
            target?.props.onPointerDown?.({
                button: 0,
                pointerId: 9,
                clientX: 10,
                clientY: 20,
                screenX: 100,
                screenY: 200,
                timeStamp: 0,
                target: { closest: closestMascot },
                currentTarget: {},
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', {
                pointerId: 10,
                clientX: 30,
                clientY: 20,
                screenX: 300,
                screenY: 200,
                timeStamp: 10,
            }));
            fakeWindow.dispatchEvent(new TestPointerEvent('pointerup', {
                pointerId: 10,
                clientX: 30,
                clientY: 20,
                screenX: 300,
                screenY: 200,
                timeStamp: 20,
            }));
        });

        expect(onDragMove).not.toHaveBeenCalled();
        expect(onDragEnd).not.toHaveBeenCalled();
    });
});
