import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { ENCRYPTED_DATA_KEY_V1_BYTES } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { ABSENT_SESSION_FOLLOW_FACTS_V1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { QUIET_SESSION_PERSONAL_ATTENTION_V1 } from '@happier-dev/protocol/sessions/personal/attention';
import { resolveSessionEffectiveNotificationV1 } from '@happier-dev/protocol/sessions/personal/eventEligibility';
import { SessionViewerProjectionV1Schema, type SessionViewerProjectionV1 } from '@happier-dev/protocol/sessions/personal/viewer';

export function createSessionViewerFixture(overrides: Partial<SessionViewerProjectionV1> = {}): SessionViewerProjectionV1 {
    const follow = overrides.follow ?? ABSENT_SESSION_FOLLOW_FACTS_V1;
    return SessionViewerProjectionV1Schema.parse({
        readState: { state: 'not_started' },
        relevance: { relevant: follow.follows, reasons: follow.follows ? ['followed_by_me'] : [] },
        attention: QUIET_SESSION_PERSONAL_ATTENTION_V1,
        notification: resolveSessionEffectiveNotificationV1({ facts: follow, isSessionOwner: false }),
        ...overrides, follow,
    });
}

export function createSessionDataKeyFixture(fill = 7): Uint8Array {
    return new Uint8Array(ENCRYPTED_DATA_KEY_V1_BYTES).fill(fill);
}

export function createSessionAccessFixture(
    level: NonNullable<Session['access']>['level'] = 'owner',
    capabilities: Partial<NonNullable<Session['access']>['capabilities']> = {},
): NonNullable<Session['access']> {
    const owner = level === 'owner';
    const admin = owner || level === 'admin';
    return { role: owner ? 'owner' : 'recipient', level, capabilities: {
        readTranscript: true, submitAgentInput: level !== 'view', editSessionRecords: level !== 'view',
        approveRuntimePermissions: owner, manageAccess: admin, managePermissionDelegation: owner,
        managePublicLink: owner, archiveSession: admin, renameSession: admin,
        assignResponsibility: admin, stopSession: owner, deleteSession: owner,
        ...capabilities,
    } };
}

export function createSessionFixture(
    overrides: Partial<Session> = {},
    options: Readonly<{ memoryEnabled?: boolean }> = {},
): Session {
    const createdAt = overrides.createdAt ?? 1;
    const updatedAt = overrides.updatedAt ?? createdAt;

    const session: Session = {
        id: 'session-1',
        encryptionMode: 'plain',
        encryptedContentAvailability: 'ready',
        access: createSessionAccessFixture(overrides.accessLevel ?? 'owner', {
            approveRuntimePermissions: overrides.canApprovePermissions ?? overrides.accessLevel == null,
        }),
        seq: 1,
        createdAt,
        updatedAt,
        active: false,
        activeAt: updatedAt,
        metadata: {
            path: '/Users/tester/project',
            host: 'tester.local',
            homeDir: '/Users/tester',
            machineId: 'machine-1',
        } as Session['metadata'],
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    };
    if (options.memoryEnabled !== undefined) {
        const field = session.metadataLayoutVersion === 1 ? 'ownerMetadataView' : 'metadata';
        const metadata = session[field];
        if (!metadata) throw new Error('A Session memory fixture requires readable owner metadata');
        const work = metadata.work;
        session[field] = { ...metadata, work: {
            ...(work && typeof work === 'object' && !Array.isArray(work) ? work : {}),
            memoryEnabled: options.memoryEnabled,
        } };
    }
    return session;
}

export function createSessionListRenderableSessionFixture(
    overrides: Partial<SessionListRenderableSession> = {},
): SessionListRenderableSession {
    const createdAt = overrides.createdAt ?? 1;
    const updatedAt = overrides.updatedAt ?? createdAt;
    const activeAt = overrides.activeAt ?? updatedAt;

    return {
        id: 'session-1',
        encryptionMode: 'plain',
        encryptedContentAvailability: 'ready',
        access: createSessionAccessFixture(overrides.accessLevel ?? 'owner', {
            approveRuntimePermissions: overrides.canApprovePermissions ?? overrides.accessLevel == null,
        }),
        seq: 1,
        createdAt,
        updatedAt,
        active: false,
        activeAt,
        archivedAt: null,
        pendingVersion: undefined,
        pendingCount: undefined,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: {
            path: '/Users/tester/project',
            host: 'tester.local',
            homeDir: '/Users/tester',
            machineId: 'machine-1',
        },
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
        thinkingGraceUntil: null,
        hasPendingPermissionRequests: false,
        hasPendingUserActionRequests: false,
        pendingRequestObservedAt: null,
        hasUnreadMessages: false,
        keepVisibleWhenInactive: false,
        ...overrides,
    };
}
