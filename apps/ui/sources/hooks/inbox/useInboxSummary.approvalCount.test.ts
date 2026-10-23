import { describe, expect, it, vi } from 'vitest';
import { ApprovalRequestV1Schema, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol';
import * as admission from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';

import { createAccountNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { storage } from '@/sync/domains/state/storageStore';
import type { StorageState } from '@/sync/store/types';
import { createOpenApprovalInboxCountSelector } from './useInboxSummary';

describe('createOpenApprovalInboxCountSelector', () => {
    it('reuses unchanged admissions across unrelated Artifact publications and strictly admits changed bodies', () => {
        const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 'session-a' }, requestedSurface: 'agent',
            actionId: 'session.list', actionArgs: {}, summary: 'List sessions' });
        const open: DecryptedArtifact = { id: 'approval', isDecrypted: true,
            header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request),
            title: 'List sessions', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        let state: StorageState = { ...storage.getInitialState(), isDataReady: true,
            profileScope: { serverId: 'home-a', accountId: 'account-a' }, artifacts: { [open.id]: open } };
        const select = createOpenApprovalInboxCountSelector();
        const admit = vi.spyOn(admission, 'approvalArtifactBodyMatchesHeaderV1');
        try {
            expect(select(state)).toBe(1);
            admit.mockClear();
            for (let tick = 0; tick < 20; tick++) {
                const note: DecryptedArtifact = { ...open, id: `note-${tick}`, header: { kind: 'prompt_doc.v2', title: 'Note' }, body: 'Note' };
                state = { ...state, artifacts: { ...state.artifacts, [note.id]: note } };
                expect(select(state)).toBe(1);
            }
            expect(admit).not.toHaveBeenCalled();
            state = { ...state, artifacts: { ...state.artifacts, [open.id]: { ...open, body: '{}', bodyVersion: 2 } } };
            expect(select(state)).toBe(0);
            expect(admit).toHaveBeenCalledTimes(1);
            state = { ...state, artifacts: { ...state.artifacts, [open.id]: { ...open, bodyVersion: 3 } } };
            expect(select(state)).toBe(1);
            expect(admit).toHaveBeenCalledTimes(2);
            const { [open.id]: removed, ...remaining } = state.artifacts;
            expect(removed).toBeDefined();
            expect(select({ ...state, artifacts: remaining })).toBe(0);
        } finally { admit.mockRestore(); }
    });

    it('reclassifies retained notices when the Account or data readiness changes', () => {
        const notice = createAccountNoticeArtifactFixture();
        const state = { ...storage.getInitialState(), isDataReady: true,
            profileScope: { serverId: 'home-a', accountId: 'account-a' }, artifacts: { [notice.id]: notice } };
        const select = createOpenApprovalInboxCountSelector();
        expect(select(state)).toBe(1);
        expect(select({ ...state, profileScope: { serverId: 'home-b', accountId: 'account-b' } })).toBe(0);
        expect(select(state)).toBe(1);
        expect(select({ ...state, isDataReady: false })).toBe(0);
        expect(select(state)).toBe(1);
    });
});
