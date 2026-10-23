import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';

import { createSessionFixture as createBaseSessionFixture } from '@/dev/testkit';
import type { Session } from '@/sync/domains/state/storageTypes';
import { SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } from '@/sync/domains/session/attention/runtimePresentation';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import {
    buildSessionContextFacts,
    projectSessionContextPresentation,
} from '@/sync/domains/session/presentation/sessionContextPresentation';

import { buildPetCompanionActivityModel } from './buildPetCompanionActivityModel';

function createSessionFixture(overrides: Partial<Session> = {}): Session {
    return createBaseSessionFixture({ serverId: 'server-a', encryptionMode: 'plain', ...overrides });
}

describe('buildPetCompanionActivityModel', () => {
    it.each([
        { encryptionMode: 'e2ee' as const, encryptedContentAvailability: undefined, readable: false },
        { encryptionMode: 'e2ee' as const, encryptedContentAvailability: 'ready' as const, readable: true },
        { encryptionMode: 'plain' as const, encryptedContentAvailability: undefined, readable: true },
    ])('gates retained transcript signals without context: $encryptionMode/$encryptedContentAvailability', ({ encryptionMode, encryptedContentAvailability, readable }) => {
        const session = createSessionFixture({
            id: 'private-pet', encryptionMode, encryptedContentAvailability,
            active: true, presence: 'online', createdAt: 1_000,
            pendingPermissionRequestCount: 1, pendingRequestObservedAt: 2_000,
            metadata: { path: '/private/path', host: 'private-host', name: 'Private retained title' },
        });
        const model = buildPetCompanionActivityModel({
            sessions: [session], nowMs: 3_000,
            signalsBySessionId: {
                [session.id]: {
                    hasFailure: false, hasUnreadMessages: false,
                    latestThinkingActivityAtMs: null, latestMeaningfulActivityAtMs: 2_000,
                    pendingMessageCount: 0, lastMessageSubtitle: 'Private retained transcript',
                },
            },
        });
        expect(model.trayItems).toHaveLength(1);
        if (readable) {
            expect(model.trayItems[0]?.title).toBe('Private retained title');
            expect(model.trayItems[0]?.subtitle).toBe('Private retained transcript');
        } else {
            expect(JSON.stringify(model)).not.toContain('Private retained');
            expect(model.trayItems[0]?.subtitle).toBeNull();
        }
    });

    it('does not animate a canonical active turn when runtime evidence is stale', () => {
        const session = createSessionFixture({ active: true, presence: 'online', activeAt: 1,
            latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: 1 });
        expect(buildPetCompanionActivityModel({ sessions: [session], nowMs: 200_000 }).state).toBe('idle');
    });

    it('suppresses untracked sessions and hides locked tracked content', () => {
        const session = createSessionFixture({
            id: 'private-session', active: true, thinking: true, thinkingAt: 990,
            metadata: { path: '/private/path', host: 'private-host', name: 'Private title' },
            viewer: {
                latestFailureSeq: null,
                readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: 1 },
                relevance: { relevant: true, reasons: ['followed_by_me'] },
                follow: { follows: true, notificationLevel: 'none' },
                notification: { level: 'none', source: 'preference' },
                attention: { needsAttention: true, reasons: ['unread'], primary: 'unread', presentation: 'status_only' },
            },
        });
        const locked = buildPetCompanionActivityModel({ sessions: [session], nowMs: 1_000 });
        expect(locked.trayItems[0]?.title).not.toContain('Private');
        expect(locked.trayItems[0]?.subtitle).toBeNull();
        const untracked = createSessionFixture({
            ...session,
            viewer: {
                latestFailureSeq: null,
                readState: { state: 'not_started' },
                relevance: { relevant: false, reasons: [] },
                follow: { follows: false, notificationLevel: null },
                notification: { level: 'none', source: 'none' },
                attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
            },
        });
        expect(buildPetCompanionActivityModel({ sessions: [untracked], nowMs: 1_000 }).trayItems).toHaveLength(0);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('uses wall-clock time to expire stale activity when nowMs is omitted', () => {
        vi.spyOn(Date, 'now').mockReturnValue(4_000_000);
        const session = createSessionFixture({
            id: 'stale-failed-session',
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: 1_000,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
        });

        expect(model).toMatchObject({
            state: 'idle',
            reason: 'idle',
            sessionId: session.id,
            trayItems: [],
        });
    });

    it('maps projected failed turn status to failed activity', () => {
        const session = createSessionFixture({
            id: 'turn-failed-session',
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: 2_000,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
            nowMs: 3_000,
            signalsBySessionId: {
                [session.id]: {
                    hasFailure: false,
                    hasUnreadMessages: false,
                    latestThinkingActivityAtMs: null,
                    latestMeaningfulActivityAtMs: 2_000,
                    pendingMessageCount: 0,
                },
            },
        });

        expect(model).toMatchObject({
            state: 'failed',
            reason: 'failed',
            sessionId: session.id,
        });
    });

    it('does not map stale runtime issue audit data to failed activity after a non-failed turn', () => {
        const runtimeIssue: SessionRuntimeIssueV1 = {
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'agent_session_error',
            source: 'agent_session_error',
            occurredAt: 2_000,
        };
        const session = createSessionFixture({
            id: 'runtime-issue-session',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 2_000,
            lastRuntimeIssue: runtimeIssue,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
            nowMs: 3_000,
            signalsBySessionId: {
                [session.id]: {
                    hasFailure: false,
                    hasUnreadMessages: false,
                    latestThinkingActivityAtMs: null,
                    latestMeaningfulActivityAtMs: 2_000,
                    pendingMessageCount: 0,
                },
            },
        });

        expect(model).toMatchObject({
            state: 'idle',
            reason: 'idle',
            sessionId: session.id,
            trayItems: [],
        });
    });

    it('ignores historical transcript failure signals after the projected turn recovers', () => {
        const session = createSessionFixture({
            id: 'recovered-session',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 3_000,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
            nowMs: 4_000,
            signalsBySessionId: {
                [session.id]: {
                    hasFailure: true,
                    hasUnreadMessages: false,
                    latestThinkingActivityAtMs: null,
                    latestMeaningfulActivityAtMs: 2_000,
                    pendingMessageCount: 0,
                },
            },
        });

        expect(model).toMatchObject({
            state: 'idle',
            reason: 'idle',
            sessionId: session.id,
            trayItems: [],
        });
    });

    it('keeps projected running activity live until a terminal projection arrives', () => {
        const signalAtMs = 1_000;
        const session = createSessionFixture({
            id: 'running-expiry-session',
            active: true,
            activeAt: signalAtMs,
            thinking: true,
            thinkingAt: signalAtMs,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: signalAtMs,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
            nowMs: signalAtMs + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1,
        });

        expect(model).toMatchObject({
            state: 'running',
            reason: 'running',
            sessionId: session.id,
        });
        expect(model.trayItems[0]).toEqual(expect.objectContaining({
            status: 'running',
            expiresAtMs: null,
        }));
    });

    it('keeps projected running activity alive regardless of heartbeat freshness', () => {
        const staleSignalAtMs = 1_000;
        const activeAtMs = 50_000;
        const session = createSessionFixture({
            id: 'running-heartbeat-session',
            active: true,
            activeAt: activeAtMs,
            meaningfulActivityAt: activeAtMs + 5_000,
            thinking: true,
            thinkingAt: staleSignalAtMs,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: staleSignalAtMs,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
            nowMs: activeAtMs + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1,
        });

        expect(model).toMatchObject({
            state: 'running',
            reason: 'running',
            sessionId: session.id,
        });
    });

    it('pauses projected running activity when runtime reachability is stale', () => {
        const nowMs = 1_000_000;
        const session = createSessionFixture({
            id: 'running-meaningful-activity-session',
            active: true,
            activeAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            meaningfulActivityAt: nowMs - 1_000,
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
            nowMs,
        });

        expect(model).toMatchObject({
            state: 'idle',
            reason: 'idle',
            sessionId: session.id,
        });
    });

    it('preserves unresolved canonical permission activity while runtime remains live', () => {
        const nowMs = 1_000_000;
        const session = createSessionFixture({
            id: 'waiting-heartbeat-only-session',
            active: true,
            activeAt: nowMs - 1_000,
            pendingPermissionRequestCount: 1,
            pendingRequestObservedAt: nowMs - 1_000,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
            nowMs,
        });

        expect(model).toMatchObject({
            state: 'waiting',
            reason: 'waiting',
            sessionId: session.id,
        });
        expect(model.trayItems).toEqual([
            expect.objectContaining({
                sessionId: session.id,
                status: 'waiting',
            }),
        ]);
    });

    it('keeps running tray items live across timestamp-only updates', () => {
        const signalAtMs = 10_000;
        const session = createSessionFixture({
            id: 'running-live-session',
            active: true,
            activeAt: signalAtMs,
            thinking: true,
            thinkingAt: signalAtMs,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: signalAtMs,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
            nowMs: signalAtMs + 1,
            signalsBySessionId: {
                [session.id]: {
                    hasFailure: false,
                    hasUnreadMessages: false,
                    latestThinkingActivityAtMs: signalAtMs,
                    latestMeaningfulActivityAtMs: signalAtMs,
                    lastMessageSubtitle: 'A live stream update',
                    pendingMessageCount: 0,
                },
            },
        });

        expect(model.trayItems[0]).toEqual(expect.objectContaining({
            status: 'running',
            dismissKey: JSON.stringify(['running', 'server-a', session.id, 'live']),
            activityAtMs: null,
            subtitle: null,
        }));
    });

    it('ignores background activity while preserving foreground running behavior', () => {
        const nowMs = 1_000_000;
        const background = createSessionFixture({
            id: 'background-session',
            active: true,
            presence: 'online',
            thinking: false,
            latestTurnStatus: 'completed',
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
        });
        const foreground = createSessionFixture({
            id: 'foreground-session',
            active: true,
            activeAt: nowMs - 1,
            presence: 'online',
            thinking: true,
            thinkingAt: nowMs - 1,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - 1,
        });

        expect(buildPetCompanionActivityModel({
            sessions: [background],
            nowMs,
        })).toMatchObject({ state: 'idle', trayItems: [] });
        expect(buildPetCompanionActivityModel({
            sessions: [foreground],
            nowMs,
        })).toMatchObject({ state: 'running', sessionId: foreground.id });
    });

    it('does not report an archived session as running activity', () => {
        const nowMs = 1_000_000;
        const session = createSessionFixture({
            id: 'archived-running-session',
            active: true,
            presence: 'online',
            activeAt: nowMs - 1,
            archivedAt: nowMs - 10_000,
            thinking: true,
            thinkingAt: nowMs - 1,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - 1,
        });

        expect(buildPetCompanionActivityModel({
            sessions: [session],
            nowMs,
        })).toMatchObject({ state: 'idle', reason: 'idle', trayItems: [] });
    });

    it('renders authorized structural context for a status-only candidate on each Home', () => {
        const nowMs = 50_000;
        const homeAAddress = { serverId: 'home-a', sessionId: 'status-only-session' } as const;
        const homeBAddress = { serverId: 'home-b', sessionId: 'status-only-session' } as const;
        const createStatusOnlySession = (serverId: string) => createSessionFixture({
            id: 'status-only-session',
            serverId,
            active: true,
            presence: 'online',
            thinking: true,
            thinkingAt: nowMs,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs,
            metadata: { path: '/private/path', host: 'private-host', name: 'Private title' },
            viewer: {
                latestFailureSeq: null,
                readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: 1 },
                relevance: { relevant: true, reasons: ['followed_by_me'] },
                follow: { follows: true, notificationLevel: 'none' },
                notification: { level: 'none', source: 'preference' },
                attention: { needsAttention: true, reasons: ['unread'], primary: 'unread', presentation: 'status_only' },
            },
        });

        const model = buildPetCompanionActivityModel({
            sessions: [createStatusOnlySession('home-a'), createStatusOnlySession('home-b')],
            contextsByAddressKey: {
                [sessionAddressKey(homeAAddress)]: projectSessionContextPresentation(
                    buildSessionContextFacts({ address: homeAAddress, homeName: 'Home A' }),
                ),
                [sessionAddressKey(homeBAddress)]: projectSessionContextPresentation(
                    buildSessionContextFacts({ address: homeBAddress, homeName: 'Home B' }),
                ),
            },
            nowMs: nowMs + 1,
        });

        // Home/audience/responsibility/freshness is authorized structural context and must
        // distinguish the two rows visually and for assistive technology, while the private
        // title and message stay withheld.
        expect(model.trayItems.map((item) => item.subtitle)).toEqual(['Home A', 'Home B']);
        expect(model.trayItems.map((item) => item.accessibilityContext)).toEqual(['Home A', 'Home B']);
        expect(JSON.stringify(model)).not.toContain('Private title');
    });

    it('keeps duplicate Session ids on different Homes distinct', () => {
        const nowMs = 50_000;
        const homeAAddress = { serverId: 'home-a', sessionId: 'same-session' } as const;
        const homeBAddress = { serverId: 'home-b', sessionId: 'same-session' } as const;
        const createRunningSession = (serverId: string) => createSessionFixture({
            id: 'same-session',
            serverId,
            active: true,
            presence: 'online',
            thinking: true,
            thinkingAt: nowMs,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [createRunningSession('home-a'), createRunningSession('home-b')],
            selectedAddress: homeBAddress,
            contextsByAddressKey: {
                [sessionAddressKey(homeAAddress)]: projectSessionContextPresentation(
                    buildSessionContextFacts({ address: homeAAddress, homeName: 'Home A' }),
                ),
                [sessionAddressKey(homeBAddress)]: projectSessionContextPresentation(
                    buildSessionContextFacts({ address: homeBAddress, homeName: 'Home B' }),
                ),
            },
            nowMs: nowMs + 1,
        });

        expect(model.address).toEqual(homeBAddress);
        expect(model.trayItems).toHaveLength(2);
        expect(model.trayItems.map((item) => item.address)).toEqual([
            homeBAddress,
            homeAAddress,
        ]);
        expect(model.trayItems.map((item) => item.contextLine)).toEqual(['Home B', 'Home A']);
        expect(new Set(model.trayItems.map((item) => item.dismissKey)).size).toBe(2);
    });
});
