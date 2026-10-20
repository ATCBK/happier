import {
    FILE_REVIEW_NOTE_KIND,
    FileReviewNoteV1Schema,
    formatFileReviewNoteV1,
    type FileReviewNoteOperationV1,
} from '@happier-dev/protocol/messages/structured/fileReviewNoteV1';
import {
    sendSessionMessageWithServerScope,
    type ServerScopedSessionSendMessageResult,
} from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage';

/** The successful Undo owner calls once; Discard/Restore are emitted by their Action executor. */
export async function sendFileReviewNote(input: Readonly<{
    target: Readonly<{ sessionId: string; serverId?: string | null }>;
    action: FileReviewNoteOperationV1['action'];
    paths: readonly string[];
    changeCount?: number;
    turnId?: string;
    undoes?: 'discard' | 'restore';
}>): Promise<ServerScopedSessionSendMessageResult> {
    const { target, ...fields } = input;
    const parsed = FileReviewNoteV1Schema.safeParse(fields);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'Invalid file review note' };
    try {
        return await sendSessionMessageWithServerScope({
        ...target,
        message: formatFileReviewNoteV1(parsed.data),
        metaOverrides: { happier: { kind: FILE_REVIEW_NOTE_KIND, payload: parsed.data } },
        requestedAction: { v: 1, kind: 'enqueue' },
        hostAdmissionOrigin: 'file_review_note',
        });
    } catch {
        return { ok: false, errorCode: 'delivery_failed', error: 'File review note could not be sent' };
    }
}
