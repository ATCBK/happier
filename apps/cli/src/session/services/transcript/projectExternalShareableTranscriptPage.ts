import { projectOpenedExternalShareableTranscriptPageV1 } from '@happier-dev/protocol/sessions/messages/sessionExternalShareableTranscriptV1';
import type { RawTranscriptRow } from '@/session/replay/fetchEncryptedTranscriptMessages';

import { tryResolveDecryptedTranscriptPayload } from './transcriptHistoryRows';

type ProjectionInput = Parameters<typeof projectOpenedExternalShareableTranscriptPageV1>[0];
type EncryptedProjectionRow = RawTranscriptRow & Omit<ProjectionInput['rows'][number], 'content'>;
type EncryptionContext = Readonly<{ encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' }> | null;

/** CLI encryption adapter; semantic disclosure is owned by Protocol for every client. */
export function projectExternalShareableTranscriptPage(params: Omit<ProjectionInput, 'rows' | 'referencedUserRows'> & Readonly<{
  rows: readonly EncryptedProjectionRow[];
  referencedUserRows?: readonly EncryptedProjectionRow[];
  ctx: EncryptionContext;
}>): ReturnType<typeof projectOpenedExternalShareableTranscriptPageV1> {
  const { rows, referencedUserRows, ctx, ...projection } = params;
  const open = (row: EncryptedProjectionRow) => ({
    ...row, content: tryResolveDecryptedTranscriptPayload({ content: row.content, ctx }),
  });
  return projectOpenedExternalShareableTranscriptPageV1({
    ...projection,
    rows: rows.map(open),
    ...(referencedUserRows ? { referencedUserRows: referencedUserRows.map(open) } : {}),
  });
}
