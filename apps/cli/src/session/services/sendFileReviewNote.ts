import {
  FILE_REVIEW_NOTE_KIND,
  FileReviewNoteV1Schema,
  formatFileReviewNoteV1,
  type FileReviewNoteV1,
} from '@happier-dev/protocol/messages/structured/fileReviewNoteV1';
import type { StoredCredentials } from '@/persistence';
import { resolveSessionMessageAdmissionTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import { sendSessionMessage } from './sendSessionMessage';

/** One informational original after a successful review Action; never resumes its receiver. */
export async function sendFileReviewNoteToSession(input: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  note: FileReviewNoteV1;
  signal?: AbortSignal;
}>): Promise<void> {
  const note = FileReviewNoteV1Schema.parse(input.note);
  const result = await sendSessionMessage({
    credentials: input.credentials,
    idOrPrefix: input.sessionId,
    message: formatFileReviewNoteV1(note),
    messageMeta: { happier: { kind: FILE_REVIEW_NOTE_KIND, payload: note } },
    informationDelivery: 'file_review_note',
    resumeInactiveSession: false,
    requestedAction: { v: 1, kind: 'enqueue' },
    wait: false,
    timeoutMs: resolveSessionMessageAdmissionTimeoutMs(),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!result.ok) throw new Error(`File review note delivery failed: ${result.code}`);
}
