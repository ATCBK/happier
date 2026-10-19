import axios from 'axios';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createRuntimeSessionClientDurableMutationOutbox } from './createRuntimeSessionClientDurableMutationOutbox';
import { loadSessionClientDurableMutationDeadLetters, loadSessionClientDurableMutationOutbox } from './sessionClientDurableMutationPersistence';

// HTTP is the only mocked boundary. Domain delivery, ordering, journal writes
// and restart recovery all execute their production implementations.
vi.mock('axios');

const originalHome = process.env.HAPPIER_HOME_DIR;
let homeDir: string;
beforeAll(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'happier-turnend-rejection-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    reloadConfiguration();
});
afterAll(async () => {
    if (originalHome === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = originalHome;
    reloadConfiguration();
    if (homeDir) await rm(homeDir, { recursive: true, force: true });
});

it('retains a typed terminal turn refusal, delivers unrelated queued work, and never replays the refusal', async () => {
    const sessionId = 'turnend-rejection';
    const deliveredIds: string[] = [];
    vi.mocked(axios.post).mockImplementation(async (_url, value) => {
        const mutation = value as { mutationId: string };
        deliveredIds.push(mutation.mutationId);
        if (mutation.mutationId === 'refused') throw { response: { status: 400 } };
        return { data: { success: true, receipt: { ...mutation, decision: 'applied', appliedAt: 300 } } };
    });
    const params = { token: 'fixture', sessionId, initiallyActive: false,
        getSocket: () => null, requestReconnect: () => undefined };
    const outbox = createRuntimeSessionClientDurableMutationOutbox(params);
    try {
        await outbox.awaitReady();
        await outbox.enqueueSessionTurnMutation({ v: 1, sessionId, action: 'complete',
            mutationId: 'refused', turnId: 'turn-1', observedAt: 100 });
        await outbox.enqueueSessionTurnMutation({ v: 1, sessionId, action: 'begin',
            mutationId: 'next', turnId: 'turn-2', observedAt: 200 });
        await outbox.activateDelivery();
        await outbox.flush('flush');
        expect(await loadSessionClientDurableMutationOutbox(sessionId)).toEqual([]);
        expect(await loadSessionClientDurableMutationDeadLetters(sessionId)).toEqual([
            expect.objectContaining({ mutationId: 'refused', reason: 'session_turn_mutation_rejected',
                attempts: 1, lastAttempt: expect.objectContaining({ reason: 'session_turn_mutation_rejected' }) }),
        ]);
    } finally {
        await outbox.close();
    }
    const reopened = createRuntimeSessionClientDurableMutationOutbox({ ...params, initiallyActive: true });
    try {
        await reopened.awaitReady();
        await reopened.flush('startup');
        expect(deliveredIds).toEqual(['refused', 'next']);
        expect(await loadSessionClientDurableMutationDeadLetters(sessionId)).toEqual([
            expect.objectContaining({ queuedMutation: expect.objectContaining({
                lastAttempt: expect.objectContaining({ reason: 'session_turn_mutation_rejected' }),
            }) }),
        ]);
    } finally {
        await reopened.close();
    }
});
