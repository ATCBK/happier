/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => await vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return await createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/components/ui/icons/SafeIonicons', () => ({
    SafeIonicons: (props: Readonly<{ name?: string }>) =>
        React.createElement('span', { 'data-icon': props.name }),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
    vi.unstubAllGlobals();
    act(() => { root?.unmount(); });
    container?.remove();
    root = null;
    container = null;
});

async function renderDictationButton(onPress: () => void): Promise<HTMLElement> {
    // A finger is the primary pointer here, as on a phone browser.
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === '(pointer: coarse)' || query === '(hover: none)',
        media: query,
    }));
    const { AgentInputDictationButton } = await import('./AgentInputDictationButton');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
        root!.render(React.createElement(AgentInputDictationButton, { status: 'idle', onPress }));
    });
    const element = container.querySelector<HTMLElement>('[data-testid="agent-input-dictation"]');
    if (!element) throw new Error('dictation button did not render');
    return element;
}

/**
 * The desktop app IS the web bundle, and react-native-web 0.21 implements `hitSlop` only in its legacy
 * `Touchable` export, so a finger's reach on the web is an invisible hit frame inside the button. This
 * reads the drawn box and that frame out of the DOM rather than recomputing them from the props.
 */
describe('AgentInputDictationButton web pointer geometry', () => {
    it('draws the 24pt circle and reaches the finger target through its hit frame, never a larger drawn box', async () => {
        const onPress = vi.fn();
        const element = await renderDictationButton(onPress);

        // The press target is the drawn circle itself; the layout box stays at design.
        const box = getComputedStyle(element);
        expect(box.width).toBe('24px');
        expect(box.height).toBe('24px');
        expect(element.getAttribute('role')).toBe('button');
        act(() => {
            element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(onPress).toHaveBeenCalledTimes(1);

        // The frame reaches the 44pt target past the circle: 5 above (the composer's declared edge,
        // the rest belongs to the Look chip), 10 below, none sideways where the accessories touch.
        const frame = element.querySelector<HTMLElement>(':scope > [data-happier-hit-area="true"]');
        expect(frame).not.toBeNull();
        const reach = getComputedStyle(frame!);
        const offset = (side: 'top' | 'bottom' | 'left' | 'right') => Math.abs(Number.parseFloat(reach[side]));
        expect([offset('top'), offset('bottom'), offset('left'), offset('right')]).toEqual([5, 10, 0, 0]);
    });
});
