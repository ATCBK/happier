import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppState, Platform } from 'react-native';
import { SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT, SessionHumanPresenceVisibleReplaceV1Schema, SessionHumanPresenceTypingSetV1Schema } from '@happier-dev/protocol/sessions';
import { attachManagedSessionHumanPresenceSocket } from './attachManagedSessionHumanPresenceSocket';
// Loaded eagerly so a runtime module-graph failure fails this test loudly instead of
// being swallowed by the adapter's deliberate additive-presence catch.
import './sessionHumanPresenceRuntime';
import { sessionHumanPresenceStore } from './sessionHumanPresenceStore';
import { markSessionSurfaceHidden, markSessionSurfaceVisible } from '../sessionSurfaceVisibility';
import { registerDiscussionHumanPresence, reportDiscussionTypingEdit } from './sessionHumanPresenceRuntime';
import { storage } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

/** Real JWT-shaped authenticated subject; the adapter must read the Account from it. */
function token(accountId: string): string {
    return `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64')}.signature`;
}

function managedSocket() {
    const handlers = new Map<string, (payload: unknown) => void>();
    const emitted: Array<[string, unknown]> = [];
    const connectedListeners = new Set<() => void>();
    const emitWithAck = async (event: string, payload: unknown) => {
        emitted.push([event, payload]);
        const declaration = SessionHumanPresenceVisibleReplaceV1Schema.parse(payload);
        return { v: 1, ok: true, admittedSessionIds: declaration.sessionIds,
            ...(declaration.locations ? { admittedLocations: declaration.locations } : {}) };
    };
    const socket = {
        connected: true,
        emit: (event: string, payload: unknown) => { emitted.push([event, payload]); },
        on: (event: string, handler: (payload: unknown) => void) => { handlers.set(event, handler); },
        off: (event: string) => { handlers.delete(event); },
        emitWithAck,
        timeout: () => ({ emitWithAck }),
    };
    const transport = {
        isConnected: () => socket.connected,
        onConnected: (listener: () => void) => { connectedListeners.add(listener); return () => connectedListeners.delete(listener); },
        onDisconnected: (listener: () => void) => { connectedListeners.add(listener); return () => connectedListeners.delete(listener); },
    };
    return {
        emitted, socket, transport, handlers,
        changeConnected: (connected: boolean) => { socket.connected = connected; connectedListeners.forEach((listener) => listener()); },
        snapshot: (payload: unknown) => handlers.get(SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT)?.(payload),
    };
}

const cleanup: Array<() => void> = [];
beforeAll(() => {
    vi.spyOn(AppState, 'addEventListener').mockImplementation(() => ({ remove() {} }) as never);
    Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
});
afterEach(() => { cleanup.splice(0).reverse().forEach((dispose) => dispose()); });
/** The adapter defers its runtime import, so settling needs real task turns. */
async function settle() { for (let index = 0; index < 12; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); }

