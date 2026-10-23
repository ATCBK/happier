import { describe, expect, it } from 'vitest';
import { readAttachmentDraftsForKey, writeAttachmentDraftsForKey, clearAttachmentDraftsForKey } from './attachmentDraftMemoryStore';
import { clearAcceptedNewSessionAttachmentDrafts, clearNewSessionAttachmentDrafts, writeNewSessionAttachmentDrafts } from '../new/attachments/newSessionAttachmentDraftStore';
import type { AttachmentDraft } from './attachmentDraftModel';

describe('shared attachment source custody', () => {
    it('preserves the immutable environment handle across memory snapshots', () => {
        const source = { kind: 'memory' as const, name: 'chosen.txt', bytes: new Uint8Array([1]) };
        writeAttachmentDraftsForKey('source-custody', [{ id: 'chosen', source, status: 'pending' }]);
        expect(readAttachmentDraftsForKey('source-custody')[0]?.source).toBe(source);
        clearAttachmentDraftsForKey('source-custody');
    });
    it('settles New Session custody without deleting a newer same-id source replacement', () => {
        const selected: AttachmentDraft = { id: 'selected', source: { kind: 'memory', name: 'chosen.txt', bytes: new Uint8Array([1]) }, status: 'pending' };
        const replacement: AttachmentDraft = { ...selected, source: { ...selected.source } };
        writeNewSessionAttachmentDrafts('same-source-flow', [replacement]);
        expect(clearAcceptedNewSessionAttachmentDrafts('same-source-flow', [selected])).toEqual([replacement]);
        clearNewSessionAttachmentDrafts('same-source-flow');
    });
});
