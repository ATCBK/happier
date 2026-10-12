import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { SessionSurfaceItemV1Schema } from '@happier-dev/protocol/sessions/board/item';
import type { SessionBoardItemUpsertInputV1 } from '@happier-dev/protocol/sessions/board/actions';
import { describe, expect, it } from 'vitest';

import { isSessionBoardUpsertIntentCommitted } from './sessionBoardUpsertRecovery';

const beforeRevision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const afterRevision = 'ssr1.AAAACHN5c3JlY18yAAAAAg';

const items = [
    SessionSurfaceItemV1Schema.parse({
        v: 1, title: 'Visual', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
        source: { kind: 'hostedHtml', source: artifactHtmlBundleFromBodyV1('<main>saved</main>') },
    }),
    SessionSurfaceItemV1Schema.parse({
        v: 1, title: 'Note', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
        source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'saved' } } },
    }),
];

describe('Session Board upsert acknowledgement-loss reconciliation', () => {
    it.each(items)('recognizes canonical creation destination stamping for $source.kind', (item) => {
        for (const destination of ['board', 'both', 'transcript'] as const) {
            const intent: SessionBoardItemUpsertInputV1 = {
                itemId: 'item-1', expectedItemRevision: null, item, destination,
                ...(destination !== 'transcript' ? { placement: { tabId: 'overview', tabTitle: 'Overview', width: 'medium' as const } } : {}),
            };
            expect(isSessionBoardUpsertIntentCommitted({ intent, revision: 'rev-1', item: { ...item, destination } })).toBe(true);
            const mismatched = destination === 'board' ? 'both' : 'board';
            expect(isSessionBoardUpsertIntentCommitted({ intent, revision: 'rev-1', item: { ...item, destination: mismatched } })).toBe(false);
        }
        const intent: SessionBoardItemUpsertInputV1 = { itemId: 'item-1', expectedItemRevision: null, item };
        expect(isSessionBoardUpsertIntentCommitted({ intent, revision: 'rev-1', item: { ...item, destination: 'transcript' } })).toBe(true);
        expect(isSessionBoardUpsertIntentCommitted({ intent, revision: 'rev-1', item: { ...item, destination: 'board' } })).toBe(false);
        const boardIntent: SessionBoardItemUpsertInputV1 = {
            ...intent, placement: { tabId: 'overview', tabTitle: 'Overview', width: 'medium' },
        };
        expect(isSessionBoardUpsertIntentCommitted({ intent: boardIntent, revision: afterRevision, item })).toBe(true);
        const bothIntent: SessionBoardItemUpsertInputV1 = {
            ...boardIntent, destination: 'both', item: { ...item, destination: 'transcript' },
        };
        expect(isSessionBoardUpsertIntentCommitted({ intent: bothIntent, revision: afterRevision, item: { ...item, destination: 'both' } })).toBe(true);
        expect(isSessionBoardUpsertIntentCommitted({ intent: bothIntent, revision: afterRevision, item: { ...item, destination: 'transcript' } })).toBe(false);
    });

    it.each(items)('retains update destination without inventing a Board default for $source.kind', (item) => {
        for (const destination of ['board', 'both', 'transcript'] as const) {
            const intent: SessionBoardItemUpsertInputV1 = { itemId: 'item-1', expectedItemRevision: beforeRevision, item };
            expect(isSessionBoardUpsertIntentCommitted({ intent, revision: afterRevision, item: { ...item, destination } })).toBe(true);
            expect(isSessionBoardUpsertIntentCommitted({ intent, revision: beforeRevision, item: { ...item, destination } })).toBe(false);
        }
        const intent: SessionBoardItemUpsertInputV1 = { itemId: 'item-1', expectedItemRevision: beforeRevision, item: { ...item, destination: 'both' } };
        expect(isSessionBoardUpsertIntentCommitted({ intent, revision: afterRevision, item: { ...item, destination: 'board' } })).toBe(true);
        expect(isSessionBoardUpsertIntentCommitted({ intent, revision: afterRevision, item: { ...item, destination: 'both', title: 'Other content' } })).toBe(false);
    });

    it('refuses an invalid Action intent even when its item matches the observed row', () => {
        const item = { ...items[0], destination: 'both' as const };
        const intent: SessionBoardItemUpsertInputV1 = { itemId: '', expectedItemRevision: beforeRevision, item };
        expect(isSessionBoardUpsertIntentCommitted({ intent, revision: afterRevision, item })).toBe(false);
    });
});
