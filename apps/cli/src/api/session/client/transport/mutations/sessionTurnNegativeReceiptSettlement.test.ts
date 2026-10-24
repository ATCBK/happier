import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTurnMutationReceiptV1Schema } from '@happier-dev/protocol';
import { createDaemonSessionClientDurableMutationOutbox, type ExactDaemonSessionTurnEndMutationV1 } from './createDaemonSessionClientDurableMutationOutbox';
import { resetSessionClientDurableMutationOutboxStateForTests } from './createSessionClientDurableMutationOutbox';
import { resolveSessionClientDurableMutationJournalPaths } from './sessionClientDurableMutationPersistence';

const { configurationMock } = vi.hoisted(() => ({ configurationMock: {
    activeServerDir: '', apiServerUrl: 'http://server.example.test',
} }));
vi.mock('@/configuration', () => ({ configuration: configurationMock }));
// Only the HTTP boundary is replaced; receipt admission, retries and disk custody are real.
vi.mock('axios');

describe('exact turn negative receipt settlement', () => {
    beforeEach(async () => {
        configurationMock.activeServerDir = await mkdtemp(join(tmpdir(), 'happier-negative-turn-receipt-'));
        vi.mocked(axios.post).mockReset();
    });
    afterEach(async () => {
        vi.useRealTimers();
        await resetSessionClientDurableMutationOutboxStateForTests();
        await rm(configurationMock.activeServerDir, { recursive: true, force: true });
    });

    it.each(['missing-turn', 'stale-terminal', 'stale-in-progress', 'duplicate-mutation'] as const)(
        'settles a committed non-positive exact receipt without idle redelivery (%s)',
        async (decision) => {
            const mutation: ExactDaemonSessionTurnEndMutationV1 = {
                v: 1, sessionId: 'settled-negative', mutationId: 'daemon-exit-negative',
                action: 'end_session', turnId: 'turn-1', observedAt: 100,
            };
            vi.mocked(axios.post).mockResolvedValue({ status: 200, data: {
                success: true, applied: false,
                receipt: SessionTurnMutationReceiptV1Schema.parse({ ...mutation, decision, appliedAt: 200 }),
            } });
            const paths = resolveSessionClientDurableMutationJournalPaths({
                activeServerDir: configurationMock.activeServerDir,
                custody: 'daemon', sessionId: mutation.sessionId,
            });
            const createOutbox = () => createDaemonSessionClientDurableMutationOutbox({
                token: 'token', sessionId: mutation.sessionId, getSocket: () => null,
                requestReconnect: () => undefined,
            });
            const outbox = createOutbox();
            try {
                await outbox.awaitReady();
                vi.useFakeTimers();
                try {
                    await outbox.enqueueExactTurnEnd(mutation);
                    await outbox.flush('flush');
                    const settledDeliveries = vi.mocked(axios.post).mock.calls.length;
                    await vi.advanceTimersByTimeAsync(60_000);
                    await outbox.flush('connect');
                    expect(vi.mocked(axios.post).mock.calls.length - settledDeliveries).toBe(0);
                } finally { vi.useRealTimers(); }
                await expect(readFile(paths.queuePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
                const deadLetters = JSON.parse(await readFile(paths.deadLetterPath, 'utf8')) as { entries: unknown[] };
                expect(deadLetters.entries).toEqual([expect.objectContaining({
                    mutationId: mutation.mutationId, reason: 'session_turn_mutation_rejected',
                    diagnostic: expect.objectContaining({ classification: 'semantic_non_positive', decision }),
                    queuedMutation: expect.objectContaining({ payload: mutation }),
                })]);
            } finally { await outbox.close(); }
            const restarted = createOutbox();
            try {
                await restarted.awaitReady();
                await restarted.flush('startup');
                expect(axios.post).toHaveBeenCalledTimes(1);
            } finally { await restarted.close(); }
        },
    );
});
