import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';

import { useTextInputCaretRect } from '../useTextInputCaretRect.web';
import type { CaretRect } from '../useTextInputCaretRect.types';

function createInput() {
    let rect: CaretRect | null = { left: 130, top: 220, height: 18 };
    const listeners = new Set<() => void>();
    const handle = {
        measureInWindow: vi.fn(),
        getReactNodeTag: () => null,
        getCaretRect: () => rect,
        subscribeCaretRect: (listener: () => void) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
    return {
        inputRef: { current: handle },
        setRect: (next: CaretRect | null) => { rect = next; },
        notify: () => { for (const listener of listeners) listener(); },
        listenerCount: () => listeners.size,
    };
}

describe('useTextInputCaretRect (web)', () => {
    beforeEach(() => { standardCleanup(); });

    it('uses viewport coordinates from the editor handle without a DOM element', async () => {
        const input = createInput();
        const hook = await renderHook(() => useTextInputCaretRect({ inputRef: input.inputRef }));

        expect(hook.getCurrent()).toEqual({ left: 130, top: 220, height: 18 });
    });

    it('remeasures when the selection changes', async () => {
        const input = createInput();
        const hook = await renderHook(
            (selection: { start: number; end: number }) => useTextInputCaretRect({ inputRef: input.inputRef, selection }),
            { initialProps: { start: 5, end: 5 } },
        );
        input.setRect({ left: 180, top: 220, height: 18 });
        await hook.rerender({ start: 10, end: 10 });

        expect(hook.getCurrent()?.left).toBe(180);
    });

    it('tracks editor scroll and layout notifications without a selection change', async () => {
        const input = createInput();
        const hook = await renderHook(() => useTextInputCaretRect({ inputRef: input.inputRef }));
        input.setRect({ left: 930, top: 205, height: 18 });
        await act(async () => { input.notify(); });

        expect(hook.getCurrent()).toEqual({ left: 930, top: 205, height: 18 });
    });

    it('keeps the rectangle identity when geometry is unchanged', async () => {
        const input = createInput();
        const hook = await renderHook(() => useTextInputCaretRect({ inputRef: input.inputRef }));
        const previous = hook.getCurrent();
        input.setRect({ left: 130, top: 220, height: 18 });
        await act(async () => { input.notify(); });

        expect(hook.getCurrent()).toBe(previous);
    });

    it('clears a previous rectangle when the editor can no longer measure it', async () => {
        const input = createInput();
        const hook = await renderHook(() => useTextInputCaretRect({ inputRef: input.inputRef }));
        input.setRect(null);
        await act(async () => { input.notify(); });

        expect(hook.getCurrent()).toBeNull();
    });

    it('releases tracking while disabled and remeasures when reenabled', async () => {
        const input = createInput();
        const hook = await renderHook(
            (enabled: boolean) => useTextInputCaretRect({ inputRef: input.inputRef, enabled }),
            { initialProps: true },
        );
        expect(input.listenerCount()).toBe(1);
        await hook.rerender(false);
        expect(input.listenerCount()).toBe(0);
        input.setRect({ left: 15, top: 25, height: 20 });
        await act(async () => { input.notify(); });
        expect(hook.getCurrent()).toBeNull();
        await hook.rerender(true);

        expect(hook.getCurrent()).toEqual({ left: 15, top: 25, height: 20 });
        expect(input.listenerCount()).toBe(1);
    });

    it('releases tracking on unmount', async () => {
        const input = createInput();
        const hook = await renderHook(() => useTextInputCaretRect({ inputRef: input.inputRef }));
        await hook.unmount();

        expect(input.listenerCount()).toBe(0);
    });

    it('returns null before the input is available', async () => {
        const hook = await renderHook(() => useTextInputCaretRect({ inputRef: { current: null } }));

        expect(hook.getCurrent()).toBeNull();
    });
});
