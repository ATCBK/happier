import type { ConnectedServiceCredentialApi, ConnectedServiceAccountEncryptionMode } from '@/api/client/connectedServiceCredentialApi';

export type ConnectedServiceAccountMode = ConnectedServiceAccountEncryptionMode;

export async function resolveConnectedServiceAccountMode(
  api: Partial<Pick<ConnectedServiceCredentialApi, 'getAccountEncryptionMode'>>,
  options?: Readonly<{ refresh?: boolean; signal?: AbortSignal }>,
): Promise<ConnectedServiceAccountMode> {
  try {
    return await api.getAccountEncryptionMode?.(options) ?? 'unknown';
  } catch (error) {
    if (options?.signal) throw error;
    return 'unknown';
  }
}
