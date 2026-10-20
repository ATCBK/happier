import { describe, expect, it } from 'vitest';
import type { Tx } from '@/storage/inTx';
import { buildSessionInputAdmissionReceipt, isSameSessionInputAdmissionIssuer } from '@/app/session/messages/sessionInputAdmission';
import { serializePendingMaterializedMessage } from './serializePendingMaterializedMessage';
import { isRetainedPendingContextForPublisherInTx } from './retainedPendingContext';

describe('retained file review notes', () => {
    it('uses the authenticated receipt that reaches native materialization to retain information, never an ordinary input', async () => {
        // Prisma is the external database boundary. No database is opened or written in this test.
        let machineAccountId = 'owner';
        const tx = { machine: { findUnique: async () => ({ accountId: machineAccountId }) } } as unknown as Tx;
        const publisher = { accountId: 'owner', sessionId: 'session', machineId: 'machine', committedFence: new Date(1) };
        const receipt = buildSessionInputAdmissionReceipt({ issuer: 'authenticatedMachine', nextTurnNote: 'file_review_note.v1' });
        const materialized = serializePendingMaterializedMessage({ id: 'note', seq: 1, localId: 'note', messageRole: 'user',
            content: { t: 'encrypted', c: 'opaque-note' }, createdAt: new Date(1), updatedAt: new Date(1),
            inputAdmissionReceipt: receipt }, { nativeAdmission: true });
        const row = { status: 'queued', targetExecutionRunId: null, deliveryState: 'delivering', deliveryBlockedReason: null,
            autonomousExchangeCause: null, inputAdmissionReceipt: materialized.inputAdmissionReceipt };
        await expect(isRetainedPendingContextForPublisherInTx(tx, row, publisher)).resolves.toBe(true);
        const ordinary = buildSessionInputAdmissionReceipt({ issuer: 'authenticatedMachine' });
        await expect(isRetainedPendingContextForPublisherInTx(tx, { ...row, inputAdmissionReceipt: ordinary }, publisher)).resolves.toBe(false);
        expect(isSameSessionInputAdmissionIssuer(receipt, ordinary)).toBe(false);
        await expect(isRetainedPendingContextForPublisherInTx(tx, { ...row, status: 'discarded' }, publisher)).resolves.toBe(false);
        machineAccountId = 'other';
        await expect(isRetainedPendingContextForPublisherInTx(tx, row, publisher)).resolves.toBe(false);
    });
});
