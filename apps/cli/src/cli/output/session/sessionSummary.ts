import type { StoredCredentials } from '@/persistence';
import { tryDecryptSessionPresentationMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawSessionListRow, RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents/session/state/metadataReaders';
import { readSystemSessionMetadataFromMetadata, projectSessionSummaryV1 } from '@happier-dev/protocol/sessions/control/contract';
import type { SessionSummary as ProtocolSessionSummary, AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';

export type SessionSummary = Readonly<ProtocolSessionSummary>;

export function summarizeSessionRow(params: Readonly<{
  credentials: StoredCredentials;
  accountEncryptionMode: AccountEncryptionCurrentnessResponse['mode'];
  row: RawSessionListRow;
}>): SessionSummary {
  const metadata = tryDecryptSessionPresentationMetadataView({
    credentials: params.credentials,
    accountEncryptionMode: params.accountEncryptionMode,
    rawSession: params.row,
  });
  const permissionMode = resolvePermissionIntentFromSessionMetadata(metadata)?.intent;
  const systemMetadata = metadata === null ? null : readSystemSessionMetadataFromMetadata({ metadata });
  return projectSessionSummaryV1({ row: params.row, metadata, permissionMode,
    ...(systemMetadata ? { systemPurpose: systemMetadata.key ?? null } : {}),
    encryption: params.credentials.encryption
      ? { type: params.credentials.encryption.type }
      : null,
  });
}

export function summarizeSessionRecord(params: Readonly<{
  credentials: StoredCredentials;
  accountEncryptionMode: AccountEncryptionCurrentnessResponse['mode'];
  session: RawSessionRecord;
}>): SessionSummary {
  // The /v2/sessions/:id response includes similar shape, so reuse the same summarization logic.
  return summarizeSessionRow({
    credentials: params.credentials,
    accountEncryptionMode: params.accountEncryptionMode,
    row: params.session,
  });
}
