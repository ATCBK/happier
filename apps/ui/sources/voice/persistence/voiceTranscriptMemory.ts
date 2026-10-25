import { z } from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { readLegacyVoiceTranscriptEpoch } from '@happier-dev/protocol/voice/settings/voiceSettingsPersistence';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createAccountKvJsonTransport } from '@/sync/ops/account/accountKvJsonTransport';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

// Forget applies across carriers in the captured Home/Account, as the 0.2 epoch did.
// The existing Account KV owner supplies encryption, currentness and revision CAS.
export const VOICE_TRANSCRIPT_MEMORY_KEY = 'voice:transcript-memory:v1';
const memorySchema = z.strictObject({ v: z.literal(1), epoch: z.number().check(z.int(), z.nonnegative()) });
const storedMemorySchema = createStoredReadSchema(memorySchema);

async function openMemory(account: LazyActionAccountContext, lifetime: ServerAccountScopeLifetime) {
    const { encryption } = await account.resolveAccountEncryption();
    const transport = createAccountKvJsonTransport({ credentials: account.credentials,
        key: VOICE_TRANSCRIPT_MEMORY_KEY, request: account.request, encryption,
        shouldContinue: () => lifetime.isCurrent() && account.accountLifetime.isCurrent() });
    const snapshot = await transport.read();
    const epoch = snapshot.version === -1
        ? readLegacyVoiceTranscriptEpoch(await account.readRawSettings())
        : storedMemorySchema.parse(snapshot.value).epoch;
    account.assertCurrent();
    if (!lifetime.isCurrent()) throw new Error('voice_agent_account_scope_retired');
    return { transport, snapshot, epoch };
}

async function withMemory<T>(lifetime: ServerAccountScopeLifetime, signal: AbortSignal | undefined,
    operation: (account: LazyActionAccountContext) => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    if (!lifetime.isCurrent()) throw new Error('voice_agent_account_scope_retired');
    const account = await captureLazyActionAccountContext(lifetime.scope.serverId, signal);
    try {
        if (!lifetime.isCurrent() || account.accountId !== lifetime.scope.accountId
            || !areServerProfileIdentifiersEquivalent(account.serverId, lifetime.scope.serverId)) {
            throw new Error('voice_agent_account_scope_retired');
        }
        return await operation(account);
    } finally { account.dispose(); }
}

export async function readPersistentVoiceTranscriptEpoch(params: Readonly<{
    accountLifetime?: ServerAccountScopeLifetime; signal?: AbortSignal;
}> = {}): Promise<number> {
    const lifetime = params.accountLifetime ?? captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('voice_agent_account_scope_unavailable');
    return await withMemory(lifetime, params.signal, async account => (await openMemory(account, lifetime)).epoch);
}

export async function advancePersistentVoiceTranscriptEpoch(lifetime: ServerAccountScopeLifetime): Promise<number> {
    return await withMemory(lifetime, undefined, async account => {
        const { transport, snapshot, epoch } = await openMemory(account, lifetime);
        let current = { version: snapshot.version, epoch };
        for (;;) {
            account.assertCurrent();
            if (!lifetime.isCurrent()) throw new Error('voice_agent_account_scope_retired');
            const next = memorySchema.parse({ v: 1, epoch: current.epoch + 1 });
            const result = await transport.compareAndSet(next, current.version);
            if (result.success) return next.epoch;
            // Reconcile only an actual CAS conflict, using the KV owner's winner.
            current = { version: result.version, epoch: result.version === -1 ? epoch
                : storedMemorySchema.parse(result.value).epoch };
        }
    });
}