describe('managed Home socket presence attachment', () => {
    it('merges Session and independent Discussion visibility through the actual authenticated socket adapter', async () => {
        const previousState = storage.getState();
        const previousHome = getAppliedActiveServerSnapshot();
        const previousAvailability = isAppliedActiveServerRuntimeAvailable();
        cleanup.push(() => {
            storage.setState(previousState, true);
            publishAppliedActiveServerSnapshot(previousHome, previousAvailability);
        });
        const target = { serverId: 'discussion-carrier-home', discussionId: 'same-id' };
        storage.getState().activateProfileScope({ serverId: target.serverId, accountId: 'self' });
        publishAppliedActiveServerSnapshot({ serverId: target.serverId, serverUrl: 'https://discussion-carrier.test', generation: 5 });
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        const unregister = registerDiscussionHumanPresence(target, lifetime);
        cleanup.push(unregister);
        markSessionSurfaceVisible('same-id', target.serverId);
        cleanup.push(() => markSessionSurfaceHidden('same-id', target.serverId));
        const boundary = managedSocket();
        cleanup.push(attachManagedSessionHumanPresenceSocket({
            serverId: target.serverId, token: token('self'), socket: boundary.socket as never, transport: boundary.transport as never,
        }));
        await settle();
        expect(boundary.emitted).toEqual([['session-human-presence:visible-replace', {
            v: 1, sessionIds: ['same-id'], locations: [{ discussionId: 'same-id' }],
        }]]);
        boundary.snapshot({ v: 1, discussionId: 'same-id', observedAt: 7, viewers: [
            { account: { kind: 'account', accountId: 'self', firstName: 'Me', lastName: null, username: null, avatarUrl: null }, typing: false },
            { account: { kind: 'account', accountId: 'peer', firstName: 'Peer', lastName: null, username: null, avatarUrl: null }, typing: true },
        ] });
        expect(sessionHumanPresenceStore.read(target)).toMatchObject({ status: 'live', viewers: [{ account: { accountId: 'peer' }, typing: true }] });
        expect(sessionHumanPresenceStore.read({ serverId: target.serverId, sessionId: 'same-id' }).status).toBe('connecting');
        reportDiscussionTypingEdit(target, true, lifetime);
        expect(SessionHumanPresenceTypingSetV1Schema.parse(boundary.emitted.at(-1)?.[1]))
            .toEqual({ v: 1, discussionId: 'same-id', typing: true });
        unregister();
        await settle();
        expect(boundary.emitted.slice(-2)).toEqual([
            ['session-human-presence:typing-set', { v: 1, discussionId: 'same-id', typing: false }],
            ['session-human-presence:visible-replace', { v: 1, sessionIds: ['same-id'] }],
        ]);
        expect(sessionHumanPresenceStore.read(target)).toMatchObject({ status: 'unavailable', viewers: [] });
    });
    it('accepts a delayed visibility declaration beyond the generic ACK deadline', async () => {
        const serverId = 'slow-home';
        const sessionId = 'slow-session';
        markSessionSurfaceVisible(sessionId, serverId);
        cleanup.push(() => markSessionSurfaceHidden(sessionId, serverId));
        const boundary = managedSocket();
        let acknowledge!: (value: unknown) => void;
        const pending = new Promise<unknown>((resolve) => { acknowledge = resolve; });
        boundary.socket.emitWithAck = async () => await pending as { v: number; ok: boolean; admittedSessionIds: string[] };
        boundary.socket.timeout = () => ({ emitWithAck: async () => { throw new Error('operation has timed out'); } });
        cleanup.push(attachManagedSessionHumanPresenceSocket({
            serverId, token: token('self'), socket: boundary.socket as never, transport: boundary.transport as never,
        }));
        await settle();
        acknowledge({ v: 1, ok: true, admittedSessionIds: [sessionId] });
        await settle();
        boundary.snapshot({
            v: 1, sessionId, observedAt: 7,
            viewers: [{ account: { kind: 'account', accountId: 'peer', firstName: 'Peer', lastName: null, username: null, avatarUrl: null }, typing: false }],
        });
        expect(sessionHumanPresenceStore.read({ serverId, sessionId })).toMatchObject({ status: 'live', viewers: [{ account: { accountId: 'peer' } }] });
    });
    it('publishes physical computer focus on every Home, clears hidden focus, and republishes after reconnect', async () => {
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        const listeners = new Map<string, Set<() => void>>();
        let focused = true;
        const document = { visibilityState: 'visible', hasFocus: () => focused,
            addEventListener: (event: string, listener: () => void) => {
                const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set);
            },
            removeEventListener: (event: string, listener: () => void) => listeners.get(event)?.delete(listener) };
        vi.stubGlobal('navigator', { userAgent: 'Windows NT', maxTouchPoints: 0 });
        vi.stubGlobal('document', document);
        vi.stubGlobal('window', { addEventListener: document.addEventListener, removeEventListener: document.removeEventListener });
        const a = managedSocket(); const b = managedSocket();
        const detachA = attachManagedSessionHumanPresenceSocket({ serverId: 'a', token: token('self'),
            socket: a.socket as never, transport: a.transport as never });
        const detachB = attachManagedSessionHumanPresenceSocket({ serverId: 'b', token: token('self'),
            socket: b.socket as never, transport: b.transport as never });
        try {
            await settle();
            const focusEvents = (home: typeof a) => home.emitted.filter(([event]) => event === 'ui-focus').map(([, value]) => value);
            expect(focusEvents(a).at(-1)).toEqual({ computer: true, focused: true });
            expect(focusEvents(b).at(-1)).toEqual({ computer: true, focused: true });
            document.visibilityState = 'hidden'; listeners.get('visibilitychange')?.forEach((listener) => listener());
            expect(focusEvents(a).at(-1)).toEqual({ computer: true, focused: false });
            focused = false; listeners.get('blur')?.forEach((listener) => listener());
            a.changeConnected(false);
            document.visibilityState = 'visible'; focused = true;
            listeners.get('focus')?.forEach((listener) => listener());
            expect(focusEvents(a).at(-1)).toEqual({ computer: true, focused: false });
            a.changeConnected(true);
            await settle();
            expect(focusEvents(a).at(-1)).toEqual({ computer: true, focused: true });
        } finally {
            // Restore the process-wide host observer through its real lifecycle boundary.
            document.visibilityState = 'visible'; focused = true;
            listeners.get('visibilitychange')?.forEach((listener) => listener());
            detachA(); detachB();
            vi.unstubAllGlobals();
            Object.defineProperty(Platform, 'OS', { value: originalPlatform, configurable: true });
        }
    });
    it('declares only its own Home surfaces over the supplied carrier and excludes the token Account', async () => {
        // Two Homes with the same Session id: the concurrent/Iroh carrier for Home B must
        // never carry Home A's declaration, and neither may borrow the focused Home socket.
        markSessionSurfaceVisible('shared-session', 'home-a');
        markSessionSurfaceVisible('shared-session', 'home-b');
        markSessionSurfaceVisible('only-b', 'home-b');
        cleanup.push(() => {
            markSessionSurfaceHidden('shared-session', 'home-a');
            markSessionSurfaceHidden('shared-session', 'home-b');
            markSessionSurfaceHidden('only-b', 'home-b');
        });
        const secondary = managedSocket();
        cleanup.push(attachManagedSessionHumanPresenceSocket({
            serverId: 'home-b',
            token: token('self'),
            socket: secondary.socket as never,
            transport: secondary.transport as never,
        }));
        await settle();
        expect(secondary.emitted).toEqual([
            ['session-human-presence:visible-replace', { v: 1, sessionIds: ['only-b', 'shared-session'] }],
        ]);
        secondary.snapshot({
            v: 1, sessionId: 'shared-session', observedAt: 7,
            viewers: [
                { account: { kind: 'account', accountId: 'self', firstName: 'Me', lastName: null, username: null, avatarUrl: null }, typing: false },
                { account: { kind: 'account', accountId: 'peer', firstName: 'Peer', lastName: null, username: null, avatarUrl: null }, typing: true },
            ],
        });
        expect(sessionHumanPresenceStore.read({ serverId: 'home-b', sessionId: 'shared-session' })).toMatchObject({
            status: 'live', viewers: [{ account: { accountId: 'peer' }, typing: true }],
        });
        // Home A never attached, so its identically named Session stays unobserved.
        expect(sessionHumanPresenceStore.read({ serverId: 'home-a', sessionId: 'shared-session' }).status).toBe('unavailable');
    });

    it('never declares presence for an unauthenticated carrier', async () => {
        const anonymous = managedSocket();
        const listener = vi.fn();
        anonymous.socket.on = listener;
        cleanup.push(attachManagedSessionHumanPresenceSocket({
            serverId: 'home-c',
            token: 'not-a-token',
            socket: anonymous.socket as never,
            transport: anonymous.transport as never,
        }));
        await settle();
        expect(anonymous.emitted).toEqual([]);
        expect(listener).not.toHaveBeenCalled();
    });
});
