// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installCodeViewCommonModuleMocks } from './codeViewTestHelpers';
import { buildCodeLinesFromFile } from '../model/buildCodeLinesFromFile';

installCodeViewCommonModuleMocks({ reactNative: async () => import('react-native-web') });
const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

// The browser's touch/caret geometry is the boundary. Rows and RN-web Pressability stay real.
function pointer(type: string, target: Element) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 60, clientY: 10 });
    Object.defineProperty(event, 'pointerType', { value: 'touch' });
    target.dispatchEvent(event);
}
function touch(type: 'touchstart' | 'touchend' | 'touchcancel', target: Element) {
    const point: Touch = { identifier: 1, target, clientX: 60, clientY: 10, pageX: 60, pageY: 10,
        screenX: 60, screenY: 10, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1 };
    target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true,
        touches: type === 'touchstart' ? [point] : [], targetTouches: type === 'touchstart' ? [point] : [], changedTouches: [point] }));
}

describe('code-row browser touch lifecycle', () => {
    it('commits tap-to-name on the real row press, never before the compatibility click, and leaves gutter/blank taps selecting', async () => {
        const host = document.createElement('div'); document.body.appendChild(host);
        const root = createRoot(host);
        const activate = vi.fn(() => true), select = vi.fn();
        const lines = buildCodeLinesFromFile({ text: 'const target = 1;\n\n' });
        const previousCaret = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint');
        try {
            await act(async () => root.render(<CodeLinesViewCore lines={lines} virtualized={false} interactionMode="commitSelection"
                onPressLine={select} onPressLineRange={vi.fn()} intelligence={{ onPointerToken: vi.fn(), onActivateToken: activate }} />));
            const code = host.querySelector('[data-code-text]')!;
            Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => ({ offsetNode: code.firstChild, offset: 8 }) });
            await act(async () => { pointer('pointerdown', code); touch('touchstart', code); pointer('pointerup', code); });
            // Opening a sheet before click changes the browser's click target to its dismiss layer.
            expect(activate).not.toHaveBeenCalled();
            await act(async () => { touch('touchend', code); pointer('click', code); });
            expect(activate).toHaveBeenCalledWith(lines[0]!.id, 8, expect.objectContaining({ via: 'touch' }), 1);
            expect(select).not.toHaveBeenCalled();

            activate.mockClear();
            const gutter = code.parentElement!.previousElementSibling!;
            const blank = host.querySelectorAll('[data-code-text]')[1]!;
            for (const target of [gutter, blank]) await act(async () => {
                pointer('pointerdown', target); touch('touchstart', target); pointer('pointerup', target); touch('touchend', target); pointer('click', target);
            });
            expect(activate).not.toHaveBeenCalled();
            expect(select.mock.calls.map(([line]) => line.id)).toEqual([lines[0]!.id, lines[1]!.id]);
            select.mockClear();
            activate.mockReturnValue(false);
            await act(async () => { pointer('pointerdown', code); touch('touchstart', code); pointer('pointerup', code); touch('touchend', code); pointer('click', code); });
            expect(select).toHaveBeenCalledExactlyOnceWith(lines[0], expect.anything());
            select.mockClear(); activate.mockClear(); activate.mockReturnValue(true);
            await act(async () => {
                code.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
                code.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true, clientX: 60, clientY: 10 }));
            });
            expect(activate).toHaveBeenCalledExactlyOnceWith(lines[0]!.id, 8, expect.objectContaining({ via: 'modifier' }), 1);
            expect(select).not.toHaveBeenCalled();
        } finally {
            await act(async () => root.unmount()); host.remove();
            if (previousCaret) Object.defineProperty(document, 'caretPositionFromPoint', previousCaret);
            else Reflect.deleteProperty(document, 'caretPositionFromPoint');
        }
    });
    it('lets the existing long-press comment and release cancellation own the gesture instead of naming', async () => {
        vi.useFakeTimers();
        const host = document.createElement('div'); document.body.appendChild(host);
        const root = createRoot(host);
        const activate = vi.fn(), comment = vi.fn(), select = vi.fn();
        const lines = buildCodeLinesFromFile({ text: 'const target = 1;' });
        try {
            await act(async () => root.render(<CodeLinesViewCore lines={lines} virtualized={false} interactionMode="comment"
                onPressLine={select} onPressLineRange={vi.fn()} onPressAddComment={comment}
                intelligence={{ onPointerToken: vi.fn(), onActivateToken: activate }} />));
            const code = host.querySelector('[data-code-text]')!;
            await act(async () => { pointer('pointerdown', code); touch('touchstart', code); vi.advanceTimersByTime(700); });
            await act(async () => { pointer('pointerup', code); touch('touchend', code); pointer('click', code); });
            expect(comment).toHaveBeenCalledWith(lines[0]);
            expect(activate).not.toHaveBeenCalled();
            expect(select).not.toHaveBeenCalled();
            comment.mockClear();
            await act(async () => { pointer('pointerdown', code); touch('touchstart', code); pointer('pointercancel', code); touch('touchcancel', code); });
            expect(comment).not.toHaveBeenCalled();
            expect(activate).not.toHaveBeenCalled();
        } finally { await act(async () => root.unmount()); host.remove(); }
    });
});
