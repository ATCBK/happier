import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';

import { resolveLiveActivityReconciliationState } from './resolveLiveActivityReconciliationState';

import {
    buildHappierFocusLiveActivityIdentity,
    buildLiveActivityInstanceKey,
} from './liveActivityIdentity';

/** The production Activity identity encoder, so fixtures cannot drift from real keys. */
function liveActivityKey(serverId: string, sessionId: string): string {
    return buildLiveActivityInstanceKey(buildHappierFocusLiveActivityIdentity({ serverId, sessionId }));
}


describe('resolveLiveActivityReconciliationState', () => {
    it('keeps the current dynamic primary within the dwell window while it remains eligible', () => {
        const policy = resolveActivitySurfacePolicy({
            liveActivitiesMode: 'attention',
            liveActivitiesStrategy: 'dynamic_primary',
        });

        const firstPass = resolveLiveActivityReconciliationState({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    serverId: 'server-a',
                    updatedAt: 20,
                    meaningfulActivityAt: 20,
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Permission work', updatedAt: 3 },
                    },
                }),
                createSessionFixture({
                    id: 'action',
                    serverId: 'server-a',
                    updatedAt: 10,
                    meaningfulActivityAt: 10,
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                    metadata: {
                        path: '/Users/tester/project/action',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Action work', updatedAt: 2 },
                    },
                }),
            ],
            policy,
            nowMs: 1_000,
        });

        expect(firstPass.snapshots.map((snapshot) => snapshot.sessionId)).toEqual(['permission']);
        expect(firstPass.preferredPrimaryActivityInstanceKey).toBe(liveActivityKey('server-a', 'permission'));

        const withinDwell = resolveLiveActivityReconciliationState({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    serverId: 'server-a',
                    updatedAt: 25,
                    meaningfulActivityAt: 25,
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 30_950,
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Permission work', updatedAt: 3 },
                    },
                }),
                createSessionFixture({
                    id: 'action',
                    serverId: 'server-a',
                    updatedAt: 50,
                    meaningfulActivityAt: 50,
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 30_950,
                    metadata: {
                        path: '/Users/tester/project/action',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Action work', updatedAt: 2 },
                    },
                }),
            ],
            policy,
            currentPreferredPrimaryActivityInstanceKey: firstPass.preferredPrimaryActivityInstanceKey,
            currentPreferredPrimaryChangedAtMs: firstPass.preferredPrimaryChangedAtMs,
            nowMs: 31_000,
        });

        expect(withinDwell.snapshots.map((snapshot) => snapshot.sessionId)).toEqual(['permission']);
        expect(withinDwell.preferredPrimaryChangedAtMs).toBe(firstPass.preferredPrimaryChangedAtMs);

        const afterDwell = resolveLiveActivityReconciliationState({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    serverId: 'server-a',
                    updatedAt: 25,
                    meaningfulActivityAt: 25,
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 121_950,
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Permission work', updatedAt: 3 },
                    },
                }),
                createSessionFixture({
                    id: 'action',
                    serverId: 'server-a',
                    updatedAt: 50,
                    meaningfulActivityAt: 50,
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 121_950,
                    metadata: {
                        path: '/Users/tester/project/action',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Action work', updatedAt: 2 },
                    },
                }),
            ],
            policy,
            currentPreferredPrimaryActivityInstanceKey: firstPass.preferredPrimaryActivityInstanceKey,
            currentPreferredPrimaryChangedAtMs: firstPass.preferredPrimaryChangedAtMs,
            nowMs: 122_000,
        });

        expect(afterDwell.snapshots.map((snapshot) => snapshot.sessionId)).toEqual(['action']);
        expect(afterDwell.preferredPrimaryActivityInstanceKey).toBe(liveActivityKey('server-a', 'action'));
        expect(afterDwell.preferredPrimaryChangedAtMs).toBe(122_000);
    });

    it('persists the pinned primary session across reconciliations while it remains eligible', () => {
        const policy = resolveActivitySurfacePolicy({
            liveActivitiesMode: 'attention',
            liveActivitiesStrategy: 'pinned_primary',
            liveActivitiesMaxConcurrent: 2,
        });

        const firstPass = resolveLiveActivityReconciliationState({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    serverId: 'server-a',
                    updatedAt: 20,
                    meaningfulActivityAt: 20,
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Permission work', updatedAt: 3 },
                    },
                }),
                createSessionFixture({
                    id: 'action',
                    serverId: 'server-a',
                    updatedAt: 10,
                    meaningfulActivityAt: 10,
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                    metadata: {
                        path: '/Users/tester/project/action',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Action work', updatedAt: 2 },
                    },
                }),
            ],
            policy,
            nowMs: 1_000,
        });

        expect(firstPass.snapshots.map((snapshot) => snapshot.sessionId)).toEqual(['permission']);
        expect(firstPass.preferredPrimaryAddress).toEqual({ serverId: 'server-a', sessionId: 'permission' });

        const secondPass = resolveLiveActivityReconciliationState({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    serverId: 'server-a',
                    updatedAt: 25,
                    meaningfulActivityAt: 25,
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Permission work', updatedAt: 3 },
                    },
                }),
                createSessionFixture({
                    id: 'action',
                    serverId: 'server-a',
                    updatedAt: 50,
                    meaningfulActivityAt: 50,
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                    metadata: {
                        path: '/Users/tester/project/action',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Action work', updatedAt: 2 },
                    },
                }),
            ],
            policy,
            currentPreferredPrimaryAddress: firstPass.preferredPrimaryAddress,
            nowMs: 1_000,
        });

        expect(secondPass.snapshots.map((snapshot) => snapshot.sessionId)).toEqual(['permission']);
        expect(secondPass.preferredPrimaryAddress).toEqual({ serverId: 'server-a', sessionId: 'permission' });
    });

    it('keeps the pinned primary qualified when two Homes share the same Session id', () => {
        const policy = resolveActivitySurfacePolicy({
            liveActivitiesMode: 'attention',
            liveActivitiesStrategy: 'pinned_primary',
        });

        const firstPass = resolveLiveActivityReconciliationState({
            sessions: [
                createSessionFixture({
                    id: 'same-session',
                    serverId: 'server-a',
                    updatedAt: 20,
                    meaningfulActivityAt: 20,
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                }),
                createSessionFixture({
                    id: 'same-session',
                    serverId: 'server-b',
                    updatedAt: 10,
                    meaningfulActivityAt: 10,
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                }),
            ],
            policy,
            nowMs: 1_000,
        });

        expect(firstPass.snapshots.map((snapshot) => snapshot.serverId)).toEqual(['server-a']);
        expect(firstPass.preferredPrimaryAddress).toEqual({
            serverId: 'server-a',
            sessionId: 'same-session',
        });

        const secondPass = resolveLiveActivityReconciliationState({
            sessions: [
                createSessionFixture({
                    id: 'same-session',
                    serverId: 'server-b',
                    updatedAt: 50,
                    meaningfulActivityAt: 50,
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                }),
                createSessionFixture({
                    id: 'same-session',
                    serverId: 'server-a',
                    updatedAt: 25,
                    meaningfulActivityAt: 25,
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                }),
            ],
            policy,
            currentPreferredPrimaryAddress: firstPass.preferredPrimaryAddress,
            nowMs: 1_000,
        });

        expect(secondPass.snapshots.map((snapshot) => snapshot.serverId)).toEqual(['server-a']);
        expect(secondPass.preferredPrimaryAddress).toEqual({
            serverId: 'server-a',
            sessionId: 'same-session',
        });
    });

    it('does not publish an unbound Activity instance as a routable preferred Session address', () => {
        const policy = resolveActivitySurfacePolicy({
            liveActivitiesMode: 'attention',
            liveActivitiesStrategy: 'pinned_primary',
        });

        const result = resolveLiveActivityReconciliationState({
            sessions: [
                createSessionFixture({
                    id: 'unbound-session',
                    // An unbound Session carries no Home at all; the snapshot builder
                    // normalizes that to the `serverId: null` asserted below.
                    serverId: undefined,
                    updatedAt: 20,
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                }),
            ],
            policy,
            nowMs: 1_000,
        });

        expect(result.snapshots).toHaveLength(1);
        expect(result.snapshots[0]).toMatchObject({
            serverId: null,
            sessionId: 'unbound-session',
        });
        expect(result.preferredPrimaryAddress).toBeNull();
    });

    it('uses the shared live activity dwell window when deciding whether to hold the dynamic primary', () => {
        const policy = resolveActivitySurfacePolicy({
            liveActivitiesMode: 'attention',
            liveActivitiesStrategy: 'dynamic_primary',
        });

        const firstPass = resolveLiveActivityReconciliationState({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    serverId: 'server-a',
                    updatedAt: 20,
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Permission work', updatedAt: 3 },
                    },
                }),
                createSessionFixture({
                    id: 'action',
                    serverId: 'server-a',
                    updatedAt: 10,
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                    metadata: {
                        path: '/Users/tester/project/action',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Action work', updatedAt: 2 },
                    },
                }),
            ],
            policy,
            dwellMs: 500,
            nowMs: 1_000,
        });

        const afterSharedDwell = resolveLiveActivityReconciliationState({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    serverId: 'server-a',
                    updatedAt: 25,
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: 1_550,
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Permission work', updatedAt: 3 },
                    },
                }),
                createSessionFixture({
                    id: 'action',
                    serverId: 'server-a',
                    updatedAt: 50,
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: 1_550,
                    metadata: {
                        path: '/Users/tester/project/action',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Action work', updatedAt: 2 },
                    },
                }),
            ],
            policy,
            dwellMs: 500,
            currentPreferredPrimaryActivityInstanceKey: firstPass.preferredPrimaryActivityInstanceKey,
            currentPreferredPrimaryChangedAtMs: firstPass.preferredPrimaryChangedAtMs,
            nowMs: 1_600,
        });

        expect(afterSharedDwell.snapshots.map((snapshot) => snapshot.sessionId)).toEqual(['action']);
    });
});
