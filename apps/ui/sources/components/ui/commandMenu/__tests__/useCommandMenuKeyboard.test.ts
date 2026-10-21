import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';

import { useCommandMenuKeyboard } from '../useCommandMenuKeyboard';

function makeCallbacks() {
    return {
        onMoveUp: vi.fn(),
        onMoveDown: vi.fn(),
        onSelect: vi.fn(),
        onClose: vi.fn(),
    };
}

function key(k: string, shiftKey = false): { key: string; shiftKey: boolean } {
    return { key: k, shiftKey };
}

describe('useCommandMenuKeyboard', () => {
    describe('when open is true', () => {
        it('ArrowDown calls onMoveDown and returns true', async () => {
            const cbs = makeCallbacks();
            const { getCurrent } = await renderHook(() => useCommandMenuKeyboard({ open: true, ...cbs }));
            expect(getCurrent().handleKey(key('ArrowDown'))).toBe(true);
            expect(cbs.onMoveDown).toHaveBeenCalledOnce();
        });

        it('ArrowUp calls onMoveUp and returns true', async () => {
            const cbs = makeCallbacks();
            const { getCurrent } = await renderHook(() => useCommandMenuKeyboard({ open: true, ...cbs }));
            expect(getCurrent().handleKey(key('ArrowUp'))).toBe(true);
            expect(cbs.onMoveUp).toHaveBeenCalledOnce();
        });

        it('Enter calls onSelect and returns true', async () => {
            const cbs = makeCallbacks();
            const { getCurrent } = await renderHook(() => useCommandMenuKeyboard({ open: true, ...cbs }));
            expect(getCurrent().handleKey(key('Enter'))).toBe(true);
            expect(cbs.onSelect).toHaveBeenCalledOnce();
        });

        it('Tab (no shift) calls onSelect and returns true', async () => {
            const cbs = makeCallbacks();
            const { getCurrent } = await renderHook(() => useCommandMenuKeyboard({ open: true, ...cbs }));
            expect(getCurrent().handleKey(key('Tab', false))).toBe(true);
            expect(cbs.onSelect).toHaveBeenCalledOnce();
        });

        it('Tab (with shift) returns false and does NOT call onSelect', async () => {
            const cbs = makeCallbacks();
            const { getCurrent } = await renderHook(() => useCommandMenuKeyboard({ open: true, ...cbs }));
            expect(getCurrent().handleKey(key('Tab', true))).toBe(false);
            expect(cbs.onSelect).not.toHaveBeenCalled();
        });

        it('Escape calls onClose and returns true', async () => {
            const cbs = makeCallbacks();
            const { getCurrent } = await renderHook(() => useCommandMenuKeyboard({ open: true, ...cbs }));
            expect(getCurrent().handleKey(key('Escape'))).toBe(true);
            expect(cbs.onClose).toHaveBeenCalledOnce();
        });

        it.each(['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'])(
            'does not consume %s or invoke menu actions while an IME composition is active',
            async (pressedKey) => {
                const cbs = makeCallbacks();
                const { getCurrent } = await renderHook(() => useCommandMenuKeyboard({ open: true, ...cbs }));

                expect(getCurrent().handleKey({ key: pressedKey, shiftKey: false, isComposing: true })).toBe(false);
                expect(cbs.onMoveDown).not.toHaveBeenCalled();
                expect(cbs.onMoveUp).not.toHaveBeenCalled();
                expect(cbs.onSelect).not.toHaveBeenCalled();
                expect(cbs.onClose).not.toHaveBeenCalled();
            },
        );

        it('Home returns false (parity; no new shortcuts)', async () => {
            const cbs = makeCallbacks();
            const { getCurrent } = await renderHook(() => useCommandMenuKeyboard({ open: true, ...cbs }));
            expect(getCurrent().handleKey(key('Home'))).toBe(false);
        });

        it('End returns false (parity; no new shortcuts)', async () => {
            const cbs = makeCallbacks();
            const { getCurrent } = await renderHook(() => useCommandMenuKeyboard({ open: true, ...cbs }));
            expect(getCurrent().handleKey(key('End'))).toBe(false);
        });

        it('any other key returns false', async () => {
            const cbs = makeCallbacks();
            const { getCurrent } = await renderHook(() => useCommandMenuKeyboard({ open: true, ...cbs }));
            expect(getCurrent().handleKey(key('a'))).toBe(false);
            expect(getCurrent().handleKey(key('Space'))).toBe(false);
            expect(getCurrent().handleKey(key('Backspace'))).toBe(false);
        });
    });

    describe('when open is false', () => {
        it('all keys return false and no callbacks are called', async () => {
            const cbs = makeCallbacks();
            const { getCurrent } = await renderHook(() => useCommandMenuKeyboard({ open: false, ...cbs }));
            expect(getCurrent().handleKey(key('ArrowDown'))).toBe(false);
            expect(getCurrent().handleKey(key('ArrowUp'))).toBe(false);
            expect(getCurrent().handleKey(key('Enter'))).toBe(false);
            expect(getCurrent().handleKey(key('Tab'))).toBe(false);
            expect(getCurrent().handleKey(key('Escape'))).toBe(false);
            expect(cbs.onMoveDown).not.toHaveBeenCalled();
            expect(cbs.onMoveUp).not.toHaveBeenCalled();
            expect(cbs.onSelect).not.toHaveBeenCalled();
            expect(cbs.onClose).not.toHaveBeenCalled();
        });
    });

    describe('a menu with tabs or with no rows', () => {
        it('Tab cycles the tabs instead of choosing a row', async () => {
            const cbs = makeCallbacks();
            const onTab = vi.fn();
            const { getCurrent } = await renderHook(() => useCommandMenuKeyboard({ open: true, ...cbs, onTab }));
            expect(getCurrent().handleKey(key('Tab'))).toBe(true);
            expect(onTab).toHaveBeenCalledOnce();
            expect(cbs.onSelect).not.toHaveBeenCalled();
        });

        it('a menu showing only its empty state leaves Enter and the arrows to the composer', async () => {
            const cbs = makeCallbacks();
            const { getCurrent } = await renderHook(() => useCommandMenuKeyboard({ open: true, ...cbs, selectable: false }));
            expect(getCurrent().handleKey(key('Enter'))).toBe(false);
            expect(getCurrent().handleKey(key('ArrowDown'))).toBe(false);
            expect(getCurrent().handleKey(key('Escape'))).toBe(true);
            expect(cbs.onSelect).not.toHaveBeenCalled();
            expect(cbs.onClose).toHaveBeenCalledOnce();
        });
    });
});

