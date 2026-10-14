/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { installModalComponentCommonModuleMocks } from './components/modalComponentTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installModalComponentCommonModuleMocks({ reactNative: async () => {
    const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
    const { createRequire } = getVitestNodeBuiltin<Pick<typeof import('node:module'), 'createRequire'>>('node:module');
    // The package-name RNW request has a Node shim; its absolute entry is the real DOM boundary.
    return await vi.importActual(createRequire(import.meta.url).resolve('react-native-web'));
}, text: async () => await vi.importActual('@/text') });
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsRealModule } = await import('@/dev/testkit/mocks/radixCjs');
    return await createRadixCjsRealModule();
});
vi.mock('react-native-keyboard-controller', async () => {
    const { View } = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return { KeyboardAvoidingView: View };
});

// Resolve the real component graph during collection, outside behavior-test deadlines.
const { ModalProvider } = await import('./ModalProvider');
const { Modal } = await import('./ModalManager');
const { motionTokens } = await import('@/components/ui/motion/motionTokens');

/** The page scrim: the fixed layer under the dialog, one z-step below it. */
function scrims(): HTMLElement[] {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) return [];
    const dialogZ = Number(window.getComputedStyle(dialog).zIndex);
    return Array.from(document.querySelectorAll<HTMLElement>('div')).filter(element => element !== dialog
        && window.getComputedStyle(element).position === 'fixed'
        && Number(window.getComputedStyle(element).zIndex) === dialogZ - 1);
}

it('keeps the page scrim while a closing modal leaves, so the scrim fades with it instead of dropping at once', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    function Sheet() {
        return <button data-testid="sheet-action">Hold</button>;
    }
    try {
        await act(async () => root.render(<ModalProvider><span /></ModalProvider>));
        let id = '';
        await act(async () => { id = Modal.show({ component: Sheet }); });
        expect(scrims()).toHaveLength(1);
        const scrim = scrims()[0]!;
        await act(async () => Modal.hide(id));
        // Still leaving: the same scrim stays mounted and turns transparent over the exit.
        expect(document.querySelector('[data-testid="sheet-action"]')).not.toBeNull();
        expect(scrims()).toEqual([scrim]);
        expect(window.getComputedStyle(scrim).backgroundColor).toMatch(/transparent|rgba\(0, 0, 0, 0\)/);
        await act(async () => { vi.advanceTimersByTime(motionTokens.overlay.modal.exitMs); });
        expect(document.querySelector('[data-testid="sheet-action"]')).toBeNull();
        expect(scrim.isConnected).toBe(false);
    } finally {
        await act(async () => root.unmount());
        vi.useRealTimers();
        container.remove();
    }
});

it('lets a confirm dialog leave through the same exit while its answer resolves at the choice', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => root.render(<ModalProvider><span /></ModalProvider>));
        let answer: boolean | null = null;
        await act(async () => {
            void Modal.confirm('Delete the draft?', 'This cannot be undone.', { confirmText: 'Delete' }).then((value) => { answer = value; });
        });
        const confirmButton = () => document.querySelector<HTMLElement>('[data-testid="web-modal-confirm"]');
        expect(confirmButton()).not.toBeNull();
        expect(scrims()).toHaveLength(1);
        const scrim = scrims()[0]!;

        await act(async () => { confirmButton()!.click(); });
        // The answer is the user's choice, settled at the click, not at the end of the exit.
        expect(answer).toBe(true);
        // The dialog is still on screen, leaving: inert, with its scrim fading rather than gone.
        expect(confirmButton()).not.toBeNull();
        expect(window.getComputedStyle(document.querySelector<HTMLElement>('[role="dialog"]')!).pointerEvents).toBe('none');
        expect(scrims()).toEqual([scrim]);
        expect(window.getComputedStyle(scrim).backgroundColor).toMatch(/transparent|rgba\(0, 0, 0, 0\)/);

        await act(async () => { vi.advanceTimersByTime(motionTokens.overlay.modal.exitMs); });
        expect(confirmButton()).toBeNull();
        expect(scrim.isConnected).toBe(false);
    } finally {
        await act(async () => root.unmount());
        vi.useRealTimers();
        container.remove();
    }
});

it('lets an alert leave through the same exit instead of vanishing', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => root.render(<ModalProvider><span /></ModalProvider>));
        await act(async () => { void Modal.alertAsync('Saved', 'Your changes are in.'); });
        const okButton = () => document.querySelector<HTMLElement>('[data-testid="web-modal-button-0"]');
        expect(okButton()).not.toBeNull();
        await act(async () => { okButton()!.click(); });
        expect(okButton()).not.toBeNull();
        await act(async () => { vi.advanceTimersByTime(motionTokens.overlay.modal.exitMs); });
        expect(okButton()).toBeNull();
    } finally {
        await act(async () => root.unmount());
        vi.useRealTimers();
        container.remove();
    }
});
