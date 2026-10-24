import { persistSessionTranscriptMessage } from '@happier-dev/session-core/messages';
import { SessionMessageInvocationV1Schema, deriveSessionMessageInvocationLocalIdV1,
    readSessionMessageInvocationV1, type SessionMessageInvocationV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageInvocationV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { runWithServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import { readSessionSnapshotForAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { SessionMessageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { readStoredSessionMessage } from '@/sync/runtime/readStoredSessionContent';
import type { ServerAccountRequestAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import type { ServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import type { Encryption } from '@/sync/encryption/encryption';

type SourceTranscriptScope = Readonly<{ scope: ServerAccountScope; sessionId: string; isCurrent: () => boolean }>;
async function withSourceTranscript<TResult>(input: SourceTranscriptScope, operation: (context: Readonly<{
    authority: ServerAccountRequestAuthority; guard: ServerAccountScopeRequestGuard;
    mode: 'plain' | 'e2ee'; encryption: ReturnType<Encryption['getSessionEncryption']>;
}>) => Promise<TResult>): Promise<TResult> {
    return runWithServerAccountScopeRequestGuard({ ...input, staleError: () => new Error('Composer submission retired') }, async guard =>
        runWithServerRequestAuthorityForServerAccountScope({ scope: input.scope,
            activeRequest: async () => { throw new Error('Source transcript requires captured Account authority'); },
        }, async authority => {
            guard.check();
            const { session } = await readSessionSnapshotForAuthority({ authority, sessionId: input.sessionId,
                includeTurns: false, signal: guard.signal, isCurrent: guard.isCurrent });
            guard.check();
            const encryption = authority.context.encryption?.getSessionEncryption(input.sessionId) ?? null;
            if (session.encryptionMode !== 'plain' && !encryption) throw new Error('Source transcript key unavailable');
            return operation({ authority, guard, encryption, mode: session.encryptionMode === 'plain' ? 'plain' : 'e2ee' });
        }));
}

/** Rejoin the exact previous submission before retrying; never enumerate today's selector membership. */
export async function readSessionMessageInvocationForSubmit(input: SourceTranscriptScope & Readonly<{ localId: string }>):
    Promise<Readonly<{ invocation: SessionMessageInvocationV1; text: string }> | null> {
    return withSourceTranscript(input, async ({ authority, guard, mode, encryption }) => {
        const localId = deriveSessionMessageInvocationLocalIdV1(input.localId);
        const response = await authority.request(`/v2/sessions/${encodeURIComponent(input.sessionId)}/messages/by-local-id/${encodeURIComponent(localId)}`,
            { method: 'GET', signal: guard.signal }, { retry: 'none' });
        guard.check();
        if (response.status === 404) return null;
        if (!response.ok) throw new Error('Source invocation unavailable');
        const payload: unknown = await response.json();
        const row = payload && typeof payload === 'object' && 'message' in payload ? SessionMessageV1Schema.safeParse(payload.message) : null;
        if (!row?.success || row.data.localId !== localId) throw new Error('Source invocation identity unavailable');
        const opened = await readStoredSessionMessage({ message: row.data, sessionEncryptionMode: mode,
            ...(encryption ? { decryptMessage: (message: typeof row.data) => encryption.decryptMessage(message) } : {}) });
        guard.check();
        const raw = opened?.content;
        const event = raw?.role === 'agent' && raw.content.type === 'event' ? raw.content.data : null;
        const invocation = readSessionMessageInvocationV1(event);
        if (!invocation || invocation.localId !== input.localId || event?.type !== 'message') throw new Error('Source invocation content unavailable');
        return { invocation, text: event.message };
    });
}

/** A transcript edit, never a user input: the existing event role cannot enter Pending admission. */
export async function persistSessionMessageInvocation(input: Readonly<{
    scope: ServerAccountScope; sessionId: string; text: string; invocation: SessionMessageInvocationV1;
    isCurrent: () => boolean;
}>) {
    const invocation = SessionMessageInvocationV1Schema.parse(input.invocation);
    const localId = deriveSessionMessageInvocationLocalIdV1(invocation.localId);
    return withSourceTranscript(input, async ({ authority, guard, encryption, mode }) => {
            const persisted = await persistSessionTranscriptMessage({
                sessionEncryptionMode: mode,
                request: async (path, init) => {
                    guard.check();
                    const response = await authority.request(path, { ...init, signal: guard.signal }, { retry: 'none' });
                    guard.check();
                    return response;
                },
                ...(encryption ? { encryptRawRecord: async (raw: unknown) => {
                    guard.check(); const sealed = await encryption.encryptRaw(raw); guard.check(); return sealed;
                } } : {}),
            }, { sessionId: input.sessionId, localId, createdAt: Date.now(), messageRole: 'event',
                rawRecord: { role: 'agent', content: { type: 'event', id: localId, data: {
                    type: 'message', message: input.text, sessionMessageInvocationV1: invocation,
                } } } });
            guard.check();
            return persisted;
        });
}
