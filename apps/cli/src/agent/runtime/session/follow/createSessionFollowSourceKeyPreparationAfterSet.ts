import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import type { SessionFollowSourceKeyPreparationResultV1 } from '@happier-dev/protocol';

import { resolveExternalActionServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import type { ExternalActionMachineRequestSigningKey } from '@/api/externalActionExecutionAuthorization';
import { normalizeServerHttpBaseUrl, resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { StoredCredentials } from '@/persistence';
import { openSessionDataEncryptionKey } from '@/api/client/openSessionDataEncryptionKey';
import { resolveSessionOwningMachineId } from '@/session/services/resolveSessionOwningMachine';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';

import { prepareSessionFollowSourceKey } from './prepareSessionFollowSourceKey';

export type SessionFollowSourceKeyPreparationAfterSet = (input: Readonly<{
  sourceSessionId: string;
  destinationSessionId: string;
  context: ActionExecutorContext;
  signal?: AbortSignal;
}>) => Promise<SessionFollowSourceKeyPreparationResultV1>;

/**
 * Binds the shared post-commit context-relation preparation leaf to one authenticated
 * Account/Home runtime. The public edge mutation remains committed when this
 * optional preparation cannot run; the family adapter projects that partial
 * completion as an explicit waiting result.
 */
export function createSessionFollowSourceKeyPreparationAfterSet(input: Readonly<{
  credentials: StoredCredentials;
  effectActionId?: 'session.follow.sources.set' | 'session.reports_to.set' | 'session.spawn_new';
  serverHttpBaseUrl?: string;
  serverIdentityId?: string;
  resolveServerFeaturesSnapshot?: () =>
    | CliServerFeaturesSnapshot
    | undefined
    | Promise<CliServerFeaturesSnapshot | undefined>;
  externalActionMachineRequestPrivateKey?: ExternalActionMachineRequestSigningKey;
  externalActionMachineInstallationId?: string;
}>): SessionFollowSourceKeyPreparationAfterSet {
  const serverHttpBaseUrl = normalizeServerHttpBaseUrl(input.serverHttpBaseUrl ?? resolveServerHttpBaseUrl());
  const effectActionId = input.effectActionId ?? 'session.follow.sources.set';

  return async ({ sourceSessionId, destinationSessionId, context, signal }) => await runWithServerHttpBaseUrl(
    serverHttpBaseUrl,
    async () => {
      // Active-Home Action composition enriches the invocation context from
      // the authenticated feature snapshot. Reuse that identity when the
      // constructor was created before the snapshot was available; fixed-Home
      // executors still retain their explicitly bound identity as authority.
      const homeServerIdentityId = input.serverIdentityId ?? context.serverIdentityId;
      const resolveAuthorizationHeaders = (request: Readonly<{
        method: 'GET' | 'POST';
        path: string;
        body?: unknown;
      }>): Readonly<Record<string, string>> | null => {
        const resolved = resolveExternalActionServerRequestHeaders({
          context,
          effectActionId,
          method: request.method,
          path: request.path,
          ...(request.body === undefined ? {} : { body: request.body }),
          daemonToken: input.credentials.token,
          ...(homeServerIdentityId ? { serverIdentityId: homeServerIdentityId } : {}),
          ...(input.externalActionMachineRequestPrivateKey
            ? { privateKey: input.externalActionMachineRequestPrivateKey }
            : {}),
          ...(input.externalActionMachineInstallationId
            ? { installationId: input.externalActionMachineInstallationId }
            : {}),
        });
        return resolved.ok ? resolved.headers : null;
      };

      const serverFeaturesSnapshot = await input.resolveServerFeaturesSnapshot?.();
      const [source, destination] = await Promise.all([
        resolveSessionTransportContext({
          credentials: input.credentials,
          idOrPrefix: sourceSessionId,
          resolveAuthorizationHeaders,
          ...(signal ? { signal } : {}),
          ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
        }),
        resolveSessionTransportContext({
          credentials: input.credentials,
          idOrPrefix: destinationSessionId,
          resolveAuthorizationHeaders,
          ...(signal ? { signal } : {}),
          ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
        }),
      ]);
      if (!source.ok) return { kind: 'waiting', reason: 'source_key_unavailable' };
      if (!destination.ok) return { kind: 'waiting', reason: 'runner_unreachable' };
      if (source.mode === 'plain') return { kind: 'not_needed' };
      // Cooperative Follow may transfer only the standalone Session DEK opened
      // from this Session's published envelope. The general transport resolver
      // deliberately retains released absent-envelope Account-key fallback for
      // ordinary Session reads; that compatibility key must never be exported
      // as source material to another runtime.
      const sourceDataEncryptionKey = openSessionDataEncryptionKey({
        credential: input.credentials,
        encryptedDataEncryptionKeyBase64: source.rawSession.dataEncryptionKey,
      });
      // An Account-backed persistent daemon already reads Session content
      // through its ordinary credentials. Only the exact Runner class needs
      // this standalone key; the Machine RPC owner decides that before it
      // constructs any private key-transfer request.
      try {
        if (!homeServerIdentityId) {
          return { kind: 'waiting', reason: 'runner_unreachable' };
        }

        const destinationMachine = resolveSessionOwningMachineId({
          credentials: input.credentials,
          rawSession: destination.rawSession,
        });
        if (!destinationMachine.ok || !destinationMachine.machineId) {
          return { kind: 'waiting', reason: 'runner_unreachable' };
        }

        const externalAction = context.externalActionExecutionAuthorization
          && input.externalActionMachineInstallationId
          && input.externalActionMachineRequestPrivateKey
          ? {
              context,
              effectActionId,
              installationId: input.externalActionMachineInstallationId,
              privateKey: input.externalActionMachineRequestPrivateKey,
            }
          : undefined;

        return await prepareSessionFollowSourceKey({
          credentials: input.credentials,
          homeServerIdentityId,
          machineId: destinationMachine.machineId,
          sourceSessionId,
          destinationSessionId,
          sourceDataEncryptionKey,
          serverUrl: serverHttpBaseUrl,
          ...(signal ? { signal } : {}),
          ...(externalAction ? { externalAction } : {}),
        });
      } finally {
        // The opened Session DEK is sender-owned scratch material for this one
        // preparation attempt: zero it once the post-open outcome is decided.
        // The preparer encodes the original bytes before its RPC and retains no
        // reference; caller-owned and receiver-owned key material is never
        // cleared here.
        sourceDataEncryptionKey?.fill(0);
      }
    },
  );
}
