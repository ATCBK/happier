import { describe, expect, it } from 'vitest';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';

const access = (level: Parameters<typeof createSessionAccessFixture>[0], approve = level === 'owner') => createSessionAccessFixture(level, { approveRuntimePermissions: approve });

import { deriveTranscriptInteraction, deriveTranscriptInteractionFromSession } from './deriveTranscriptInteraction';

describe('deriveTranscriptInteraction', () => {
    it('fails unavailable access closed even when legacy fields imply ownership', () => {
        expect(deriveTranscriptInteractionFromSession({ access: null, active: true })).toMatchObject({
            canSendMessages: false, canApprovePermissions: false, canFork: false,
            canOpenFiles: false, canPreviewMedia: false,
        });
    });

    it('fails public file and media interactions closed while granting session-owned surfaces', () => {
        expect(deriveTranscriptInteraction({ kind: 'public' })).toMatchObject({
            canOpenFiles: false,
            canPreviewMedia: false,
        });
        expect(deriveTranscriptInteraction({
            kind: 'session',
            access: access('view', false),
        })).toMatchObject({
            canOpenFiles: true,
            canPreviewMedia: true,
        });
    });

    it('derives fork access from the transcript surface grant and fails closed for public/view surfaces', () => {
        expect(deriveTranscriptInteraction({ kind: 'public' }).canFork).toBe(false);
        expect(deriveTranscriptInteraction({ kind: 'session', access: access('view', false) }).canFork).toBe(false);
        expect(deriveTranscriptInteraction({ kind: 'session', access: access('edit', false) }).canFork).toBe(true);
        expect(deriveTranscriptInteraction({ kind: 'session', access: access('owner') }).canFork).toBe(true);
    });

    it('uses explicit owner capabilities for full interaction', () => {
        expect(deriveTranscriptInteraction({ kind: 'session', access: access('owner') })).toEqual({
            canSendMessages: true,
            canApprovePermissions: true,
            canApproveActions: true,
            canFork: true,
            canOpenFiles: true,
            canPreviewMedia: true,
            permissionDisabledReason: undefined,
        });
    });

    it('disables permission approvals when the session is inactive (owner)', () => {
        expect(
            deriveTranscriptInteraction({
                kind: 'session',
                access: access('owner'),
                isSessionActive: false,
            }),
        ).toEqual({
            canSendMessages: true,
            canApprovePermissions: false,
            canApproveActions: true,
            canFork: true,
            canOpenFiles: true,
            canPreviewMedia: true,
            permissionDisabledReason: 'inactive',
        });
    });

    it('treats view access as read-only', () => {
        expect(deriveTranscriptInteraction({ kind: 'session', access: access('view', false) })).toEqual({
            canSendMessages: false,
            canApprovePermissions: false,
            canApproveActions: false,
            canFork: false,
            canOpenFiles: true,
            canPreviewMedia: true,
            permissionDisabledReason: 'readOnly',
        });
    });

    it('treats inactive sessions as inactive even for view-only access', () => {
        expect(
            deriveTranscriptInteraction({
                kind: 'session',
                access: access('view', false),
                isSessionActive: false,
            }),
        ).toEqual({
            canSendMessages: false,
            canApprovePermissions: false,
            canApproveActions: false,
            canFork: false,
            canOpenFiles: true,
            canPreviewMedia: true,
            permissionDisabledReason: 'inactive',
        });
    });

    it('allows sending in edit/admin while permission approvals may be not granted', () => {
        expect(deriveTranscriptInteraction({ kind: 'session', access: access('edit', false) })).toEqual({
            canSendMessages: true,
            canApprovePermissions: false,
            canApproveActions: false,
            canFork: true,
            canOpenFiles: true,
            canPreviewMedia: true,
            permissionDisabledReason: 'notGranted',
        });
    });

    it('allows approvals when canApprovePermissions is true', () => {
        expect(deriveTranscriptInteraction({ kind: 'session', access: access('edit', true) })).toEqual({
            canSendMessages: true,
            canApprovePermissions: true,
            canApproveActions: true,
            canFork: true,
            canOpenFiles: true,
            canPreviewMedia: true,
            permissionDisabledReason: undefined,
        });
    });

    it('disables approvals when inactive even if approvals are granted', () => {
        expect(
            deriveTranscriptInteraction({
                kind: 'session',
                access: access('edit', true),
                isSessionActive: false,
            }),
        ).toEqual({
            canSendMessages: true,
            canApprovePermissions: false,
            canApproveActions: true,
            canFork: true,
            canOpenFiles: true,
            canPreviewMedia: true,
            permissionDisabledReason: 'inactive',
        });
    });

    it('supports public read-only transcripts', () => {
        expect(deriveTranscriptInteraction({ kind: 'public' })).toEqual({
            canSendMessages: false,
            canApprovePermissions: false,
            canApproveActions: false,
            canFork: false,
            canOpenFiles: false,
            canPreviewMedia: false,
            permissionDisabledReason: 'public',
        });
    });
});

describe('deriveTranscriptInteractionFromSession', () => {
    it('treats session.active as the source of truth (even if presence is stale)', () => {
        expect(
            deriveTranscriptInteractionFromSession({
                access: access('owner'),
                active: false,
                presence: 'online',
            }),
        ).toEqual({
            canSendMessages: true,
            canApprovePermissions: false,
            canApproveActions: true,
            canFork: true,
            canOpenFiles: true,
            canPreviewMedia: true,
            permissionDisabledReason: 'inactive',
        });
    });

    it('treats missing session.active as inactive for permission approvals (avoids presence drift)', () => {
        expect(
            deriveTranscriptInteractionFromSession({
                access: access('owner'),
                active: undefined,
                presence: 'online',
            }),
        ).toEqual({
            canSendMessages: true,
            canApprovePermissions: false,
            canApproveActions: true,
            canFork: true,
            canOpenFiles: true,
            canPreviewMedia: true,
            permissionDisabledReason: 'inactive',
        });
    });
});
