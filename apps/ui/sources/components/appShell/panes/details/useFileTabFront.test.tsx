import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { AppPaneProvider, useAppPaneContext } from '../AppPaneProvider';
import { useAppPaneScope, type AppPaneScopeApi } from '../hooks/useAppPaneScope';

const initialState = storage.getState();
beforeEach(() => storage.setState(initialState, true));
afterEach(() => storage.setState(initialState, true));

describe('file tab front subscription', () => {
    it('only renders chips whose selected answer changes, including closing Details', async () => {
        const renders = new Map<string, number>();
        const selected = new Map<string, boolean>();
        let pane: AppPaneScopeApi | undefined;
        function Controls() {
            pane = useAppPaneScope('session:continuity');
            return null;
        }
        const Chip = React.memo(function Chip({ path }: { path: string }) {
            const state = useAppPaneContext().state.scopes['session:continuity']?.details;
            const front = state?.isOpen === true && state.focusedGroupId !== null && state.groupsById[state.focusedGroupId]?.activeTabKey === `file:${path}`;
            renders.set(path, (renders.get(path) ?? 0) + 1);
            selected.set(path, front);
            return null;
        });
        const screen = await renderScreen(<AppPaneProvider><Controls /><Chip path="a.ts" /><Chip path="b.ts" /><Chip path="c.ts" /></AppPaneProvider>);
        const open = (path: string) => pane!.openDetailsTab({ key: `file:${path}`, title: path, kind: 'file', resource: { kind: 'file', path } }, { intent: 'pinned' });
        await act(async () => open('a.ts'));
        const before = new Map(renders);
        await act(async () => open('b.ts'));
        expect(selected.get('a.ts')).toBe(false);
        expect(selected.get('b.ts')).toBe(true);
        expect(renders.get('a.ts')).toBe(before.get('a.ts')! + 1);
        expect(renders.get('b.ts')).toBe(before.get('b.ts')! + 1);
        expect(renders.get('c.ts')).toBe(before.get('c.ts'));
        const beforeUnrelated = new Map(renders);
        await act(async () => pane!.openRight({ tabId: 'git' }));
        expect(renders).toEqual(beforeUnrelated);
        await act(async () => pane!.closeDetails());
        expect(selected.get('b.ts')).toBe(false);
        await screen.unmount();
    });
});
