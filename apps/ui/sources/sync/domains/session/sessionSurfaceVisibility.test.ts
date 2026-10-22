import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
    return {
        ...original,
        areServerProfileIdentifiersEquivalent: (leftRaw: string | null | undefined, rightRaw: string | null | undefined) => {
            const left = String(leftRaw ?? '').trim();
            const right = String(rightRaw ?? '').trim();
            if (!left || !right) return false;
            if (left === right) return true;
            return [left, right].sort().join('\u0000') === ['server-actual', 'server-alias'].sort().join('\u0000');
        },
        resolveServerProfileScopeIdForIdentifier: (serverIdRaw: string | null | undefined) => {
            const serverId = String(serverIdRaw ?? '').trim();
            return serverId === 'server-profile' ? 'server-actual' : serverId;
        },
    };
});

import {
    clearFocusedSessionId,
    clearRouteAnchorSessionId,
    getFocusedSessionAddress,
    getRouteAnchorSessionAddress,
    getSessionSurfaceVisibilitySnapshot,
    getVisibleSessionSurfaces,
    getVisibleSessionListSurfaces,
    isSessionListRowVisible,
    isSessionSurfaceVisible,
    markSessionSurfaceHidden,
    markSessionSurfaceVisible,
    resetSessionSurfaceVisibilityForTests,
    retainVisibleSessionListSurfaces,
    setFocusedSessionId,
    setRouteAnchorSessionId,
    subscribeSessionSurfaceVisibility,
} from './sessionSurfaceVisibility';

