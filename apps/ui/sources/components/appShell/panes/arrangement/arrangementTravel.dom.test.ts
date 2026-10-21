/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureArrangementTravelStart, playArrangementTravel } from './arrangementTravel';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

afterEach(() => { document.body.replaceChildren(); });

function animatedElement(testId: string, initialX: number, width = 440) {
    const element = document.createElement('div');
    element.dataset.testid = testId;
    let x = initialX;
    const running: Animation[] = [];
    const calls: Keyframe[][] = [];
    Object.defineProperty(element, 'getBoundingClientRect', { value: () => new DOMRect(x, 0, width, 600) });
    Object.defineProperty(element, 'getAnimations', { value: () => [...running] });
    Object.defineProperty(element, 'animate', { value: (keyframes: Keyframe[]) => {
        calls.push(keyframes);
        // WAAPI is the browser boundary; EventTarget preserves real finish/cancel listener semantics.
        const animation = Object.assign(new EventTarget(), { id: '', cancel: vi.fn(() => {
            running.splice(running.indexOf(animation), 1);
            queueMicrotask(() => animation.dispatchEvent(new Event('cancel')));
        }) }) as unknown as Animation;
        running.push(animation);
        return animation;
    } });
    return { element, running, calls, move: (nextX: number) => { x = nextX; } };
}

describe('retained arrangement travel', () => {
    it('retargets from the captured visible position and restores stacking when reduced motion replaces travel', async () => {
        const host = animatedElement('host', 0);
        const main = animatedElement('multi-pane-main-column', 0);
        host.element.appendChild(main.element);
        document.body.appendChild(host.element);
        main.element.style.zIndex = '7';
        const start = captureArrangementTravelStart(host.element)!;
        main.move(600);
        playArrangementTravel(host.element, start, false);
        expect(main.calls[0]?.[0]?.transform).toContain('-600px');
        const previous = main.running[0]!;
        // The browser reports the current animated rectangle, not its committed resting layout.
        main.move(240);
        const retarget = captureArrangementTravelStart(host.element)!;
        main.move(0);
        playArrangementTravel(host.element, retarget, false);
        expect(previous.cancel).toHaveBeenCalledOnce();
        expect(main.calls[1]?.[0]?.transform).toContain('240px');
        await Promise.resolve();
        expect(main.element.style.zIndex).toBe('2');
        const active = main.running[0]!;
        playArrangementTravel(host.element, captureArrangementTravelStart(host.element)!, true);
        expect(active.cancel).toHaveBeenCalledOnce();
        await Promise.resolve();
        expect(main.element.style.zIndex).toBe('7');
        expect(host.calls.at(-1)).toEqual([{ opacity: 0.4 }, { opacity: 1 }]);
    });
});
