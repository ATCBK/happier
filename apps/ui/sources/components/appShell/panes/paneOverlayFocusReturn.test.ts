import { describe, expect, it, vi } from 'vitest';
import { createPaneOverlayFocusReturnOwner } from './paneOverlayFocusReturn';

describe('file tab focus origins', () => {
    it('keeps each tab independent and consumes only the returned tab once', () => {
        const owner = createPaneOverlayFocusReturnOwner();
        const first = { focus: vi.fn(), isConnected: true };
        const second = { focus: vi.fn(), isConnected: true };
        owner.recordDetailsTabOrigin('session:a', 'file:a.ts', { focusReturnRef: { current: first } }, 'pane');
        owner.recordDetailsTabOrigin('session:a', 'file:b.ts', { focusReturnRef: { current: second } }, 'pane');
        owner.takeDetailsTabReturn('session:a', 'file:a.ts', 'pane')?.();
        expect(first.focus).toHaveBeenCalledOnce();
        expect(second.focus).not.toHaveBeenCalled();
        expect(owner.takeDetailsTabReturn('session:a', 'file:a.ts', 'pane')).toBeNull();
        owner.takeDetailsTabReturn('session:a', 'file:b.ts', 'pane')?.();
        expect(second.focus).toHaveBeenCalledOnce();
    });

    it('keeps phone returns separate from pane closes and clears transient origins on reset', () => {
        const owner = createPaneOverlayFocusReturnOwner();
        const returned = vi.fn();
        owner.recordDetailsTabOrigin('session:a', 'file:a.ts', { onReturn: returned }, 'route');
        expect(owner.takeDetailsTabReturn('session:a', 'file:a.ts', 'pane')).toBeNull();
        expect(owner.takeDetailsTabReturn('session:b', null, 'route')).toBeNull();
        owner.takeDetailsTabReturn('session:a', null, 'route')?.();
        expect(returned).toHaveBeenCalledExactlyOnceWith('route');
        expect(owner.takeDetailsTabReturn('session:a', null, 'route')).toBeNull();
        owner.recordDetailsTabOrigin('session:a', 'file:a.ts', { onReturn: returned }, 'route');
        owner.clearAll();
        expect(owner.takeDetailsTabReturn('session:a', null, 'route')).toBeNull();
    });
});