describe('sessionSurfaceVisibility', () => {
    beforeEach(() => {
        resetSessionSurfaceVisibilityForTests();
    });

    it('retains exact list-row demand across panes without consuming transcripts', () => {
        const releaseA = retainVisibleSessionListSurfaces([
            { serverId: 'home-a', sessionId: 'same' },
            { serverId: 'home-a', sessionId: 'same' },
        ]);
        const releaseB = retainVisibleSessionListSurfaces([
            { serverId: 'home-a', sessionId: 'same' },
            { serverId: 'home-b', sessionId: 'same' },
        ]);
        expect(getVisibleSessionListSurfaces()).toEqual([
            { serverId: 'home-a', sessionId: 'same' },
            { serverId: 'home-b', sessionId: 'same' },
        ]);
        expect(isSessionListRowVisible('same', 'home-a')).toBe(true);
        expect(isSessionListRowVisible('same', 'home-c')).toBe(false);
        expect(isSessionListRowVisible('same')).toBe(true);
        expect(isSessionSurfaceVisible('same', 'home-a')).toBe(false);
        expect(getVisibleSessionSurfaces()).toEqual([]);

        const both = getVisibleSessionListSurfaces();
        releaseA();
        releaseA();
        expect(getVisibleSessionListSurfaces()).toBe(both);
        releaseB();
        expect(getVisibleSessionListSurfaces()).toEqual([]);
        expect(isSessionListRowVisible('same', 'home-a')).toBe(false);
    });

    it('resets retained list demand without allowing an old pane release to remove new demand', () => {
        const releaseOld = retainVisibleSessionListSurfaces([{ serverId: 'server-profile', sessionId: 'same' }]);
        expect(isSessionListRowVisible('same', 'server-alias')).toBe(true);
        resetSessionSurfaceVisibilityForTests();
        expect(getVisibleSessionListSurfaces()).toEqual([]);
        const releaseNew = retainVisibleSessionListSurfaces([{ serverId: 'server-actual', sessionId: 'same' }]);
        releaseOld();
        expect(isSessionListRowVisible('same', 'server-actual')).toBe(true);
        releaseNew();
        expect(getVisibleSessionListSurfaces()).toEqual([]);
    });

    it('projects qualified, reference-counted surfaces without merging Homes', () => {
        markSessionSurfaceVisible('same', 'home-a');
        markSessionSurfaceVisible('same', 'home-b');
        markSessionSurfaceVisible('same', 'home-a');
        expect(getVisibleSessionSurfaces()).toEqual([
            { serverId: 'home-a', sessionId: 'same' },
            { serverId: 'home-b', sessionId: 'same' },
        ]);
        const first = getVisibleSessionSurfaces();
        setFocusedSessionId('same');
        expect(getVisibleSessionSurfaces()).toBe(first);
        markSessionSurfaceHidden('same', 'home-a');
        expect(getVisibleSessionSurfaces()).toBe(first);
        markSessionSurfaceHidden('same', 'home-a');
        expect(getVisibleSessionSurfaces()).toEqual([{ serverId: 'home-b', sessionId: 'same' }]);
    });

    it('publishes visible membership changes without publishing duplicate retain or release counts', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeSessionSurfaceVisibility(listener);
        try {
            markSessionSurfaceVisible('same', 'home-a');
            const first = getSessionSurfaceVisibilitySnapshot();
            const surfaces = getVisibleSessionSurfaces();
            markSessionSurfaceVisible('same', 'home-a');
            markSessionSurfaceHidden('same', 'home-a');
            expect(getSessionSurfaceVisibilitySnapshot()).toBe(first);
            expect(getVisibleSessionSurfaces()).toBe(surfaces);
            expect(listener).toHaveBeenCalledOnce();

            markSessionSurfaceVisible('same', 'home-b');
            expect(getSessionSurfaceVisibilitySnapshot().visibleSessionIds).toBe(first.visibleSessionIds);
            expect(getVisibleSessionSurfaces()).toHaveLength(2);
            expect(listener).toHaveBeenCalledTimes(2);
            markSessionSurfaceHidden('same', 'home-a');
            expect(isSessionSurfaceVisible('same', 'home-b')).toBe(true);
            expect(listener).toHaveBeenCalledTimes(3);
            markSessionSurfaceHidden('same', 'home-b');
            expect(getSessionSurfaceVisibilitySnapshot().visibleSessionIds).toEqual([]);
            expect(listener).toHaveBeenCalledTimes(4);
            const empty = getSessionSurfaceVisibilitySnapshot();
            markSessionSurfaceHidden('same', 'home-b');
            expect(getSessionSurfaceVisibilitySnapshot()).toBe(empty);
            expect(listener).toHaveBeenCalledTimes(4);
        } finally { unsubscribe(); }
    });

    it('retains repeated focus and route identities while notifying a same-id Home change', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeSessionSurfaceVisibility(listener);
        try {
            setFocusedSessionId('same', 'home-a');
            setRouteAnchorSessionId('same', 'home-a');
            const snapshot = getSessionSurfaceVisibilitySnapshot();
            const focused = getFocusedSessionAddress();
            const anchor = getRouteAnchorSessionAddress();
            setFocusedSessionId(' same ', 'home-a');
            setRouteAnchorSessionId('same', ' home-a ');
            expect(getSessionSurfaceVisibilitySnapshot()).toBe(snapshot);
            expect(getFocusedSessionAddress()).toBe(focused);
            expect(getRouteAnchorSessionAddress()).toBe(anchor);
            expect(listener).toHaveBeenCalledTimes(2);
            setFocusedSessionId('same', 'home-b');
            expect(getSessionSurfaceVisibilitySnapshot()).not.toBe(snapshot);
            expect(getSessionSurfaceVisibilitySnapshot().visibleSessionIds).toBe(snapshot.visibleSessionIds);
            expect(getFocusedSessionAddress()).toEqual({ serverId: 'home-b', sessionId: 'same' });
            const afterFocus = getSessionSurfaceVisibilitySnapshot();
            setRouteAnchorSessionId('same', 'home-b');
            expect(getSessionSurfaceVisibilitySnapshot()).not.toBe(afterFocus);
            expect(getRouteAnchorSessionAddress()).toEqual({ serverId: 'home-b', sessionId: 'same' });
            expect(listener).toHaveBeenCalledTimes(4);
        } finally { unsubscribe(); }
    });

    it('tracks visible, focused, and route-anchor session ids independently', () => {
        markSessionSurfaceVisible('session-1');
        markSessionSurfaceVisible('session-2');
        setFocusedSessionId('session-2');
        setRouteAnchorSessionId('session-1');

        expect(getSessionSurfaceVisibilitySnapshot()).toEqual({
            focusedSessionId: 'session-2',
            routeAnchorSessionId: 'session-1',
            visibleSessionIds: ['session-1', 'session-2'],
        });
    });

    it('retains the exact focused Home when duplicate session ids are visible', () => {
        markSessionSurfaceVisible('same-session', 'home-a');
        markSessionSurfaceVisible('same-session', 'home-b');

        setFocusedSessionId('same-session', 'home-b');

        expect(getFocusedSessionAddress()).toEqual({
            serverId: 'home-b',
            sessionId: 'same-session',
        });
        clearFocusedSessionId('same-session', 'home-a');
        expect(getFocusedSessionAddress()).toEqual({
            serverId: 'home-b',
            sessionId: 'same-session',
        });
        clearFocusedSessionId('same-session', 'home-b');
        expect(getFocusedSessionAddress()).toBeNull();
    });

    it('uses reference counting for visible sessions and only clears matching focus state', () => {
        markSessionSurfaceVisible('session-1');
        markSessionSurfaceVisible('session-1');
        setFocusedSessionId('session-1');
        setRouteAnchorSessionId('session-1');

        markSessionSurfaceHidden('session-1');
        clearFocusedSessionId('session-2');
        clearRouteAnchorSessionId('session-2');

        expect(getSessionSurfaceVisibilitySnapshot()).toEqual({
            focusedSessionId: 'session-1',
            routeAnchorSessionId: 'session-1',
            visibleSessionIds: ['session-1'],
        });

        markSessionSurfaceHidden('session-1');

        expect(getSessionSurfaceVisibilitySnapshot()).toEqual({
            focusedSessionId: 'session-1',
            routeAnchorSessionId: 'session-1',
            visibleSessionIds: [],
        });

        clearFocusedSessionId('session-1');
        clearRouteAnchorSessionId('session-1');

        expect(getSessionSurfaceVisibilitySnapshot()).toEqual({
            focusedSessionId: null,
            routeAnchorSessionId: null,
            visibleSessionIds: [],
        });
    });

    it('falls back to unscoped visibility only before a session has scoped visibility', () => {
        markSessionSurfaceVisible('session-1');

        expect(isSessionSurfaceVisible('session-1', 'server-a')).toBe(true);

        markSessionSurfaceVisible('session-2', 'server-a');

        expect(isSessionSurfaceVisible('session-2', 'server-a')).toBe(true);
        expect(isSessionSurfaceVisible('session-2', 'server-b')).toBe(false);
    });

    it('canonicalizes profile ids to learned server identity ids for scoped visibility', () => {
        markSessionSurfaceVisible('session-1', 'server-actual');

        expect(isSessionSurfaceVisible('session-1', 'server-profile')).toBe(true);
        expect(isSessionSurfaceVisible('session-1', 'server-unrelated')).toBe(false);
    });

    it('clears stale visibility state when the app route leaves session screens', async () => {
        const { clearSessionSurfaceVisibilityForNonSessionRoute } = await import('./sessionSurfaceVisibility');

        markSessionSurfaceVisible('session-1', 'server-actual');
        setFocusedSessionId('session-1');
        setRouteAnchorSessionId('session-1');

        expect(clearSessionSurfaceVisibilityForNonSessionRoute('/session/session-1')).toBe(false);
        expect(getSessionSurfaceVisibilitySnapshot()).toEqual({
            focusedSessionId: 'session-1',
            routeAnchorSessionId: 'session-1',
            visibleSessionIds: ['session-1'],
        });

        expect(clearSessionSurfaceVisibilityForNonSessionRoute('/settings')).toBe(true);
        expect(getSessionSurfaceVisibilitySnapshot()).toEqual({
            focusedSessionId: null,
            routeAnchorSessionId: null,
            visibleSessionIds: [],
        });
        expect(isSessionSurfaceVisible('session-1', 'server-actual')).toBe(false);
    });

    it('preserves mounted session visibility on the chrome-less embed route', async () => {
        const { clearSessionSurfaceVisibilityForNonSessionRoute } = await import('./sessionSurfaceVisibility');
        markSessionSurfaceVisible('session-1', 'server-actual');
        setFocusedSessionId('session-1');
        setRouteAnchorSessionId('session-1');

        expect(clearSessionSurfaceVisibilityForNonSessionRoute('/embed/session/session-1')).toBe(false);
        expect(getSessionSurfaceVisibilitySnapshot().visibleSessionIds).toEqual(['session-1']);
        expect(clearSessionSurfaceVisibilityForNonSessionRoute('/embed/new')).toBe(true);
    });

    it('keeps visibility state available across module re-evaluation', async () => {
        markSessionSurfaceVisible('session-1', 'server-actual');

        vi.resetModules();
        const reloaded = await import('./sessionSurfaceVisibility');

        expect(reloaded.isSessionSurfaceVisible('session-1', 'server-actual')).toBe(true);
        reloaded.markSessionSurfaceHidden('session-1', 'server-actual');
    });
});
