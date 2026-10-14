import { projectTranscriptBodySearchableText } from '@happier-dev/protocol/sessions/messages/transcriptBodySemanticProjection';

import type { HomeSearchDb, HomeSearchMessage } from './homeSearchDb';

export type HomeSearchCanonicalMessage = Readonly<{
    id: string;
    sessionId: string;
    seq: number;
    createdAtMs: number;
    updatedAtMs?: number;
    role?: string | null;
    content: unknown;
}>;

export type HomeSearchCanonicalPageReader = (input: Readonly<{ afterId?: string; limit: number }>) => Promise<Readonly<{
    messages: readonly HomeSearchCanonicalMessage[];
    nextAfterId?: string;
}>>;

function readSearchableText(content: unknown): string {
    if (!content || typeof content !== 'object') return '';
    const envelope = content as Record<string, unknown>;
    return envelope.t === 'plain' ? projectTranscriptBodySearchableText(envelope.v) : '';
}

function toIndexedMessage(message: HomeSearchCanonicalMessage): HomeSearchMessage {
    return {
        id: message.id,
        sessionId: message.sessionId,
        seq: message.seq,
        createdAtMs: message.createdAtMs,
        updatedAtMs: message.updatedAtMs,
        role: message.role,
        text: readSearchableText(message.content),
    };
}

type QueuedMutation =
    | Readonly<{ kind: 'upsert'; message: HomeSearchCanonicalMessage }>
    | Readonly<{ kind: 'remove-messages'; messageIds: readonly string[] }>
    | Readonly<{ kind: 'remove-session'; sessionId: string }>;

export type HomeSearchIndexer = Readonly<{
    ready(): boolean;
    whenReady(): Promise<void>;
    whenIdle(): Promise<void>;
    reconcile(): Promise<{ indexed: number; removed: number }>;
    notify(message: HomeSearchCanonicalMessage): void;
    removeMessages(messageIds: readonly string[]): void;
    removeSession(sessionId: string): void;
    start(): void;
    stop(): Promise<void>;
}>;

const RECONCILE_PAGE_SIZE = 250;

/** Serializes the full startup projection and live after-commit mutations over one FTS database.
 *  Pre-settlement catch-up is owned by the search lifecycle; deliveries before the lifecycle
 *  settles the startup projection are refused instead of buffered. */
export function createHomeSearchIndexer(params: Readonly<{
    db: HomeSearchDb;
    readCanonicalMessagesPage: HomeSearchCanonicalPageReader;
    onFailure?: (error: unknown) => void;
}>): HomeSearchIndexer {
    let started = false;
    let stopped = false;
    let isReady = false;
    let tail: Promise<void> = Promise.resolve();
    let initialReconcile: Promise<void> | null = null;

    const markFailed = (error: unknown) => {
        isReady = false;
        params.onFailure?.(error);
    };
    const applyMutation = (mutation: QueuedMutation) => {
        if (mutation.kind === 'remove-session') {
            params.db.removeSession(mutation.sessionId);
            return;
        }
        if (mutation.kind === 'remove-messages') {
            for (const messageId of mutation.messageIds) params.db.remove(messageId);
            return;
        }
        const indexed = toIndexedMessage(mutation.message);
        if (indexed.text.trim()) params.db.upsert(indexed);
        else params.db.remove(indexed.id);
    };
    const enqueue = (mutation: QueuedMutation) => {
        if (stopped) return;
        if (!started) {
            if (isReady) {
                queueMicrotask(() => {
                    try { applyMutation(mutation); } catch (error) { markFailed(error); }
                });
                return;
            }
            // Pre-settlement catch-up is owned by the search lifecycle's bounded dirty
            // projection; buffering events here retained unbounded message snapshots.
            throw new Error('Personal Home search mutations may be delivered only after the lifecycle settles the startup projection');
        }
        tail = tail.then(() => applyMutation(mutation)).catch(markFailed);
    };
    const runReconcile = async (): Promise<{ indexed: number; removed: number }> => {
        isReady = false;
        const previousCount = params.db.count();
        params.db.clear();
        let indexed = 0;
        let afterId: string | undefined;
        // The derived projection is rebuildable, so a stopping Home finishes only the page
        // already in flight and abandons the remaining canonical pages. Shutdown therefore
        // joins one page of SQLite work instead of the whole reconciliation.
        while (!stopped) {
            const page = await params.readCanonicalMessagesPage({ afterId, limit: RECONCILE_PAGE_SIZE });
            const indexedMessages: HomeSearchMessage[] = [];
            for (const row of page.messages) {
                const message = toIndexedMessage(row);
                if (message.text.trim()) {
                    indexedMessages.push(message);
                }
            }
            params.db.upsertMany(indexedMessages);
            indexed += indexedMessages.length;
            if (page.nextAfterId && page.nextAfterId === afterId) throw new Error('Canonical transcript pagination did not advance');
            afterId = page.nextAfterId;
            if (!afterId) break;
        }
        return { indexed, removed: Math.max(0, previousCount - indexed) };
    };

    return {
        ready: () => isReady,
        whenReady: () => initialReconcile ?? Promise.resolve(),
        whenIdle: () => tail,
        async reconcile() {
            const work = tail.then(runReconcile);
            tail = work.then(() => undefined).catch(markFailed);
            const result = await work;
            // A reconciliation abandoned at a page boundary by `stop()` leaves a partial
            // projection; it must never be advertised as a settled index.
            if (!stopped) isReady = true;
            return result;
        },
        notify(message) { enqueue({ kind: 'upsert', message }); },
        removeMessages(messageIds) {
            if (messageIds.length > 0) enqueue({ kind: 'remove-messages', messageIds: [...messageIds] });
        },
        removeSession(sessionId) { enqueue({ kind: 'remove-session', sessionId }); },
        start() {
            if (started || stopped) return;
            started = true;
            const work = tail.then(runReconcile).then(() => {
                if (!stopped) isReady = true;
            });
            // `whenReady()` is the caller-visible settlement boundary and must
            // retain reconciliation failure. The serialized mutation tail absorbs
            // it only after notifying the lifecycle, so automatic startup remains
            // non-crashing while an explicit repair can report a truthful failure.
            initialReconcile = work;
            tail = work.catch(markFailed);
        },
        async stop() {
            stopped = true;
            await tail.catch(() => undefined);
        },
    };
}

export function extractHomeSearchText(content: unknown): string {
    return readSearchableText(content);
}
