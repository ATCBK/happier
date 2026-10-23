import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession, preserveSessionListRenderableStaleFields } from '@/sync/domains/session/listing/sessionListRenderable';
import { buildSessionFromListRenderable } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { buildNewSessionFromSocketUpdate, buildUpdatedSessionProjectionFromSocketUpdate, buildUpdatedSessionListRenderablePatchFromSocketUpdate } from './syncSessions';

describe('private viewer projection through synchronized Session rows', () => {
    it('uses the initialized private viewer when a new Session arrives', async () => {
        const viewer = {
            latestFailureSeq: null,
            readState: { state: 'tracking' as const, lastViewedSessionSeq: 0, unreadSince: null },
            relevance: { relevant: true, reasons: ['owned_by_me' as const] },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' as const },
            follow: { follows: false, notificationLevel: null },
            notification: { level: 'important' as const, source: 'owner' as const },
        };
        const updateBody = { t: 'new-session' as const, id: 'new-owner-session', metadata: JSON.stringify({ path: '/repo', host: 'test' }), encryptionMode: 'plain', viewer };
        const session = await buildNewSessionFromSocketUpdate({ updateBody, updateSeq: 0, updateCreatedAt: 1, encryption: null });
        expect(session?.viewer).toEqual(viewer);
        expect(session && buildSessionListRenderableFromSession(session).viewer).toEqual(viewer);
    });

    it('applies a private viewer-only socket change without a transcript revision and carries it through list projection', async () => {
        const viewer = {
            latestFailureSeq: null,
            readState: { state: 'not_started' as const },
            relevance: { relevant: true, reasons: ['responsible_for_me' as const] },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' as const },
            follow: { follows: false, notificationLevel: 'none' as const },
            notification: { level: 'none' as const, source: 'preference' as const },
        };
        const session = createSessionFixture({ seq: 8, lastViewedSessionSeq: 0, latestTurnStatus: 'completed' });
        const updated = buildUpdatedSessionProjectionFromSocketUpdate({
            session, updateBody: { viewer }, updateSeq: 8, updateCreatedAt: session.updatedAt,
        });
        const stale = buildSessionListRenderableFromSession(session);
        const lightweightPatch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
            renderable: stale, updateBody: { viewer }, updateSeq: 8,
            updateCreatedAt: session.updatedAt, sessionEncryption: null,
        });
        expect(lightweightPatch.viewer).toEqual(viewer);
        expect(lightweightPatch.hasUnreadMessages).toBe(false);
        expect(updated.viewer).toEqual(viewer);
        const renderable = buildSessionListRenderableFromSession(updated);
        expect(renderable.viewer).toEqual(viewer);
        expect(renderable.hasUnreadMessages).toBe(false);
        expect(buildSessionFromListRenderable(renderable).viewer).toEqual(viewer);
        expect(preserveSessionListRenderableStaleFields({ ...stale, hasUnreadMessages: true }, renderable).hasUnreadMessages).toBe(false);
        expect(buildSessionListRenderableFromSession({ ...updated, viewer: { ...viewer, relevance: { relevant: false, reasons: [] } } }, renderable).viewer?.relevance.relevant).toBe(false);
    });
});
