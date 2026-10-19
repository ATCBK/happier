import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveSessionReadState, resolveSessionReadStateAction } from './sessionReadState';
import type { Message } from '@happier-dev/session-core/messages';
import { applyMessageChangeToTranscriptRenderableAggregate, buildTranscriptRenderableAggregate } from '@/sync/domains/session/listing/transcriptRenderableAggregate';

const storageState = vi.hoisted(() => ({
    sessions: {} as Record<string, unknown>,
    sessionMessages: {} as Record<string, unknown>,
    sessionListRowsByServerId: {} as Record<string, Record<string, unknown>>,
}));
const readStorageState = () => storageState as any;

beforeEach(async () => {
    storageState.sessions = {};
    storageState.sessionMessages = {};
    storageState.sessionListRowsByServerId = {};
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(readStorageState);
});

describe('sessionReadState', () => {
    it('reads the current aggregate without revisiting historical message attention', () => {
        let historicalReads = 0;
        const messages: Message[] = Array.from({ length: 400 }, (_, index) => ({
            id: `m${index + 1}`,
            kind: 'agent-text',
            localId: null,
            createdAt: index + 1,
            seq: index + 1,
            text: 'history',
            get transcriptObservationProvenance() {
                historicalReads += 1;
                return undefined;
            },
        }));
        const aggregate = buildTranscriptRenderableAggregate({ messages, completedRequests: null });
        const transcript = {
            isLoaded: true,
            messageIdsOldestFirst: messages.map((message) => message.id),
            messagesById: Object.fromEntries(messages.map((message) => [message.id, message])),
            renderableAggregate: aggregate as typeof aggregate | undefined,
        };
        storageState.sessionMessages.s_aggregate = transcript;
        historicalReads = 0;
        expect(deriveSessionReadState({
            id: 's_aggregate', seq: 400, lastViewedSessionSeq: 400,
            latestTurnStatus: 'in_progress', metadata: null,
        })).toBe('read');
        expect(historicalReads).toBe(0);

        const previous = messages[messages.length - 1];
        const updated: Message = { ...previous, seq: 401 };
        expect(applyMessageChangeToTranscriptRenderableAggregate({ aggregate, previous, next: updated })).toBe(true);
        transcript.messagesById[updated.id] = updated;
        expect(deriveSessionReadState({
            id: 's_aggregate', seq: 401, lastViewedSessionSeq: 400,
            latestTurnStatus: 'in_progress', metadata: null,
        })).toBe('unread');

        const recovered: Message = {
            ...updated,
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
        };
        expect(applyMessageChangeToTranscriptRenderableAggregate({ aggregate, previous: updated, next: recovered })).toBe(false);
        transcript.renderableAggregate = undefined;
        transcript.messagesById[recovered.id] = recovered;
        expect(deriveSessionReadState({
            id: 's_aggregate', seq: 401, lastViewedSessionSeq: 399,
            latestTurnStatus: 'in_progress', metadata: null,
        })).toBe('read');
    });

    it('keeps an untracked viewer quiet despite old cursor and cached unread projections', () => {
        const session = {
            seq: 8,
            lastViewedSessionSeq: 0,
            latestTurnStatus: 'completed' as const,
            hasUnreadMessages: true,
            metadata: null,
            viewer: { readState: { state: 'not_started' as const } },
        };
        expect(deriveSessionReadState(session)).toBe('read');
    });

    it('uses the private viewer frontier ahead of a stale legacy scalar and cached unread flag', () => {
        const session = {
            seq: 8,
            lastViewedSessionSeq: 0,
            latestTurnStatus: 'completed' as const,
            hasUnreadMessages: true,
            metadata: null,
            viewer: { readState: { state: 'tracking' as const, lastViewedSessionSeq: 8, unreadSince: null } },
        };
        expect(deriveSessionReadState(session)).toBe('read');
    });

    it('offers mark-unread to an untracked reader, matching the Home that admits the explicit operation', () => {
        const session = {
            seq: 3,
            lastViewedSessionSeq: 0,
            latestTurnStatus: 'completed' as const,
            hasUnreadMessages: true,
            metadata: null,
            viewer: {
                readState: { state: 'not_started' as const },
                relevance: { relevant: false, reasons: [] },
                attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' as const },
                notification: { level: 'none' as const, source: 'none' as const },
            },
        };
        // The Home seeds the actor's own row for an explicit mark-read/mark-unread
        // without any prior tracking, so an untracked reader is offered the control
        // rather than silently losing it.
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-unread',
            visible: true,
            targetState: 'unread',
        });
        const trackedViewOnlySession = {
            ...session,
            accessLevel: 'view' as const,
            viewer: {
                ...session.viewer,
                readState: { state: 'tracking' as const, lastViewedSessionSeq: 0, unreadSince: 1 },
            },
        };
        expect(resolveSessionReadStateAction(trackedViewOnlySession)).toEqual({ kind: 'mark-read', visible: true, targetState: 'read' });
    });

    it('derives empty state when a session has no committed activity or direct-session progress', () => {
        expect(deriveSessionReadState({ seq: 0, lastViewedSessionSeq: null, metadata: null })).toBe('empty');
        expect(resolveSessionReadStateAction({ seq: 0, lastViewedSessionSeq: null, metadata: null })).toEqual({
            kind: 'none',
            visible: false,
        });
    });

    it('derives empty state from non-terminal raw seq without readable activity', () => {
        const session = { seq: 3, lastViewedSessionSeq: null, latestTurnStatus: 'in_progress' as const, metadata: null };

        expect(deriveSessionReadState(session)).toBe('empty');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'none',
            visible: false,
        });
    });

    it('derives unread state from terminal seq and offers mark-read', () => {
        const session = { seq: 3, lastViewedSessionSeq: null, latestTurnStatus: 'completed' as const, metadata: null };

        expect(deriveSessionReadState(session)).toBe('unread');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-read',
            visible: true,
            targetState: 'read',
        });
    });

    it('derives read state from a current cursor and offers mark-unread', () => {
        const session = { seq: 3, lastViewedSessionSeq: 3, latestTurnStatus: 'completed' as const, metadata: null };

        expect(deriveSessionReadState(session)).toBe('read');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-unread',
            visible: true,
            targetState: 'unread',
        });
    });

    it('derives unread state from a direct renderable unread projection', () => {
        const session = {
            id: 's1',
            seq: 742,
            lastViewedSessionSeq: 742,
            latestTurnStatus: 'completed' as const,
            hasUnreadMessages: true,
            metadata: null,
        };

        expect(deriveSessionReadState(session)).toBe('unread');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-read',
            visible: true,
            targetState: 'read',
        });
    });

    it('derives unread state from a registered row renderable when the session shell is stale', () => {
        // The renderable is read through the session's qualified address, so the
        // fixture registers the same local address the store owns in production.
        storageState.sessions = { s1: { serverId: 'server-1' } };
        storageState.sessionListRowsByServerId = {
            'server-1': {
                s1: {
                    hasUnreadMessages: true,
                },
            },
        };
        const session = {
            id: 's1',
            seq: 742,
            lastViewedSessionSeq: 742,
            latestTurnStatus: 'completed' as const,
            metadata: null,
        };

        expect(deriveSessionReadState(session)).toBe('unread');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-read',
            visible: true,
            targetState: 'read',
        });
    });

    it('ignores a same-id row cached under another Home when deriving the stale-shell fallback', () => {
        storageState.sessions = { s1: { serverId: 'server-1' } };
        storageState.sessionListRowsByServerId = {
            'server-2': {
                s1: {
                    hasUnreadMessages: true,
                },
            },
        };
        const session = {
            id: 's1',
            seq: 742,
            lastViewedSessionSeq: 742,
            latestTurnStatus: 'completed' as const,
            metadata: null,
        };

        expect(deriveSessionReadState(session)).toBe('read');
    });

    it('derives unread state from ready seq without using raw non-terminal seq', () => {
        const session = {
            seq: 10,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'in_progress' as const,
            latestReadyEventSeq: 5,
            metadata: null,
        };

        expect(deriveSessionReadState(session)).toBe('unread');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-read',
            visible: true,
            targetState: 'read',
        });
    });

    it('derives unread state from committed readable messages for non-terminal sessions', () => {
        storageState.sessionMessages = {
            s1: {
                isLoaded: true,
                messageIdsOldestFirst: ['m1'],
                messagesById: {
                    m1: {
                        id: 'm1',
                        kind: 'agent-text',
                        seq: 5,
                        localId: null,
                        createdAt: 1,
                        text: 'visible',
                    },
                },
            },
        };
        const session = {
            id: 's1',
            seq: 6,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'in_progress' as const,
            metadata: null,
        };

        expect(deriveSessionReadState(session)).toBe('unread');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-read',
            visible: true,
            targetState: 'read',
        });
    });

    it('ignores provider maintenance events when deriving unread and read-state actions', () => {
        storageState.sessionMessages = {
            s1: {
                isLoaded: true,
                messageIdsOldestFirst: ['m1'],
                messagesById: {
                    m1: {
                        id: 'm1',
                        kind: 'agent-event',
                        seq: 5,
                        localId: null,
                        createdAt: 1,
                        event: {
                            type: 'agent-state-sharing-degraded',
                            serviceId: 'anthropic',
                            requestedStateMode: 'shared',
                            effectiveStateMode: 'isolated',
                            code: 'state_symlink_unavailable',
                        },
                    },
                },
            },
        };
        const session = {
            id: 's1',
            seq: 5,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'in_progress' as const,
            metadata: null,
        };

        expect(deriveSessionReadState(session)).toBe('empty');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'none',
            visible: false,
        });
    });

    it('does not let partial stored transcript slices suppress terminal session activity', () => {
        storageState.sessionMessages = {
            s1: {
                isLoaded: false,
                messageIdsOldestFirst: ['old'],
                messagesById: {
                    old: {
                        id: 'old',
                        kind: 'agent-text',
                        seq: 110,
                        localId: null,
                        createdAt: 1,
                        text: 'older visible message',
                    },
                },
            },
        };
        const session = {
            id: 's1',
            seq: 742,
            lastViewedSessionSeq: 741,
            latestTurnStatus: 'completed' as const,
            metadata: null,
        };

        expect(deriveSessionReadState(session)).toBe('unread');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-read',
            visible: true,
            targetState: 'read',
        });
    });

    it('falls back to legacy readStateV1 when the top-level cursor is missing', () => {
        const session = {
            seq: 3,
            lastViewedSessionSeq: null,
            latestTurnStatus: 'completed' as const,
            metadata: {
                path: '/repo',
                host: 'localhost',
                readStateV1: { v: 1 as const, sessionSeq: 3, pendingActivityAt: 0, updatedAt: 1 },
            },
        };

        expect(deriveSessionReadState(session)).toBe('read');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-unread',
            visible: true,
            targetState: 'unread',
        });
    });

    it('reads layout-v1 private cursor state only from the owner compatibility view', () => {
        const session = {
            seq: 3,
            lastViewedSessionSeq: null,
            latestTurnStatus: 'completed' as const,
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                readStateV1: { v: 1 as const, sessionSeq: 0, pendingActivityAt: 0, updatedAt: 1 },
            },
            ownerMetadataView: {
                readStateV1: { v: 1 as const, sessionSeq: 3, pendingActivityAt: 0, updatedAt: 2 },
            },
        };

        expect(deriveSessionReadState(session)).toBe('read');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-unread',
            visible: true,
            targetState: 'unread',
        });
    });

    it('does not use injected layout-v1 shared cursor or direct-session attention state', () => {
        const session = {
            seq: 3,
            lastViewedSessionSeq: null,
            latestTurnStatus: 'completed' as const,
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                readStateV1: { v: 1 as const, sessionSeq: 3, pendingActivityAt: 0, updatedAt: 1 },
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'shared-machine',
                    remoteSessionId: 'shared-remote',
                },
                externalSessionAttentionV1: {
                    v: 1,
                    observedProgressToken: '1:message',
                    viewedProgressToken: '1:message',
                },
            },
            ownerMetadataView: null,
        };

        expect(deriveSessionReadState(session)).toBe('unread');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-read',
            visible: true,
            targetState: 'read',
        });
    });

    it('uses direct-session attention before cursor state', () => {
        const session = {
            seq: 0,
            lastViewedSessionSeq: 0,
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'codexHome', home: 'user' },
                },
                externalSessionAttentionV1: {
                    v: 1,
                    observedProgressToken: '2:message',
                    viewedProgressToken: '1:message',
                },
            },
        };

        expect(deriveSessionReadState(session)).toBe('unread');
        expect(resolveSessionReadStateAction(session)).toEqual({
            kind: 'mark-read',
            visible: true,
            targetState: 'read',
        });
    });
});
