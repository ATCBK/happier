import { COMPOSER_MEDIA_CONTENT_CAPABILITY_V1, ComposerContentHandleV1Schema, ComposerContentClaimantV1Schema, ComposerContentClaimRequestV1Schema, type ComposerContentClaimResponseV1 } from '@happier-dev/protocol/runtime/input/composerContentV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type {
  ComposerMediaStageClaimant,
  ComposerMediaStageStore,
} from '@/transfers/staging/composerMediaStageStore';

type ComposerMediaStageReleaseResponse =
  | Readonly<{ success: true }>
  | Readonly<{ success: false; error: string }>;

type ComposerMediaStageCapabilityResponse = Readonly<{
  success: true;
  available: true;
  capability: typeof COMPOSER_MEDIA_CONTENT_CAPABILITY_V1;
}>;

function readReleaseRequest(value: unknown): Readonly<{
  handle: ReturnType<typeof ComposerContentHandleV1Schema.parse>;
  claimant?: ComposerMediaStageClaimant;
}> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  if (!keys.every((key) => key === 'handle' || key === 'claimant') || !Object.hasOwn(record, 'handle')) return null;
  const handle = ComposerContentHandleV1Schema.safeParse(record.handle);
  if (!handle.success) return null;
  if (record.claimant === undefined) return { handle: handle.data };
  const claimant = ComposerContentClaimantV1Schema.safeParse(record.claimant);
  return claimant.success ? { handle: handle.data, claimant: claimant.data } : null;
}

/**
 * The transfer-stage owner alone releases completed Composer media. The caller
 * supplies the public opaque handle and, once attached, the host-private exact
 * Composer claimant. Target, contribution, and custody bindings are verified
 * by the store.
 */
export function registerComposerMediaStageLifecycleRpcHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{ store: ComposerMediaStageStore }>,
): void {
  rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CAPABILITY_GET_V1,
    async (raw: unknown): Promise<ComposerMediaStageCapabilityResponse> => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 0) {
        throw new TypeError('Invalid Composer media capability request');
      }
      return {
        success: true,
        available: true,
        capability: COMPOSER_MEDIA_CONTENT_CAPABILITY_V1,
      };
    },
  );

  rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CLAIM,
    async (raw: unknown): Promise<ComposerContentClaimResponseV1> => {
      const parsed = ComposerContentClaimRequestV1Schema.safeParse(raw);
      if (!parsed.success) return { success: false, error: 'Invalid Composer media claim request' };
      const request = parsed.data;

      try {
        const claimInput = {
          handle: request.handle,
          executionTarget: request.handle.executionTarget,
          owner: request.handle.owner,
        };
        if (request.submission) {
          const captured = await deps.store.forkClaimForSubmission({
            ...claimInput,
            sourceClaimant: request.claimant,
            destinationClaimant: { composer: request.submission.destinationComposerRef,
              attachmentInstanceId: request.claimant.attachmentInstanceId },
            messageLocalId: request.submission.messageLocalId,
          });
          if (captured.status === 'claimed' && captured.handle) {
            return { success: true, newlyAcquired: captured.newlyAcquired, handle: captured.handle };
          }
          if (captured.status === 'unavailable' && captured.reason === 'claimedElsewhere') {
            return { success: false, error: 'Composer media stage is claimed elsewhere', claimedElsewhere: true };
          }
          return { success: false, error: 'Composer media stage is unavailable' };
        }
        const claimed = await deps.store.claim({
          ...claimInput,
          claimant: request.claimant,
        });
        if (claimed.status === 'claimed') {
          return { success: true, newlyAcquired: claimed.newlyAcquired };
        }
        if (claimed.reason === 'claimedElsewhere') {
          return { success: false, error: 'Composer media stage is claimed elsewhere', claimedElsewhere: true };
        }
        return { success: false, error: 'Composer media stage is unavailable' };
      } catch {
        return { success: false, error: 'Composer media stage is unavailable' };
      }
    },
  );

  rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE,
    async (raw: unknown): Promise<ComposerMediaStageReleaseResponse> => {
      const request = readReleaseRequest(raw);
      if (!request) return { success: false, error: 'Invalid Composer media release request' };

      try {
        const released = await deps.store.release({
          handle: request.handle,
          executionTarget: request.handle.executionTarget,
          owner: request.handle.owner,
          ...(request.claimant ? { claimant: request.claimant } : {}),
        });
        if (released.status === 'released') return { success: true };
        if (released.reason === 'notFound' || released.reason === 'expired') return { success: true };
        return { success: false, error: 'Composer media stage is unavailable' };
      } catch {
        return { success: false, error: 'Composer media stage is unavailable' };
      }
    },
  );
}
