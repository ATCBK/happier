import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { storage } from '@/sync/domains/state/storage';

import { renderHook, renderScreen } from '@/dev/testkit';
import { AppPaneProvider, useAppPaneContext } from '../AppPaneProvider';
import { useAppPaneScope, type AppPaneScopeApi } from './useAppPaneScope';
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
    it('observes registration and withdrawal of its own driver while retaining a null selection for unrelated drivers', async () => {
        const harness = await renderHook(() => useAppPaneContext(value => ({
            driver: value.getDriver(SCOPE_ID), registerDriver: value.registerDriver,
        })), { wrapper: PaneWrapper });
        const { act } = await import('react-test-renderer');
        let retireOther: (() => void) | undefined;
        let retireOwn: (() => void) | undefined;
        try {
            const initial = harness.getCurrent();
            expect(initial.driver).toBeNull();
            await act(async () => { retireOther = initial.registerDriver({ scopeId: 'session:other' }); });
            expect(harness.getCurrent()).toBe(initial);
            const own = { scopeId: SCOPE_ID };
            await act(async () => { retireOwn = initial.registerDriver(own); });
            expect(harness.getCurrent().driver).toBe(own);
            await act(async () => { retireOwn?.(); });
            expect(harness.getCurrent().driver).toBeNull();
        } finally {
            await act(async () => { retireOther?.(); retireOwn?.(); });
            await harness.unmount();
        }
    });

    it('keeps retained scopes idle when a file opens or updates in another scope', async () => {
        const panes = new Map<string, AppPaneScopeApi>();
        const renders = new Map<string, number>();
        function Probe({ id }: { id: string }) {
            panes.set(id, useAppPaneScope(id));
            renders.set(id, (renders.get(id) ?? 0) + 1);
            return null;
        }
        const screen = await renderScreen(<AppPaneProvider>
            <Probe id="session:reading" /><Probe id="session:retained" />
        </AppPaneProvider>);
        const { act } = await import('react-test-renderer');
        try {
            await act(async () => panes.get('session:retained')!.openRight({ tabId: 'git' }));
            const retained = panes.get('session:retained');
            const before = renders.get('session:retained');
            await act(async () => panes.get('session:reading')!.openDetailsTab({
                key: 'file:README.md', kind: 'file', title: 'README.md',
                resource: { kind: 'file', path: 'README.md' },
            }));
            await act(async () => panes.get('session:reading')!.patchDetailsTabState('file:README.md', { scrollTop: 120 }));
            expect(panes.get('session:reading')!.scopeState?.details.activeTabKey).toBe('file:README.md');
            expect(panes.get('session:reading')!.scopeState?.details.tabState['file:README.md']).toMatchObject({ scrollTop: 120 });
            expect(renders.get('session:retained')! - before!).toBe(0);
            expect(panes.get('session:retained')).toBe(retained);
        } finally { await screen.unmount(); }
    });

    it('retains a populated scope api across a host render with unchanged pane inputs', async () => {
        const harness = await renderHook(() => useAppPaneScope(SCOPE_ID), { wrapper: PaneWrapper });
        const { act } = await import('react-test-renderer');
        try {
            await act(async () => harness.getCurrent().openRight({ tabId: 'git' }));
            const populated = harness.getCurrent();
            await harness.rerender();
            expect(harness.getCurrent()).toBe(populated);
        } finally { await harness.unmount(); }
    });

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
