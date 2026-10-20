import { openSessionStoredContent, type SessionStoredContentContext } from '@happier-dev/sync-client';
import { buildSessionMessagesPath, SessionExternalShareableMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1, projectOpenedExternalShareableTranscriptPageV1 } from '@happier-dev/protocol/sessions/messages/sessionExternalShareableTranscriptV1';
import type { PluginUiSessionStateV1 } from '@happier-dev/protocol/plugins/ui';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureEncryptionGenerationCurrentness } from '@/sync/encryption/encryption';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { runWithServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import { readSessionSnapshotForAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';

type Activity = NonNullable<PluginUiSessionStateV1['latestActivity']>;

/** Read-only mounted projection: exact-Home access, mode, publication and turn settlement stay host-owned. */
export async function readSessionLatestExternalShareableActivity(input: Readonly<{
    scope: ServerAccountScope;
    sessionId: string;
    signal: AbortSignal;
    isCurrent(): boolean;
}>): Promise<Activity> {
    try {
        return await runWithServerAccountScopeRequestGuard<Activity>({ ...input,
            staleError: () => new Error('session_activity_retired'),
        }, async guard => runWithServerRequestAuthorityForServerAccountScope<Activity>({ scope: input.scope,
            activeRequest: async () => { throw new Error('Session activity requires captured Account authority'); },
        }, async authority => {
            const encryption = authority.context.encryption;
            const currentness = captureEncryptionGenerationCurrentness(encryption, input.scope);
            const check = () => {
                guard.check();
                if (!currentness.isCurrent()) throw new Error('session_activity_retired');
            };
            const { session } = await readSessionSnapshotForAuthority({ authority, sessionId: input.sessionId,
                isCurrent: () => { check(); return true; } });
            check();
            if (session.access?.capabilities.readTranscript !== true) return { kind: 'hidden' };
            const context: SessionStoredContentContext | null = session.encryptionMode === 'plain' ? { mode: 'plain' }
                : session.encryptionMode === 'e2ee' ? { mode: 'e2ee', encryption: encryption?.getSessionEncryption(input.sessionId) ?? null } : null;
            if (!context || (context.mode === 'e2ee' && !context.encryption)) return { kind: 'unavailable' };
            let beforeSeq: number | undefined;
            let blocked = false;
            for (;;) {
                check();
                const response = await authority.request(buildSessionMessagesPath({ sessionId: input.sessionId, scope: 'main',
                    projection: 'externalShareableV1', limit: EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1,
                    ...(beforeSeq === undefined ? {} : { beforeSeq }),
                }), { signal: guard.signal });
                check();
                if (!response.ok) return { kind: response.status === 403 || response.status === 404 ? 'hidden' : 'unavailable' };
                const page = SessionExternalShareableMessagesPageV1Schema.parse(await response.json());
                check();
                const snapshot = page.externalShareableSnapshot;
                if (!snapshot || page.hasMore === undefined) return { kind: 'unavailable' };
                const open = async (row: Readonly<{ content?: unknown }>) => {
                    // Opaque publication witnesses carry no content; they remain unprojectable.
                    if (row.content === undefined) return null;
                    const opened = await openSessionStoredContent(context, row.content);
                    check();
                    if (opened.status !== 'ready') throw new Error('session_activity_content_unavailable');
                    return opened.value;
                };
                const rows = await Promise.all(page.messages.map(async row => ({ ...row, content: await open(row) })));
                const referencedUserRows = await Promise.all((snapshot.referencedUserRows ?? []).map(async row => ({ ...row, content: await open(row) })));
                const projection = await projectOpenedExternalShareableTranscriptPageV1({ sessionId: input.sessionId,
                    rows, referencedUserRows, turns: snapshot.turns, cursorSeq: 0,
                    limit: EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1, upstreamHasMore: false,
                    publicationBlocked: page.publicationBlocked === true,
                    publicationBlockedFromSeq: snapshot.publicationBlockedFromSeq,
                    turnSettlementBlockedFromSeq: snapshot.turnSettlementBlockedFromSeq,
                });
                check();
                // A semantic byte/consumed-input budget may stop before this raw page ends.
                // Such a partial projection cannot establish which activity is latest.
                const barrier = Math.min(snapshot.publicationBlockedFromSeq ?? Infinity,
                    snapshot.turnSettlementBlockedFromSeq ?? Infinity);
                if (rows.some(row => row.seq < barrier && row.seq > projection.scannedThroughSeq)) return { kind: 'unavailable' };
                const latest = projection.items.at(-1);
                if (latest) {
                    const source = page.messages.find(row => row.id === latest.itemId && row.seq === latest.seq);
                    if (!source || !Number.isSafeInteger(source.createdAt) || source.createdAt < 0) return { kind: 'unavailable' };
                    return { kind: 'ready', text: latest.text, createdAt: source.createdAt };
                }
                blocked ||= page.publicationBlocked === true || snapshot.publicationBlockedFromSeq !== undefined
                    || snapshot.turnSettlementBlockedFromSeq !== undefined;
                const next = page.nextBeforeSeq;
                if (!page.hasMore) return { kind: blocked ? 'unavailable' : 'empty' };
                if (next == null || next <= 0 || (beforeSeq !== undefined && next >= beforeSeq)) return { kind: 'unavailable' };
                beforeSeq = next;
            }
        }));
    } catch {
        return { kind: 'unavailable' };
    }
}
