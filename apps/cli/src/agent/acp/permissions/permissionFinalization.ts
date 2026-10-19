import type { AcpPermissionHandler } from './acpPermissionHandler';

export async function abortPendingAcpPermissionRequests(
  permissionHandler: Pick<AcpPermissionHandler, 'abortPendingRequestsAndFlush'> | null | undefined,
  reason: string,
  onError?: (error: unknown) => void,
): Promise<void> {
  try {
    await permissionHandler?.abortPendingRequestsAndFlush?.(reason, { preserveQuestions: true });
  } catch (error) {
    onError?.(error);
  }
}
