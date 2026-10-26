/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installSessionShellCommonModuleMocks } from '../sessionShellTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'span', Octicons: 'span' }));
vi.mock('expo-image', () => ({ Image: 'img' }));

installSessionShellCommonModuleMocks({
    reactNative: async () => await vi.importActual('react-native-web'),
    storage: async () => ({
        useLocalSettingMutable: () => [undefined, vi.fn()] as const,
    }),
});

const { SessionPaneHeader } = await import('./SessionPaneHeader');

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const byTestId = (testID: string) => container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
const input = () => byTestId('session-header-title-input') as HTMLInputElement | null;
const trigger = () => byTestId('session-header-title');

async function beginEditing() {
    const title = trigger();
    if (!title) throw new Error('missing title trigger');
    await act(async () => { title.focus(); title.click(); });
    await vi.waitFor(() => expect(input()).not.toBeNull());
}

describe('SessionPaneHeader inline title (DOM keyboard)', () => {
    beforeEach(async () => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => {
            root.render(<SessionPaneHeader title="Fix settings modal remount" rename={{ sessionId: 'session-a', serverId: null }} />);
        });
    });

    afterEach(async () => {
        await act(async () => { root.unmount(); });
        container.remove();
    });

    it('returns keyboard focus to the title after Escape, Cancel and an unchanged save', async () => {
        await beginEditing();
        await act(async () => {
            input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
        await vi.waitFor(() => expect(input()).toBeNull());
        expect(document.activeElement).toBe(trigger());

        await beginEditing();
        const cancel = byTestId('session-header-title-cancel');
        if (!cancel) throw new Error('missing cancel');
        await act(async () => { cancel.focus(); cancel.click(); });
        await vi.waitFor(() => expect(input()).toBeNull());
        expect(document.activeElement).toBe(trigger());

        await beginEditing();
        await act(async () => {
            input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        });
        await vi.waitFor(() => expect(input()).toBeNull());
        expect(document.activeElement).toBe(trigger());
    });
});
