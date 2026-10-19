/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return {
        ...actual,
        Platform: {
            ...actual.Platform,
            OS: 'web',
            select: <T,>(values: { web?: T; default?: T; native?: T; ios?: T; android?: T }) => (
                values.web ?? values.default ?? values.native ?? values.ios ?? values.android
            ),
        },
    };
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const { NewSessionLaunchSurface } = await import('./NewSessionLaunchSurface');

type MountedSurface = Readonly<{
    render: (input: Readonly<{ frozen: boolean }>) => Promise<void>;
    onRequestClose: ReturnType<typeof vi.fn>;
    unmount: () => Promise<void>;
}>;

const mountedSurfaces: MountedSurface[] = [];

afterEach(async () => {
    while (mountedSurfaces.length > 0) {
        await mountedSurfaces.pop()?.unmount();
    }
});

describe('NewSessionLaunchSurface web focus containment', () => {
    it('moves focus into the launch overlay, contains Tab, and returns focus to Send when the attempt clears', async () => {
        const surface = await mountSurface({ frozen: false });
        const send = requireElement<HTMLButtonElement>('new-session-send');
        send.focus();
        expect(document.activeElement).toBe(send);

        await surface.render({ frozen: true });

        const overlay = requireElement('new-session-launch-overlay');
        const authoring = requireElement('new-session-launch-authoring');
        expect(document.activeElement).toBe(overlay);
        expect(overlay.getAttribute('role')).toBe('dialog');
        expect(overlay.getAttribute('aria-modal')).toBe('true');
        expect(authoring.hasAttribute('inert')).toBe(true);
        expect(authoring.getAttribute('aria-hidden')).toBe('true');

        const exportAction = requireElement<HTMLButtonElement>('overlay-export');
        const cancelAction = requireElement<HTMLButtonElement>('overlay-cancel');
        cancelAction.focus();
        dispatchTab();
        expect(document.activeElement).toBe(exportAction);
        exportAction.focus();
        dispatchTab({ shiftKey: true });
        expect(document.activeElement).toBe(cancelAction);

        await surface.render({ frozen: false });
        expect(document.activeElement).toBe(send);
    });

    it('routes Escape to the launch cancellation owner while the frozen composer stays mounted', async () => {
        const surface = await mountSurface({ frozen: false });
        requireElement<HTMLButtonElement>('new-session-send').focus();
        await surface.render({ frozen: true });

        await act(async () => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true,
            }));
        });

        expect(surface.onRequestClose).toHaveBeenCalledTimes(1);
        // Escape asks the launch owner to cancel; it never unmounts the draft.
        expect(requireElement('new-session-prompt')).toBeTruthy();
    });
});

async function mountSurface(initial: Readonly<{ frozen: boolean }>): Promise<MountedSurface> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onRequestClose = vi.fn();
    const surface: MountedSurface = {
        onRequestClose,
        render: async (input) => {
            await act(async () => {
                root.render(
                    <NewSessionLaunchSurface
                        overlay={input.frozen ? (
                            <>
                                <button data-testid="overlay-export">Export</button>
                                <button data-testid="overlay-cancel">Cancel</button>
                            </>
                        ) : null}
                        onRequestClose={onRequestClose}
                    >
                        <input data-testid="new-session-prompt" />
                        <button data-testid="new-session-send">Send</button>
                    </NewSessionLaunchSurface>,
                );
            });
        },
        unmount: async () => {
            await act(async () => { root.unmount(); });
            container.remove();
        },
    };
    mountedSurfaces.push(surface);
    await surface.render(initial);
    return surface;
}

function requireElement<TElement extends HTMLElement = HTMLElement>(testId: string): TElement {
    const element = document.querySelector<TElement>(`[data-testid="${testId}"]`);
    if (!element) throw new Error(`Missing ${testId}`);
    return element;
}

function dispatchTab(options?: Readonly<{ shiftKey?: boolean }>): void {
    document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: options?.shiftKey === true,
        bubbles: true,
        cancelable: true,
    }));
}
