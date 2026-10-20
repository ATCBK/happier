import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { Session } from '@/sync/domains/state/storageTypes';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { getStorage, storage } from '@/sync/domains/state/storageStore';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';

import { useSession, useSessionInteractionSource } from './hooks';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SESSION_ID = 'interaction-source-session';
const ACCESS = createSessionAccessFixture('admin', { approveRuntimePermissions: true });

function seedSession(patch: Partial<Session>): void {
    storage.setState((state) => ({
        ...state,
        isDataReady: true,
        sessions: {
            ...state.sessions,
            [SESSION_ID]: createSessionFixture({ id: SESSION_ID, active: true, access: ACCESS, ...patch }),
        },
    }));
}

describe('useSessionInteractionSource subscription width', () => {
    let previousState: ReturnType<typeof storage.getState>;

    beforeEach(() => {
        previousState = storage.getState();
    });

    afterEach(() => {
        standardCleanup();
        storage.setState(previousState, true);
    });

    it('does not re-render while turn-lifecycle fields churn, where useSession does', async () => {
        seedSession({});

        let narrowRenders = 0;
        const narrow = await renderHook(() => {
            narrowRenders += 1;
            return useSessionInteractionSource(SESSION_ID);
        });

        // Control: the whole-record subscription these rows used to hold. It re-renders on
        // this churn, so a flat narrow count is evidence rather than an inert test.
        let wholeRecordRenders = 0;
        await renderHook(() => {
            wholeRecordRenders += 1;
            return useSession(SESSION_ID);
        });

        const before = narrow.getCurrent();
        const narrowBefore = narrowRenders;
        const wholeBefore = wholeRecordRenders;

        await act(async () => {
            seedSession({ thinking: true, agentState: {}, agentStateVersion: 1, updatedAt: 1, seq: 2 });
        });
        await act(async () => {
            seedSession({ thinking: true, agentState: {}, agentStateVersion: 2, updatedAt: 2, seq: 3, presence: 12 });
        });

        expect(wholeRecordRenders).toBe(wholeBefore + 2);
        expect(narrowRenders).toBe(narrowBefore);
        expect(narrow.getCurrent()).toBe(before);
    });

    it('re-renders and re-derives when an interaction right actually changes', async () => {
        seedSession({});

        const hook = await renderHook(() => useSessionInteractionSource(SESSION_ID));
        const before = hook.getCurrent();
        expect(deriveTranscriptInteractionFromSession(before!).canApprovePermissions).toBe(true);

        await act(async () => {
            seedSession({ access: createSessionAccessFixture('admin', { approveRuntimePermissions: false }) });
        });

        const after = hook.getCurrent();
        expect(after).not.toBe(before);
        expect(deriveTranscriptInteractionFromSession(after!).canApprovePermissions).toBe(false);
    });

    it('returns null when the session record is absent', async () => {
        const hook = await renderHook(() => useSessionInteractionSource(SESSION_ID));
        expect(hook.getCurrent()).toBeNull();
        expect(getStorage().getState().sessions[SESSION_ID]).toBeUndefined();
    });

    it('reads interaction rights from the requested Home when Session IDs collide', async () => {
        const activeHomeSession = createSessionFixture({
            id: SESSION_ID,
            active: true,
            access: ACCESS,
        });
        const requestedHomeSession = createSessionFixture({
            id: SESSION_ID,
            active: false,
            access: createSessionAccessFixture('view'),
        });
        storage.setState({
            isDataReady: true,
            sessions: { [SESSION_ID]: activeHomeSession },
            sessionListRowsByServerId: {
                'home-a': { [SESSION_ID]: activeHomeSession },
                'home-b': { [SESSION_ID]: requestedHomeSession },
            },
        });

        const hook = await renderHook(() => useSessionInteractionSource(SESSION_ID, 'home-b'));

        expect(hook.getCurrent()).toEqual({
            access: requestedHomeSession.access,
            active: false,
        });
    });
});
