import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';
import {
    resetSessionDraftRepositoryForTests,
    writeExistingSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import { useSessionListRowExistingDraft } from './useSessionListRowExistingDraft';

const activeScope = { serverId: 'server-row-drafts', accountId: 'account-row-drafts' };
type RowProps = Readonly<{ dataActive: boolean; serverId?: string }>;

function type(text: string): void {
    writeExistingSessionDraft({ scope: activeScope, sessionId: 'session-row', patch: { text }, materializationIntent: 'userEdit' });
}

describe('useSessionListRowExistingDraft', () => {
    afterEach(() => {
        resetSessionDraftRepositoryForTests();
    });

    it('follows the row draft live, drops it when unlisted, and freezes while the surface is inactive', async () => {
        const hook = await renderHook<ReturnType<typeof useSessionListRowExistingDraft>, RowProps>((props) => useSessionListRowExistingDraft({
            activeScope,
            serverId: props.serverId ?? activeScope.serverId,
            sessionId: 'session-row',
            dataActive: props.dataActive,
        }), { initialProps: { dataActive: true } });

        expect(hook.getCurrent()).toBeNull();
        await act(async () => { type('hello'); });
        expect(hook.getCurrent()?.preview).toBe('hello');
        await act(async () => { type('hello there'); });
        expect(hook.getCurrent()?.preview).toBe('hello there');

        await hook.rerender({ dataActive: false });
        await act(async () => { type('typed behind a pushed screen'); });
        expect(hook.getCurrent()?.preview).toBe('hello there');
        await hook.rerender({ dataActive: true });
        expect(hook.getCurrent()?.preview).toBe('typed behind a pushed screen');

        await act(async () => { type(''); });
        expect(hook.getCurrent()).toBeNull();

        await act(async () => { type('another Home'); });
        await hook.rerender({ dataActive: true, serverId: 'server-elsewhere' });
        expect(hook.getCurrent()).toBeNull();
        await hook.unmount();
    });

    it('reads the current draft once for a row whose first render is inactive', async () => {
        type('drafted before the row mounted');
        const hook = await renderHook(() => useSessionListRowExistingDraft({
            activeScope,
            serverId: activeScope.serverId,
            sessionId: 'session-row',
            dataActive: false,
        }), { initialProps: {} });

        expect(hook.getCurrent()?.preview).toBe('drafted before the row mounted');
        await hook.unmount();
    });
});
