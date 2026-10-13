import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { storage } from '@/sync/domains/state/storage';

import { renderHook } from '@/dev/testkit';
import { AppPaneProvider } from '../AppPaneProvider';
import { useAppPaneScope } from './useAppPaneScope';
import { createSessionBoardDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SCOPE_ID = 'session:identity-probe';
const initialStorageState = storage.getState();
beforeEach(() => storage.setState(initialStorageState, true));
afterEach(() => storage.setState(initialStorageState, true));

function PaneWrapper(props: React.PropsWithChildren) {
    return <AppPaneProvider>{props.children}</AppPaneProvider>;
}

describe('useAppPaneScope identity', () => {
    it('transfers the Board sidebar through the real pane provider and retains a different sidebar destination', async () => {
        const harness = await renderHook(() => useAppPaneScope(SCOPE_ID), { wrapper: PaneWrapper });
        const { act } = await import('react-test-renderer');
        try {
            await act(async () => harness.getCurrent().openRight({ tabId: 'board' }));
            await act(async () => harness.getCurrent().openDetailsTab(createSessionBoardDetailsTab(), { intent: 'pinned' }));
            expect(harness.getCurrent().scopeState?.details.tabs.some(tab => tab.kind === 'board')).toBe(true);
            expect(harness.getCurrent().scopeState?.right.isOpen).toBe(false);
            await act(async () => harness.getCurrent().openRight({ tabId: 'git' }));
            await act(async () => harness.getCurrent().openDetailsTab(createSessionBoardDetailsTab({ kind: 'item', itemId: 'item-1' }), { intent: 'pinned' }));
            expect(harness.getCurrent().scopeState?.right.isOpen).toBe(true);
        } finally { await harness.unmount(); }
    });

    it('returns the same api object when the host re-renders with no pane change', async () => {
        const harness = await renderHook(() => useAppPaneScope(SCOPE_ID), {
            wrapper: PaneWrapper,
        });

        const first = harness.getCurrent();
        const second = await harness.rerender();
        const third = await harness.rerender();

        // The api is handed to `useCallback` dependency lists across ~29 callsites
        // (openAttachedSessionTerminal, SessionHeaderTranscriptNavigationButton, ...).
        // A fresh literal per render invalidates every one of them and defeats
        // SessionHeaderActionMenu's `onSelectExtraItem` comparator.
        expect(second).toBe(first);
        expect(third).toBe(first);

        await harness.unmount();
    });

    it('mints a new api object when the scope state actually changes', async () => {
        const harness = await renderHook(() => useAppPaneScope(SCOPE_ID), {
            wrapper: PaneWrapper,
        });

        const before = harness.getCurrent();
        expect(before.scopeState?.right?.isOpen ?? false).toBe(false);

        await harness.rerender();
        expect(harness.getCurrent()).toBe(before);

        const { act } = await import('react-test-renderer');
        await act(async () => {
            before.openRight();
        });

        const after = harness.getCurrent();
        expect(after).not.toBe(before);
        expect(after.scopeState?.right?.isOpen).toBe(true);

        await harness.unmount();
    });
});
