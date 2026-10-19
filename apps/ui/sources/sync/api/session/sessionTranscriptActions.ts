import { fetchSessionMessagesPage, openSessionStoredContent, type SessionStoredContentContext } from '@happier-dev/sync-client';
import { SESSION_TRANSCRIPT_GET_MAX_LIMIT, type SessionTranscriptGetItem, type SessionTranscriptGetResult } from '@happier-dev/protocol/actions';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { projectTranscriptBodySemanticContent } from '@happier-dev/protocol/sessions/messages/transcriptBodySemanticProjection';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { runWithServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import { readSessionSnapshotForAuthority, SessionSnapshotReadError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { captureEncryptionGenerationCurrentness } from '@/sync/encryption/encryption';

type Input = Parameters<NonNullable<ActionExecutorDeps['sessionTranscriptGet']>>[0];
function failure(errorCode: string): SessionTranscriptGetResult { return { ok: false, errorCode, errorMessage: errorCode }; }
function refuse(code: string): never { throw Object.assign(new Error(code), { code }); }

/** The Action's exact-Home reader uses current grants and committed rows, independently of the loaded UI window. */
export async function readSessionTranscriptForAction(input: Input, scope: ServerAccountScope): Promise<SessionTranscriptGetResult> {
    if (input.projection) return failure('external_shareable_projection_unavailable');
    const cursor = input.cursor == null ? undefined : Number(input.cursor);
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0 || String(cursor) !== input.cursor)) return failure('invalid_cursor');
    try {
        return await runWithServerAccountScopeRequestGuard({ scope, signal: input.signal,
            staleError: () => Object.assign(new Error('Session transcript scope retired'), { code: 'action_account_scope_changed' }),
        }, async guard => runWithServerRequestAuthorityForServerAccountScope({ scope,
            activeRequest: async () => { throw new Error('Transcript requires captured Account authority'); },
        }, async authority => {
            const encryptionCurrentness = captureEncryptionGenerationCurrentness(authority.context.encryption, scope);
            const check = () => { guard.check(); if (!encryptionCurrentness.isCurrent()) refuse('action_account_scope_changed'); };
            const { session } = await readSessionSnapshotForAuthority({ authority, sessionId: input.sessionId,
                isCurrent: () => { check(); return true; } });
            check();
            if (session.access?.capabilities.readTranscript !== true) return failure('session_access_denied');
            if (session.encryptionMode !== 'plain' && session.encryptionMode !== 'e2ee') return failure('session_encryption_not_found');
            const encryption = authority.context.encryption?.getSessionEncryption(input.sessionId) ?? null;
            const contentContext: SessionStoredContentContext = session.encryptionMode === 'plain' ? { mode: 'plain' } : { mode: 'e2ee', encryption };
            if (contentContext.mode === 'e2ee' && !encryption) return failure('session_encryption_not_found');
            const direction = input.direction ?? 'before';
            const page = await fetchSessionMessagesPage({ sessionId: input.sessionId, scope: input.scope ?? 'main',
                ...(input.sidechainId ? { sidechainId: input.sidechainId } : {}),
                limit: input.limit ?? SESSION_TRANSCRIPT_GET_MAX_LIMIT,
                ...(cursor === undefined ? {} : direction === 'after' ? { afterSeq: cursor } : { beforeSeq: cursor }),
                signal: guard.signal, requestJson: async (path, signal) => {
                    check();
                    const response = await authority.request(path, { signal });
                    check();
                    if (!response.ok) refuse(response.status === 404 ? 'session_not_found'
                        : response.status === 401 || response.status === 403 ? 'session_access_denied' : 'session_transcript_unavailable');
                    const value: unknown = await response.json();
                    check();
                    return value;
                } });
            if (page.hasMore === undefined) return failure('session_transcript_unavailable');
            const items: SessionTranscriptGetItem[] = [];
            let payloadTruncations = 0;
            for (const row of page.messages) {
                const opened = await openSessionStoredContent(contentContext, row.content);
                check();
                if (opened.status !== 'ready') return failure('session_transcript_content_unavailable');
                const body = projectTranscriptBodySemanticContent(opened.value);
                if (!body) continue;
                const role = body.semanticRole;
                if (role === 'user' || role === 'assistant') { if (input.roles && !input.roles.includes(role)) continue; }
                else if (role === 'tool' ? input.includeTools !== true : role === 'reasoning' ? input.includeReasoning !== true : input.includeEvents !== true) continue;
                const maxChars = input.maxCharsPerMessage;
                const truncated = maxChars != null && ((body.text?.length ?? 0) > maxChars || (body.summary?.length ?? 0) > maxChars);
                let raw: unknown;
                let rawTruncated = false;
                if (input.includeRaw || input.includeStructuredPayload) {
                    raw = opened.value;
                    if (input.maxRawPayloadChars != null) {
                        const serialized = JSON.stringify(raw);
                        if (serialized.length > input.maxRawPayloadChars) {
                            raw = serialized.slice(0, input.maxRawPayloadChars); rawTruncated = true; payloadTruncations++;
                        }
                    }
                }
                items.push({ id: row.id, seq: row.seq, createdAt: row.createdAt, semanticRole: role, role, kind: body.kind,
                    ...(row.messageRole ? { storedMessageRole: row.messageRole } : {}),
                    ...(body.text !== undefined ? { text: maxChars == null ? body.text : body.text.slice(0, maxChars) } : {}),
                    ...(body.summary !== undefined ? { summary: maxChars == null ? body.summary : body.summary.slice(0, maxChars) } : {}),
                    ...(body.provider ? { provider: body.provider } : {}), ...(body.toolName ? { toolName: body.toolName } : {}),
                    ...(body.callId ? { callId: body.callId } : {}), ...(truncated ? { truncated: true } : {}),
                    ...(raw !== undefined ? { raw } : {}), ...(rawTruncated ? { rawTruncated: true } : {}),
                });
            }
            const nextSeq = direction === 'after' ? page.nextAfterSeq : page.nextBeforeSeq;
            if (page.hasMore && (nextSeq == null || nextSeq === cursor)) return failure('session_transcript_unavailable');
            check();
            return { ok: true, sessionId: input.sessionId, items, hasMore: page.hasMore,
                nextCursor: page.hasMore && nextSeq != null ? String(nextSeq) : null,
                diagnostics: { rawRowsScanned: page.messages.length, pagesFetched: 1, scanLimitReached: false, payloadTruncations } };
        }));
    } catch (error) {
        return failure(input.signal?.aborted ? 'canceled' : error instanceof SessionSnapshotReadError ? error.errorCode
            : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'session_transcript_unavailable');
    }
}
