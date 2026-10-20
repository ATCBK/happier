import { afterEach, describe, expect, it } from 'vitest';
import {
    captureSessionDraftLaunchCurrentness,
    getSessionComposerDraftSnapshot,
    resetSessionDraftRepositoryForTests,
    writeNewSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { preserveCreatedSessionSuccessorDraft } from './newSessionDraftLifecycle';
import { clearAcceptedNewSessionAttachmentDrafts, clearAllNewSessionAttachmentDrafts, writeNewSessionAttachmentDrafts } from '../attachments/newSessionAttachmentDraftStore';
import { resolveNewSessionDraftAttachmentFlowId } from '../attachments/newSessionDraftAttachmentFlowId';
import { clearSessionAttachmentDrafts, readSessionAttachmentDrafts } from '@/components/sessions/attachments/sessionAttachmentDraftStore';
import { composerRefV1Key } from '@happier-dev/protocol/plugins/ui/composerRef';

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;
const draftId = '00000000-0000-4000-8000-000000000010';
const address = { kind: 'newSession', draftId } as const;
const attachmentScope = { ...scope, sessionId: 'created', occurrenceId: composerRefV1Key({ kind: 'session', sessionId: 'created' }) };
afterEach(() => { resetSessionDraftRepositoryForTests(); clearAllNewSessionAttachmentDrafts(); clearSessionAttachmentDrafts(attachmentScope); });

describe('embedded new-chat successor draft', () => {
    it('moves unsent file bytes into the existing session attachment owner even with no newer text', () => {
        writeNewSessionDraft({ scope, draftId, patch: { text: 'Submitted first turn' }, materializationIntent: 'seeded' });
        captureSessionDraftLaunchCurrentness({ scope, address, userAttemptId: 'attempt' });
        const attachment = { id: 'next-file', status: 'pending' as const,
            source: { kind: 'web' as const, file: new File(['next'], 'next.txt') } };
        const submitted = { ...attachment, id: 'submitted-file' };
        const flow = resolveNewSessionDraftAttachmentFlowId(draftId);
        writeNewSessionAttachmentDrafts(flow, [submitted, attachment]);
        clearAcceptedNewSessionAttachmentDrafts(flow, [submitted]);

        preserveCreatedSessionSuccessorDraft({ scope, draftId, launchUserAttemptId: 'attempt', sessionId: 'created' });

        const files = readSessionAttachmentDrafts(attachmentScope);
        expect(files).toHaveLength(1);
        expect(files[0].id).toBe('next-file');
        expect(files[0].source).toMatchObject({ kind: 'web', file: attachment.source.file });
    });
    it('moves only composer fields edited after Send into the created session document', () => {
        writeNewSessionDraft({ scope, draftId, patch: { text: 'Submitted first turn', attachments: [{ id: 'submitted' }] }, materializationIntent: 'seeded' });
        captureSessionDraftLaunchCurrentness({ scope, address, userAttemptId: 'attempt' });
        writeNewSessionDraft({ scope, draftId, patch: { text: 'What about next week?', mentions: [{ ref: 'next' }] }, materializationIntent: 'userEdit' });

        preserveCreatedSessionSuccessorDraft({ scope, draftId, launchUserAttemptId: 'attempt', sessionId: 'created' });

        const composer = getSessionComposerDraftSnapshot(scope, { kind: 'session', sessionId: 'created' })?.composer;
        expect(composer?.text.value).toBe('What about next week?');
        expect(composer?.mentions.value).toEqual([{ ref: 'next' }]);
        expect(composer?.attachments.value).toEqual([]);
        expect(getSessionComposerDraftSnapshot(scope, address)?.composer.text.value).toBe('What about next week?');
    });

    it('does not carry the accepted first turn into the successor composer', () => {
        writeNewSessionDraft({ scope, draftId, patch: { text: 'Submitted first turn' }, materializationIntent: 'seeded' });
        captureSessionDraftLaunchCurrentness({ scope, address, userAttemptId: 'attempt' });
        preserveCreatedSessionSuccessorDraft({ scope, draftId, launchUserAttemptId: 'attempt', sessionId: 'created' });
        expect(getSessionComposerDraftSnapshot(scope, { kind: 'session', sessionId: 'created' })).toBeNull();
    });
});
