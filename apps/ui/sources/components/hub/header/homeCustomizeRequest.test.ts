import { describe, expect, it, vi } from 'vitest';

import { requestHomeCustomize, subscribeHomeCustomizeRequest } from './homeCustomizeRequest';

describe('asking Home to open Customize from elsewhere', () => {
    it('opens Customize on the Home that is mounted, once', () => {
        const open = vi.fn();
        const unsubscribe = subscribeHomeCustomizeRequest(open);

        requestHomeCustomize();
        expect(open).toHaveBeenCalledTimes(1);

        unsubscribe();
        const later = vi.fn();
        subscribeHomeCustomizeRequest(later)();
        expect(later).not.toHaveBeenCalled();
    });

    it('keeps a request made before Home mounts for the Home that opens next', () => {
        requestHomeCustomize();
        const open = vi.fn();
        const unsubscribe = subscribeHomeCustomizeRequest(open);
        expect(open).toHaveBeenCalledTimes(1);
        unsubscribe();

        const next = vi.fn();
        subscribeHomeCustomizeRequest(next)();
        expect(next).not.toHaveBeenCalled();
    });
});
